//! The dashboard daemon entry point.

mod api;
mod configuration;
mod event;
mod health;
mod instance;
mod state;
mod widget;

use std::{
    env,
    error::Error,
    io,
    net::{IpAddr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::Arc,
};

use rand::seq::SliceRandom;
use tokio::{net::TcpListener as TokioTcpListener, sync::broadcast};
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::{
    configuration::ThemeManager,
    instance::{DashboardLayout, InstanceManager},
    state::StateStore,
    widget::WidgetsManager,
};

const DEFAULT_HOST: &str = "127.0.0.1";
const PORT_RANGE: std::ops::Range<u16> = 7000..8000;
const DEFAULT_WIDGETS_DIR: &str = ".build/widgets";

#[derive(Clone)]
struct AppState {
    widgets: WidgetsManager,
    instances: InstanceManager,
    themes: ThemeManager,
    shutdown: broadcast::Sender<()>,
}

#[derive(Debug)]
struct Config {
    host: IpAddr,
    port: Option<u16>,
    widgets_dir: PathBuf,
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
        let widgets_dir = env::var_os("DASHBOARDD_WIDGETS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_WIDGETS_DIR));
        let state_file = resolve_state_file()?;
        let config_file = configuration::resolve_path()?;
        let config_file = if config_file.is_absolute() {
            config_file
        } else {
            env::current_dir()?.join(config_file)
        };

        Ok(Self {
            host,
            port,
            widgets_dir,
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
    let (shutdown, _) = broadcast::channel(1);
    let widgets = WidgetsManager::discover(&config.widgets_dir)?;
    let user_configuration = configuration::load(&config.config_file)?;
    let layout = DashboardLayout::default();
    let themes = ThemeManager::new(user_configuration.theme.effective()?);
    let store = Arc::new(StateStore::new(config.state_file.clone()));
    let instances = InstanceManager::restore(
        layout,
        widgets.clone(),
        store.clone(),
        &user_configuration.dashboard.initial_widgets,
    )
    .await
    .map_err(|error| {
        format!(
            "failed to load dashboard state {}: {error}",
            store.path().display()
        )
    })?;
    let state = AppState {
        widgets,
        instances,
        themes,
        shutdown,
    };
    info!(
        count = state.widgets.len(),
        root = %config.widgets_dir.display(),
        "discovered widgets"
    );

    let listener = bind_listener(&config)?;
    let address = listener.local_addr()?;
    let app = api::build_router(state.clone());
    let configuration_task = configuration::watch(
        config.config_file,
        state.themes.clone(),
        state.instances.clone(),
        state.shutdown.subscribe(),
    );

    info!(%address, docs = %format!("http://{address}/docs"), "dashboardd listening");
    axum::serve(TokioTcpListener::from_std(listener)?, app)
        .with_graceful_shutdown(shutdown_signal(state.shutdown.clone()))
        .await?;
    state.instances.shutdown_all().await;
    let _ = configuration_task.await;

    info!("dashboardd stopped");
    Ok(())
}

fn resolve_state_file() -> Result<PathBuf, Box<dyn Error>> {
    if let Some(path) = env::var_os("DASHBOARDD_STATE_FILE") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("scufris/dashboard.json"));
    }
    let home = env::var_os("HOME")
        .ok_or("HOME must be set when DASHBOARDD_STATE_FILE and XDG_STATE_HOME are unset")?;
    Ok(PathBuf::from(home).join(".local/state/scufris/dashboard.json"))
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

async fn shutdown_signal(shutdown: broadcast::Sender<()>) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("shutdown signal received");
            let _ = shutdown.send(());
        }
        Err(error) => tracing::error!(%error, "failed to listen for Ctrl-C"),
    }
}
