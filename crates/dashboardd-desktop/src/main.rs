mod audit;
mod service;

use std::{
    env,
    error::Error,
    ffi::OsString,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command as ProcessCommand, ExitCode},
    sync::Mutex,
};

use dashboardd_runtime::{Runtime, RuntimeConfig};
use service::{
    DesktopService, PreparedService, surface_initialize, surface_mutate_state, surface_restart,
    surface_send, surface_subscribe,
};
use tauri::{
    AppHandle, Manager, RunEvent,
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

const DEFAULT_WIDGET_PATH: &str = ".build/widgets";

struct RuntimeOwner(Mutex<Option<Runtime>>);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dashboardd-desktop: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    configure_webkit_renderer()?;
    let prepared = PreparedService::prepare()?;
    let runtime = tauri::async_runtime::block_on(Runtime::start(runtime_config()?))?;
    let service = DesktopService::new(&prepared, runtime.handle());
    let protocol_service = service.clone();
    let setup_service = service.clone();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("dashboardd-widget", move |context, request| {
            protocol_service.widget_protocol(context.webview_label(), request)
        })
        .invoke_handler(tauri::generate_handler![
            surface_subscribe,
            surface_initialize,
            surface_send,
            surface_restart,
            surface_mutate_state
        ])
        .setup(move |app| {
            app.manage(setup_service.clone());
            app.manage(RuntimeOwner(Mutex::new(Some(runtime))));
            setup_service.start(prepared, app.handle().clone())?;
            setup_service.forward_runtime_events();
            install_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            app.state::<DesktopService>().shutdown(app);
            if let Some(runtime) = app
                .state::<RuntimeOwner>()
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                tauri::async_runtime::block_on(runtime.shutdown());
            }
        }
        _ => {}
    });
    Ok(())
}

fn configure_webkit_renderer() -> Result<(), Box<dyn Error>> {
    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return Ok(());
    }
    // WebKitGTK otherwise produces blank windows when GBM allocation is unavailable.
    let executable = env::current_exe()?;
    let error = ProcessCommand::new(executable)
        .args(env::args_os().skip(1))
        .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        .exec();
    Err(error.into())
}

fn runtime_config() -> Result<RuntimeConfig, Box<dyn Error>> {
    Ok(RuntimeConfig {
        widget_roots: resolve_widget_roots(env::var_os("DASHBOARDD_WIDGET_PATH"))?,
        state_file: resolve_state_file()?,
        config_file: resolve_config_file()?,
    })
}

fn resolve_widget_roots(value: Option<OsString>) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let Some(value) = value else {
        return Ok(vec![PathBuf::from(DEFAULT_WIDGET_PATH)]);
    };
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let roots = env::split_paths(&value).collect::<Vec<_>>();
    if roots.iter().any(|root| root.as_os_str().is_empty()) {
        return Err("DASHBOARDD_WIDGET_PATH must not contain empty entries".into());
    }
    Ok(roots)
}

fn resolve_config_file() -> Result<PathBuf, Box<dyn Error>> {
    if let Some(path) = env::var_os("DASHBOARDD_CONFIG_FILE") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("dashboardd/config.toml"));
    }
    let home = env::var_os("HOME")
        .ok_or("HOME must be set when DASHBOARDD_CONFIG_FILE and XDG_CONFIG_HOME are unset")?;
    Ok(PathBuf::from(home).join(".config/dashboardd/config.toml"))
}

fn resolve_state_file() -> Result<PathBuf, Box<dyn Error>> {
    resolve_state_file_from(
        env::var_os("DASHBOARDD_DESKTOP_STATE_FILE").map(PathBuf::from),
        env::var_os("XDG_STATE_HOME").map(PathBuf::from),
        env::var_os("HOME").map(PathBuf::from),
    )
    .map_err(Into::into)
}

fn resolve_state_file_from(
    configured: Option<PathBuf>,
    xdg: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, &'static str> {
    if let Some(path) = configured {
        return Ok(path);
    }
    if let Some(path) = xdg {
        return Ok(path.join("dashboardd-desktop/runtime.json"));
    }
    home.map(|path| path.join(".local/state/dashboardd-desktop/runtime.json"))
        .ok_or("HOME must be set when DASHBOARDD_DESKTOP_STATE_FILE and XDG_STATE_HOME are unset")
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    TrayIconBuilder::with_id("dashboardd-desktop")
        .tooltip("dashboardd desktop")
        .icon(tray_icon())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.state::<DesktopService>().shutdown(app);
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

fn tray_icon() -> Image<'static> {
    const SIZE: u32 = 16;
    let mut pixels = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let active = (3..=12).contains(&x) && (3..=12).contains(&y);
            let color = if active {
                [0x66, 0xb7, 0xf0, 0xff]
            } else {
                [0x00, 0x00, 0x00, 0x00]
            };
            pixels.extend_from_slice(&color);
        }
    }
    Image::new_owned(pixels, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_state_is_separate_from_server_state() {
        assert_eq!(
            resolve_state_file_from(None, Some(PathBuf::from("/state")), None).unwrap(),
            PathBuf::from("/state/dashboardd-desktop/runtime.json")
        );
    }
}
