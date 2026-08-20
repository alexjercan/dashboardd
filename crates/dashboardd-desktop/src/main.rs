mod audit;
mod service;

use std::process::ExitCode;

use service::{DesktopService, PreparedService};
use tauri::{
    AppHandle, Manager, RunEvent,
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dashboardd-desktop: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let prepared = PreparedService::prepare()?;
    let app = tauri::Builder::default()
        .setup(move |app| {
            let service = DesktopService::start(prepared, app.handle().clone())?;
            app.manage(service);
            install_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => app.state::<DesktopService>().shutdown(app),
        _ => {}
    });
    Ok(())
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
