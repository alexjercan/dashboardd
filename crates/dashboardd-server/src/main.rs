//! The dashboard daemon entry point.

mod api;

use std::{
    env,
    error::Error,
    ffi::OsString,
    io,
    net::{IpAddr, SocketAddr, TcpListener},
    path::PathBuf,
};

use dashboardd_runtime::{Runtime, RuntimeConfig, ShutdownHandle};
use rand::seq::SliceRandom;
use tokio::net::TcpListener as TokioTcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

const DEFAULT_HOST: &str = "127.0.0.1";
const PORT_RANGE: std::ops::Range<u16> = 7000..8000;
const DEFAULT_WIDGET_PATH: &str = ".build/widgets";
const DEFAULT_WEB_DIR: &str = "web/dist";

#[derive(Debug)]
struct Config {
    host: IpAddr,
    port: Option<u16>,
    widget_roots: Vec<PathBuf>,
    web_dir: PathBuf,
    state_file: PathBuf,
    config_file: PathBuf,
}

impl Config {
    fn from_environment() -> Result<Self, Box<dyn Error>> {
        let host = env::var("DASHBOARDD_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_owned());
        let host = host.parse()?;
        let port = env::var("DASHBOARDD_PORT")
            .ok()
            .map(|value| value.parse())
            .transpose()?;

        if port == Some(0) {
            return Err("DASHBOARDD_PORT must be between 1 and 65535".into());
        }
        let widget_roots = resolve_widget_roots(env::var_os("DASHBOARDD_WIDGET_PATH"))?;
        let web_dir = env::var_os("DASHBOARDD_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_WEB_DIR));
        let state_file = resolve_state_file()?;
        let config_file = resolve_config_file()?;
        let config_file = if config_file.is_absolute() {
            config_file
        } else {
            env::current_dir()?.join(config_file)
        };

        Ok(Self {
            host,
            port,
            widget_roots,
            web_dir,
            state_file,
            config_file,
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = Config::from_environment()?;
    let runtime = Runtime::start(RuntimeConfig {
        widget_roots: config.widget_roots.clone(),
        state_file: config.state_file.clone(),
        config_file: config.config_file.clone(),
    })
    .await?;
    info!(
        count = runtime.widget_count(),
        roots = ?config.widget_roots,
        "discovered widgets"
    );

    let listener = bind_listener(&config)?;
    let address = listener.local_addr()?;
    let shutdown = runtime.shutdown_handle();
    let app = api::build_router(runtime.handle(), config.web_dir.clone(), shutdown.clone());

    info!(%address, docs = %format!("http://{address}/docs"), "dashboardd listening");
    axum::serve(TokioTcpListener::from_std(listener)?, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await?;
    runtime.shutdown().await;
    info!("dashboardd stopped");
    Ok(())
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
    resolve_config_file_from(
        env::var_os("DASHBOARDD_CONFIG_FILE").map(PathBuf::from),
        env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        env::var_os("HOME").map(PathBuf::from),
    )
    .map_err(Into::into)
}

fn resolve_config_file_from(
    configured: Option<PathBuf>,
    xdg: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, &'static str> {
    if let Some(path) = configured {
        return Ok(path);
    }
    if let Some(path) = xdg {
        return Ok(path.join("dashboardd/config.toml"));
    }
    let home =
        home.ok_or("HOME must be set when DASHBOARDD_CONFIG_FILE and XDG_CONFIG_HOME are unset")?;
    Ok(home.join(".config/dashboardd/config.toml"))
}

fn resolve_state_file() -> Result<PathBuf, Box<dyn Error>> {
    if let Some(path) = env::var_os("DASHBOARDD_STATE_FILE") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("dashboardd/runtime.json"));
    }
    let home = env::var_os("HOME")
        .ok_or("HOME must be set when DASHBOARDD_STATE_FILE and XDG_STATE_HOME are unset")?;
    Ok(PathBuf::from(home).join(".local/state/dashboardd/runtime.json"))
}

fn bind_listener(config: &Config) -> io::Result<TcpListener> {
    match config.port {
        Some(port) => bind_socket(config.host, port),
        None => {
            let mut ports: Vec<_> = PORT_RANGE.collect();
            ports.shuffle(&mut rand::rng());
            ports
                .into_iter()
                .find_map(|port| bind_socket(config.host, port).ok())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "no free port found in the range 7000-7999",
                    )
                })
        }
    }
}

fn bind_socket(host: IpAddr, port: u16) -> io::Result<TcpListener> {
    let listener = TcpListener::bind(SocketAddr::new(host, port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

async fn shutdown_signal(shutdown: ShutdownHandle) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("shutdown signal received");
            shutdown.request();
        }
        Err(error) => tracing::error!(%error, "failed to listen for Ctrl-C"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_uses_documented_precedence() {
        assert_eq!(
            resolve_config_file_from(
                Some("/override.toml".into()),
                Some("/xdg".into()),
                Some("/home".into()),
            )
            .unwrap(),
            PathBuf::from("/override.toml")
        );
        assert_eq!(
            resolve_config_file_from(None, Some("/xdg".into()), Some("/home".into())).unwrap(),
            PathBuf::from("/xdg/dashboardd/config.toml")
        );
        assert_eq!(
            resolve_config_file_from(None, None, Some("/home".into())).unwrap(),
            PathBuf::from("/home/.config/dashboardd/config.toml")
        );
        assert!(resolve_config_file_from(None, None, None).is_err());
    }

    #[test]
    fn widget_path_uses_platform_list_semantics() {
        assert_eq!(
            resolve_widget_roots(None).unwrap(),
            [PathBuf::from(DEFAULT_WIDGET_PATH)]
        );
        assert!(
            resolve_widget_roots(Some(OsString::new()))
                .unwrap()
                .is_empty()
        );
        let joined = env::join_paths(["first", "second"]).unwrap();
        assert_eq!(
            resolve_widget_roots(Some(joined)).unwrap(),
            [PathBuf::from("first"), PathBuf::from("second")]
        );
    }

    #[test]
    fn widget_path_rejects_empty_entries() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let value = OsString::from(format!("first{separator}{separator}second"));

        assert_eq!(
            resolve_widget_roots(Some(value)).unwrap_err().to_string(),
            "DASHBOARDD_WIDGET_PATH must not contain empty entries"
        );
    }
}
