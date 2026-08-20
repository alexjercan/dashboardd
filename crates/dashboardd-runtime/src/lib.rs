//! Reusable widget discovery, instance lifecycle, state, and HTTP runtime.

mod api;
mod configuration;
mod event;
mod health;
mod instance;
mod state;
mod widget;

use std::{path::PathBuf, sync::Arc};

use axum::Router;
use thiserror::Error;
use tokio::{sync::broadcast, task::JoinHandle};

use configuration::ThemeManager;
use instance::{InstanceError, InstanceManager};
use state::StateStore;
use widget::WidgetsManager;

/// Filesystem inputs required to start a runtime.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Directories containing prepared widget bundles.
    pub widget_roots: Vec<PathBuf>,
    /// Directory containing the built dashboard web application.
    pub web_dir: PathBuf,
    /// Durable package-wide widget state file.
    pub state_file: PathBuf,
    /// User configuration file watched for updates.
    pub config_file: PathBuf,
}

/// Failure to initialize a runtime.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// Widget bundle discovery failed.
    #[error("could not discover widgets: {0}")]
    WidgetDiscovery(#[source] std::io::Error),
    /// User configuration loading or validation failed.
    #[error("{0}")]
    Configuration(String),
    /// Persisted dashboard state restoration failed.
    #[error("failed to load dashboard state {}: {source}", path.display())]
    StateRestore {
        /// State file that could not be restored.
        path: PathBuf,
        /// Runtime validation or backend error.
        #[source]
        source: InstanceError,
    },
}

#[derive(Clone)]
struct AppState {
    widgets: WidgetsManager,
    instances: InstanceManager,
    themes: ThemeManager,
    web_dir: PathBuf,
    shutdown: broadcast::Sender<()>,
}

/// A cloneable request handle for graceful runtime shutdown.
#[derive(Clone)]
pub struct ShutdownHandle {
    sender: broadcast::Sender<()>,
}

impl ShutdownHandle {
    /// Notifies HTTP streams and background tasks to stop.
    pub fn request(&self) {
        let _ = self.sender.send(());
    }
}

/// A running in-process widget runtime.
pub struct Runtime {
    state: AppState,
    configuration_task: JoinHandle<()>,
}

impl Runtime {
    /// Discovers widgets, restores shared state, and starts configuration watching.
    pub async fn start(config: RuntimeConfig) -> Result<Self, RuntimeError> {
        let (shutdown, _) = broadcast::channel(1);
        let widgets = WidgetsManager::discover(&config.widget_roots)
            .map_err(RuntimeError::WidgetDiscovery)?;
        let user_configuration =
            configuration::load(&config.config_file).map_err(RuntimeError::Configuration)?;
        let theme = user_configuration
            .theme
            .effective()
            .map_err(RuntimeError::Configuration)?;
        let themes = ThemeManager::new(theme);
        let store = Arc::new(StateStore::new(config.state_file.clone()));
        let instances =
            InstanceManager::restore(store).map_err(|source| RuntimeError::StateRestore {
                path: config.state_file,
                source,
            })?;
        let state = AppState {
            widgets,
            instances,
            themes,
            web_dir: config.web_dir,
            shutdown,
        };
        let configuration_task = configuration::watch(
            config.config_file,
            state.themes.clone(),
            state.instances.clone(),
            state.shutdown.subscribe(),
        );
        Ok(Self {
            state,
            configuration_task,
        })
    }

    /// Returns the number of discovered widget bundles.
    pub fn widget_count(&self) -> usize {
        self.state.widgets.len()
    }

    /// Builds the global runtime HTTP API and static-file router.
    pub fn router(&self) -> Router {
        api::build_router(self.state.clone())
    }

    /// Returns a handle used to request graceful runtime shutdown.
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        ShutdownHandle {
            sender: self.state.shutdown.clone(),
        }
    }

    /// Stops widget backends and configuration watching.
    pub async fn shutdown(self) {
        let _ = self.state.shutdown.send(());
        self.state.instances.shutdown_all().await;
        let _ = self.configuration_task.await;
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, process};

    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn facade_starts_serves_and_stops_an_empty_runtime() {
        let root = std::env::temp_dir().join(format!(
            "dashboardd-runtime-facade-{}-{}",
            process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "runtime test").unwrap();
        let runtime = Runtime::start(RuntimeConfig {
            widget_roots: Vec::new(),
            web_dir: root.clone(),
            state_file: root.join("state.json"),
            config_file: root.join("config.toml"),
        })
        .await
        .unwrap();

        assert_eq!(runtime.widget_count(), 0);
        let response = runtime
            .router()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);

        runtime.shutdown().await;
        fs::remove_dir_all(root).unwrap();
    }
}
