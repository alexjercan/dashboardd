//! Reusable transport-free widget runtime.

mod configuration;
mod event;
mod health;
mod instance;
mod state;
mod widget;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use serde_json::Value;
use thiserror::Error;
use tokio::{sync::broadcast, task::JoinHandle};

use configuration::ThemeManager;
use instance::InstanceManager;
use state::StateStore;
use widget::WidgetsManager;

pub use configuration::{Theme, ThemeFonts};
pub use event::{RuntimeErrorData, RuntimeEvent};
pub use health::{HealthError, HealthStatus, InstanceHealth};
pub use instance::{CreateInstanceSpec, Instance, InstanceError, TypedInput};
pub use widget::{
    WidgetDescriptor, WidgetLinkPort, WidgetOption, WidgetOptionChoice, WidgetOptionKind,
    WidgetVariant,
};

/// Filesystem inputs required to start a runtime.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Directories containing prepared widget bundles.
    pub widget_roots: Vec<PathBuf>,
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
    /// Persisted runtime state restoration failed.
    #[error("failed to load runtime state {}: {source}", path.display())]
    StateRestore {
        /// State file that could not be restored.
        path: PathBuf,
        /// Runtime validation or backend error.
        #[source]
        source: InstanceError,
    },
}

/// A cloneable handle for direct runtime operations.
#[derive(Clone)]
pub struct RuntimeHandle {
    widgets: WidgetsManager,
    instances: InstanceManager,
    themes: ThemeManager,
}

/// A cloneable request handle for graceful runtime shutdown.
#[derive(Clone)]
pub struct ShutdownHandle {
    sender: broadcast::Sender<()>,
}

impl ShutdownHandle {
    /// Notifies transport hosts and background tasks to stop.
    pub fn request(&self) {
        let _ = self.sender.send(());
    }

    /// Subscribes a transport host to runtime shutdown requests.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.sender.subscribe()
    }
}

/// An owned in-process widget runtime.
pub struct Runtime {
    handle: RuntimeHandle,
    shutdown: broadcast::Sender<()>,
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
        let handle = RuntimeHandle {
            widgets,
            instances,
            themes,
        };
        let configuration_task = configuration::watch(
            config.config_file,
            handle.themes.clone(),
            handle.instances.clone(),
            shutdown.subscribe(),
        );
        Ok(Self {
            handle,
            shutdown,
            configuration_task,
        })
    }

    /// Returns a cloneable direct-operation handle.
    pub fn handle(&self) -> RuntimeHandle {
        self.handle.clone()
    }

    /// Returns the number of discovered widget bundles.
    pub fn widget_count(&self) -> usize {
        self.handle.widget_count()
    }

    /// Returns a handle used to request graceful runtime shutdown.
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        ShutdownHandle {
            sender: self.shutdown.clone(),
        }
    }

    /// Stops widget backends and configuration watching.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        self.handle.instances.shutdown_all().await;
        let _ = self.configuration_task.await;
    }
}

impl RuntimeHandle {
    /// Returns the number of installed widgets.
    pub fn widget_count(&self) -> usize {
        self.widgets.len()
    }

    /// Lists installed widget descriptors.
    pub fn widgets(&self) -> Vec<WidgetDescriptor> {
        self.widgets.list()
    }

    /// Returns one installed widget descriptor.
    pub fn widget(&self, widget_id: &str) -> Option<WidgetDescriptor> {
        self.widgets
            .get(widget_id)
            .map(|config| config.descriptor.clone())
    }

    /// Returns the validated frontend path for one widget variant.
    pub fn widget_frontend(
        &self,
        widget_id: &str,
        variant_id: &str,
    ) -> Result<PathBuf, InstanceError> {
        let config = self
            .widgets
            .get(widget_id)
            .ok_or(InstanceError::UnknownWidget)?;
        config
            .frontend(variant_id)
            .map(PathBuf::from)
            .ok_or(InstanceError::UnknownVariant)
    }

    /// Returns the current effective theme.
    pub fn theme(&self) -> Theme {
        self.themes.current()
    }

    /// Subscribes to runtime domain events.
    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.instances.subscribe()
    }

    /// Lists all memory-only runtime instances.
    pub async fn instances(&self) -> Vec<Instance> {
        self.instances.list().await
    }

    /// Creates one memory-only runtime instance.
    pub async fn create_instance(
        &self,
        widget_id: &str,
        spec: CreateInstanceSpec,
    ) -> Result<Instance, InstanceError> {
        let config = self
            .widgets
            .get(widget_id)
            .ok_or(InstanceError::UnknownWidget)?;
        self.instances.create(config, spec).await
    }

    /// Returns one runtime instance.
    pub async fn instance(&self, instance_id: &str) -> Result<Instance, InstanceError> {
        self.instances.get(instance_id).await
    }

    /// Deletes one runtime instance and stops its backend.
    pub async fn delete_instance(&self, instance_id: &str) -> Result<(), InstanceError> {
        self.instances.destroy(instance_id).await
    }

    /// Replaces the complete direct-input map for one instance.
    pub async fn set_instance_inputs(
        &self,
        instance_id: &str,
        inputs: BTreeMap<String, TypedInput>,
    ) -> Result<Instance, InstanceError> {
        self.instances.set_inputs(instance_id, inputs).await
    }

    /// Lists health for all runtime instances.
    pub async fn instance_health(&self) -> Vec<InstanceHealth> {
        self.instances.list_health().await
    }

    /// Returns health for one runtime instance.
    pub async fn health(&self, instance_id: &str) -> Result<InstanceHealth, InstanceError> {
        self.instances.health(instance_id).await
    }

    /// Restarts one runtime instance backend.
    pub async fn restart_instance(
        &self,
        instance_id: &str,
    ) -> Result<InstanceHealth, InstanceError> {
        self.instances.restart(instance_id).await
    }

    /// Sends one opaque command to a widget backend.
    pub async fn send_message(
        &self,
        instance_id: &str,
        payload: Value,
    ) -> Result<(), InstanceError> {
        self.instances.send(instance_id, payload).await
    }

    /// Returns package-wide shared state for one installed widget.
    pub fn widget_state(&self, widget_id: &str) -> Result<(u64, Value), InstanceError> {
        if self.widgets.get(widget_id).is_none() {
            return Err(InstanceError::UnknownWidget);
        }
        Ok(self.instances.get_widget_state(widget_id))
    }

    /// Applies one revision-checked package-wide shared-state update.
    pub async fn set_widget_state(
        &self,
        widget_id: &str,
        revision: u64,
        value: Value,
    ) -> Result<(u64, Value), InstanceError> {
        if self.widgets.get(widget_id).is_none() {
            return Err(InstanceError::UnknownWidget);
        }
        self.instances
            .set_widget_state(widget_id, revision, value)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, process};

    use super::*;

    #[tokio::test]
    async fn facade_starts_exposes_direct_operations_and_stops() {
        let root = std::env::temp_dir().join(format!(
            "dashboardd-runtime-facade-{}-{}",
            process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&root).unwrap();
        let runtime = Runtime::start(RuntimeConfig {
            widget_roots: Vec::new(),
            state_file: root.join("state.json"),
            config_file: root.join("config.toml"),
        })
        .await
        .unwrap();

        let handle = runtime.handle();
        assert_eq!(handle.widget_count(), 0);
        assert!(handle.widgets().is_empty());
        assert!(handle.instances().await.is_empty());
        assert!(matches!(
            handle.instance("missing").await,
            Err(InstanceError::UnknownInstance)
        ));

        runtime.shutdown().await;
        fs::remove_dir_all(root).unwrap();
    }
}
