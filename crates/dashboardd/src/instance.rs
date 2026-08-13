//! Running widget instances and backend process lifecycle.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use dashboard_protocol::{InstanceId, ServerToWidget, WidgetId, WidgetToServer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex, broadcast, mpsc},
    task::JoinHandle,
};
use utoipa::ToSchema;

use crate::{
    event::{DashboardError, DashboardEvent},
    state::{DashboardStateFile, PersistedInstance, Position, StateStore},
    widget::{WidgetConfig, WidgetsManager},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DashboardLayout {
    pub columns: u32,
}

impl Default for DashboardLayout {
    fn default() -> Self {
        Self { columns: 9 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InstanceLayout {
    pub column: u32,
    pub row: u32,
    pub width: u32,
    pub height: u32,
}

impl Default for InstanceLayout {
    fn default() -> Self {
        Self {
            column: 0,
            row: 0,
            width: 1,
            height: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Instance {
    pub id: InstanceId,
    pub widget_id: WidgetId,
    pub variant_id: String,
    pub layout: InstanceLayout,
}

#[derive(Clone)]
pub struct InstanceManager {
    inner: Arc<Inner>,
}

struct Inner {
    layout: DashboardLayout,
    instances: Mutex<HashMap<InstanceId, ManagedInstance>>,
    events: broadcast::Sender<DashboardEvent>,
    next_id: AtomicU64,
    store: Option<Arc<StateStore>>,
}

struct ManagedInstance {
    resource: Instance,
    backend: WidgetBackend,
}

struct WidgetBackend {
    instance_id: InstanceId,
    commands: mpsc::UnboundedSender<ServerToWidget>,
    task: Option<JoinHandle<()>>,
}

#[derive(Debug, Error)]
pub enum InstanceError {
    #[error("instance was not found")]
    UnknownInstance,
    #[error("widget variant was not found")]
    UnknownVariant,
    #[error("widget backend executable was not found")]
    BackendNotFound,
    #[error("widget backend is unavailable")]
    BackendUnavailable,
    #[error("layout must fit within the dashboard grid and have a positive size")]
    InvalidLayout,
    #[error("layout overlaps another widget instance")]
    LayoutOccupied,
    #[error("could not save dashboard composition")]
    PersistenceFailed,
    #[error("{0}")]
    InvalidState(String),
}

impl InstanceManager {
    pub fn new(layout: DashboardLayout) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                layout,
                instances: Mutex::new(HashMap::new()),
                events,
                next_id: AtomicU64::new(1),
                store: None,
            }),
        }
    }

    pub async fn restore(
        layout: DashboardLayout,
        widgets: WidgetsManager,
        store: Arc<StateStore>,
    ) -> Result<Self, InstanceError> {
        let saved = store.load().map_err(|error| {
            InstanceError::InvalidState(format!("could not read state: {error}"))
        })?;
        let (events, _) = broadcast::channel(256);
        let mut restored = Vec::new();
        let mut next_id = 1;
        if let Some(saved) = saved {
            let mut layouts = Vec::new();
            let mut ids = std::collections::HashSet::new();
            for persisted in saved.instances {
                if !ids.insert(persisted.id.clone()) {
                    return Err(InstanceError::InvalidState(format!(
                        "duplicate instance id {:?}",
                        persisted.id
                    )));
                }
                let config = widgets.get(&persisted.widget_id).ok_or_else(|| {
                    InstanceError::InvalidState(format!(
                        "instance {:?} references unknown widget {:?}",
                        persisted.id, persisted.widget_id
                    ))
                })?;
                let variant = config.variant(&persisted.variant_id).ok_or_else(|| {
                    InstanceError::InvalidState(format!(
                        "instance {:?} references unknown variant {:?}",
                        persisted.id, persisted.variant_id
                    ))
                })?;
                let instance_layout = InstanceLayout {
                    column: persisted.position.column,
                    row: persisted.position.row,
                    width: variant.width,
                    height: variant.height,
                };
                validate_layout(layout, &instance_layout, layouts.iter()).map_err(|error| {
                    InstanceError::InvalidState(format!(
                        "instance {:?} has invalid position: {error}",
                        persisted.id
                    ))
                })?;
                layouts.push(instance_layout.clone());
                next_id = next_id.max(sequence_after(&persisted.id));
                restored.push((
                    Instance {
                        id: persisted.id,
                        widget_id: persisted.widget_id,
                        variant_id: persisted.variant_id,
                        layout: instance_layout,
                    },
                    config,
                ));
            }
        }
        let instances = restored
            .into_iter()
            .map(|(resource, config)| {
                let backend = WidgetBackend::start(config, resource.id.clone(), events.clone());
                (resource.id.clone(), ManagedInstance { resource, backend })
            })
            .collect();
        Ok(Self {
            inner: Arc::new(Inner {
                layout,
                instances: Mutex::new(instances),
                events,
                next_id: AtomicU64::new(next_id),
                store: Some(store),
            }),
        })
    }

    pub fn layout(&self) -> DashboardLayout {
        self.inner.layout
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DashboardEvent> {
        self.inner.events.subscribe()
    }

    pub async fn list(&self) -> Vec<Instance> {
        let instances = self.inner.instances.lock().await;
        let mut resources: Vec<_> = instances
            .values()
            .map(|instance| instance.resource.clone())
            .collect();
        resources.sort_by(|left, right| left.id.cmp(&right.id));
        resources
    }

    pub async fn get(&self, instance_id: &str) -> Result<Instance, InstanceError> {
        self.inner
            .instances
            .lock()
            .await
            .get(instance_id)
            .map(|instance| instance.resource.clone())
            .ok_or(InstanceError::UnknownInstance)
    }

    pub async fn create(
        &self,
        config: Arc<WidgetConfig>,
        variant_id: String,
        column: u32,
        row: u32,
    ) -> Result<Instance, InstanceError> {
        if !config.backend.is_file() {
            tracing::warn!(
                widget_id = %config.descriptor.id,
                path = %config.backend.display(),
                "widget backend executable was not found"
            );
            return Err(InstanceError::BackendNotFound);
        }

        let widget_id = &config.descriptor.id;
        let variant = config
            .variant(&variant_id)
            .ok_or(InstanceError::UnknownVariant)?;
        let layout = InstanceLayout {
            column,
            row,
            width: variant.width,
            height: variant.height,
        };
        let mut instances = self.inner.instances.lock().await;
        validate_layout(
            self.inner.layout,
            &layout,
            instances.values().map(|instance| &instance.resource.layout),
        )?;

        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let resource = Instance {
            id: format!("{widget_id}-{sequence}"),
            widget_id: widget_id.clone(),
            variant_id,
            layout,
        };
        self.persist(
            instances
                .values()
                .map(|instance| &instance.resource)
                .chain(std::iter::once(&resource)),
        )?;
        tracing::info!(
            instance_id = %resource.id,
            widget_id = %resource.widget_id,
            "creating widget instance"
        );
        let backend = WidgetBackend::start(config, resource.id.clone(), self.inner.events.clone());
        instances.insert(
            resource.id.clone(),
            ManagedInstance {
                resource: resource.clone(),
                backend,
            },
        );
        drop(instances);

        let _ = self.inner.events.send(DashboardEvent::InstanceCreated {
            instance: resource.clone(),
        });
        Ok(resource)
    }

    pub async fn update(
        &self,
        instance_id: &str,
        column: u32,
        row: u32,
    ) -> Result<Instance, InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        if !instances.contains_key(instance_id) {
            return Err(InstanceError::UnknownInstance);
        }
        let current = &instances[instance_id].resource.layout;
        let layout = InstanceLayout {
            column,
            row,
            width: current.width,
            height: current.height,
        };
        validate_layout(
            self.inner.layout,
            &layout,
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != instance_id)
                .map(|(_, instance)| &instance.resource.layout),
        )?;
        let mut resource = instances[instance_id].resource.clone();
        resource.layout = layout;
        self.persist(
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != instance_id)
                .map(|(_, instance)| &instance.resource)
                .chain(std::iter::once(&resource)),
        )?;
        let instance = instances
            .get_mut(instance_id)
            .expect("instance existence is checked");
        instance.resource = resource;
        let resource = instance.resource.clone();
        drop(instances);

        tracing::info!(instance_id, ?resource.layout, "updated widget instance");
        let _ = self.inner.events.send(DashboardEvent::InstanceUpdated {
            instance: resource.clone(),
        });
        Ok(resource)
    }

    pub async fn swap(
        &self,
        source_id: &str,
        target_id: &str,
    ) -> Result<Vec<Instance>, InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        if source_id == target_id
            || !instances.contains_key(source_id)
            || !instances.contains_key(target_id)
        {
            return Err(InstanceError::UnknownInstance);
        }

        let source_layout = instances[source_id].resource.layout.clone();
        let target_layout = instances[target_id].resource.layout.clone();
        let mut source_next = source_layout.clone();
        source_next.column = target_layout.column;
        source_next.row = target_layout.row;
        let mut target_next = target_layout.clone();
        target_next.column = source_layout.column;
        target_next.row = source_layout.row;

        validate_layout(
            self.inner.layout,
            &source_next,
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != source_id && id.as_str() != target_id)
                .map(|(_, instance)| &instance.resource.layout),
        )?;
        validate_layout(
            self.inner.layout,
            &target_next,
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != source_id && id.as_str() != target_id)
                .map(|(_, instance)| &instance.resource.layout),
        )?;
        if layouts_overlap(&source_next, &target_next) {
            return Err(InstanceError::LayoutOccupied);
        }

        let mut proposed = instances
            .values()
            .map(|instance| instance.resource.clone())
            .collect::<Vec<_>>();
        for instance in &mut proposed {
            if instance.id == source_id {
                instance.layout = source_next.clone();
            } else if instance.id == target_id {
                instance.layout = target_next.clone();
            }
        }
        self.persist(proposed.iter())?;

        instances
            .get_mut(source_id)
            .expect("source existence is checked")
            .resource
            .layout = source_next;
        instances
            .get_mut(target_id)
            .expect("target existence is checked")
            .resource
            .layout = target_next;
        let updated = vec![
            instances[source_id].resource.clone(),
            instances[target_id].resource.clone(),
        ];
        drop(instances);

        for instance in &updated {
            let _ = self.inner.events.send(DashboardEvent::InstanceUpdated {
                instance: instance.clone(),
            });
        }
        Ok(updated)
    }

    pub async fn destroy(&self, instance_id: &str) -> Result<(), InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        if !instances.contains_key(instance_id) {
            return Err(InstanceError::UnknownInstance);
        }
        self.persist(
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != instance_id)
                .map(|(_, instance)| &instance.resource),
        )?;
        let instance = instances
            .remove(instance_id)
            .expect("instance existence is checked");
        drop(instances);

        tracing::info!(instance_id, "destroying widget instance");
        let _ = self.inner.events.send(DashboardEvent::InstanceDestroyed {
            instance_id: instance_id.into(),
        });
        instance.backend.shutdown().await;
        Ok(())
    }

    fn persist<'a>(
        &self,
        resources: impl Iterator<Item = &'a Instance>,
    ) -> Result<(), InstanceError> {
        let Some(store) = &self.inner.store else {
            return Ok(());
        };
        let mut instances = resources.map(PersistedInstance::from).collect::<Vec<_>>();
        instances.sort_by(|left, right| left.id.cmp(&right.id));
        store.save(&DashboardStateFile::new(instances)).map_err(|error| {
            tracing::error!(%error, path = %store.path().display(), "failed to persist dashboard composition");
            InstanceError::PersistenceFailed
        })
    }

    pub async fn send(&self, instance_id: &str, payload: Value) -> Result<(), InstanceError> {
        let instances = self.inner.instances.lock().await;
        let instance = instances
            .get(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;
        tracing::debug!(instance_id, "forwarding command to widget backend");
        instance
            .backend
            .send(ServerToWidget::Message {
                instance_id: instance_id.into(),
                payload,
            })
            .map_err(|_| InstanceError::BackendUnavailable)
    }

    pub async fn shutdown_all(&self) {
        let instances = {
            let mut guard = self.inner.instances.lock().await;
            guard
                .drain()
                .map(|(_, instance)| instance)
                .collect::<Vec<_>>()
        };

        tracing::info!(count = instances.len(), "shutting down widget instances");
        for instance in instances {
            instance.backend.shutdown().await;
        }
    }
}

impl From<&Instance> for PersistedInstance {
    fn from(instance: &Instance) -> Self {
        Self {
            id: instance.id.clone(),
            widget_id: instance.widget_id.clone(),
            variant_id: instance.variant_id.clone(),
            position: Position {
                column: instance.layout.column,
                row: instance.layout.row,
            },
        }
    }
}

fn sequence_after(instance_id: &str) -> u64 {
    instance_id
        .rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<u64>().ok())
        .and_then(|sequence| sequence.checked_add(1))
        .unwrap_or(1)
}

fn validate_layout<'a>(
    dashboard: DashboardLayout,
    layout: &InstanceLayout,
    mut occupied: impl Iterator<Item = &'a InstanceLayout>,
) -> Result<(), InstanceError> {
    if layout.width == 0
        || layout.height == 0
        || layout.width > dashboard.columns
        || layout.column >= dashboard.columns
        || layout.column + layout.width > dashboard.columns
    {
        return Err(InstanceError::InvalidLayout);
    }
    if occupied.any(|other| layouts_overlap(layout, other)) {
        return Err(InstanceError::LayoutOccupied);
    }
    Ok(())
}

fn layouts_overlap(left: &InstanceLayout, right: &InstanceLayout) -> bool {
    left.column < right.column.saturating_add(right.width)
        && left.column.saturating_add(left.width) > right.column
        && left.row < right.row.saturating_add(right.height)
        && left.row.saturating_add(left.height) > right.row
}

impl Default for InstanceManager {
    fn default() -> Self {
        Self::new(DashboardLayout::default())
    }
}

impl WidgetBackend {
    fn start(
        config: Arc<WidgetConfig>,
        instance_id: InstanceId,
        events: broadcast::Sender<DashboardEvent>,
    ) -> Self {
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let task_instance_id = instance_id.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = run_backend(&config, &task_instance_id, &events, commands_rx).await
            {
                tracing::error!(
                    %error,
                    instance_id = %task_instance_id,
                    widget_id = %config.descriptor.id,
                    "widget backend failed"
                );
                let _ = events.send(DashboardEvent::InstanceError {
                    instance_id: Some(task_instance_id),
                    error: DashboardError {
                        code: "backend_failed".into(),
                        message: error.to_string(),
                    },
                });
            }
        });

        Self {
            instance_id,
            commands: commands_tx,
            task: Some(task),
        }
    }

    fn send(&self, message: ServerToWidget) -> Result<(), ServerToWidget> {
        self.commands.send(message).map_err(|error| error.0)
    }

    async fn shutdown(mut self) {
        tracing::debug!(instance_id = %self.instance_id, "sending shutdown to widget backend");
        let _ = self.commands.send(ServerToWidget::Shutdown {});
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await {
                Ok(result) => {
                    if let Err(error) = result {
                        tracing::debug!(
                            %error,
                            instance_id = %self.instance_id,
                            "widget backend task did not join cleanly"
                        );
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        instance_id = %self.instance_id,
                        "widget backend shutdown timed out; terminating it"
                    );
                    task.abort();
                    let _ = task.await;
                }
            }
        }
    }
}

impl Drop for WidgetBackend {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn run_backend(
    config: &WidgetConfig,
    instance_id: &str,
    events: &broadcast::Sender<DashboardEvent>,
    mut commands: mpsc::UnboundedReceiver<ServerToWidget>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing::info!(
        instance_id,
        widget_id = %config.descriptor.id,
        path = %config.backend.display(),
        "starting widget backend"
    );
    let mut command = Command::new(&config.backend);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    tracing::debug!(instance_id, process_id = ?child.id(), "widget backend started");
    let mut stdin = child
        .stdin
        .take()
        .ok_or("widget backend stdin is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("widget backend stdout is unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    write_backend_message(
        &mut stdin,
        ServerToWidget::Initialize {
            instance_id: instance_id.into(),
            widget_id: config.descriptor.id.clone(),
        },
    )
    .await?;

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                let shutdown = matches!(command, ServerToWidget::Shutdown {});
                write_backend_message(&mut stdin, command).await?;
                if shutdown {
                    break;
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                handle_backend_message(config, instance_id, events, &line)?;
            }
        }
    }

    drop(stdin);
    let status = child.wait().await?;
    if !status.success() {
        return Err(format!("widget backend exited with {status}").into());
    }

    tracing::info!(instance_id, %status, "widget backend stopped");
    Ok(())
}

async fn write_backend_message(
    stdin: &mut ChildStdin,
    message: ServerToWidget,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let encoded = dashboard_protocol::serialize(message)?;
    stdin.write_all(encoded.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

fn handle_backend_message(
    config: &WidgetConfig,
    expected_instance_id: &str,
    events: &broadcast::Sender<DashboardEvent>,
    line: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match dashboard_protocol::parse::<WidgetToServer>(line)? {
        WidgetToServer::Ready { widget_id } if widget_id == config.descriptor.id => {
            tracing::info!(
                instance_id = expected_instance_id,
                %widget_id,
                "widget backend is ready"
            );
        }
        WidgetToServer::Update {
            instance_id,
            payload,
        } => {
            tracing::debug!(%instance_id, "received widget telemetry");
            let _ = events.send(DashboardEvent::WidgetUpdate {
                instance_id,
                payload,
            });
        }
        WidgetToServer::Error { instance_id, error } => {
            tracing::warn!(
                instance_id = ?instance_id,
                code = %error.code,
                message = %error.message,
                "widget backend reported an error"
            );
            let _ = events.send(DashboardEvent::InstanceError {
                instance_id,
                error: error.into(),
            });
        }
        WidgetToServer::Ready { widget_id } => {
            return Err(format!("backend announced unexpected widget id {widget_id}").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_manager_lists_no_instances() {
        let manager = InstanceManager::default();

        assert!(manager.list().await.is_empty());
        assert!(matches!(
            manager.get("missing").await,
            Err(InstanceError::UnknownInstance)
        ));
    }

    #[tokio::test]
    async fn swap_rejects_missing_instances() {
        let manager = InstanceManager::default();

        assert!(matches!(
            manager.swap("missing", "also-missing").await,
            Err(InstanceError::UnknownInstance)
        ));
    }

    #[test]
    fn layout_validation_rejects_invalid_bounds_and_collisions() {
        let occupied = InstanceLayout {
            column: 1,
            row: 1,
            width: 1,
            height: 1,
        };
        let valid = InstanceLayout {
            column: 2,
            row: 0,
            width: 1,
            height: 2,
        };
        let invalid = InstanceLayout {
            column: 2,
            row: 0,
            width: 2,
            height: 1,
        };
        let collision = InstanceLayout {
            column: 0,
            row: 1,
            width: 2,
            height: 1,
        };

        let dashboard = DashboardLayout { columns: 3 };
        assert!(validate_layout(dashboard, &valid, [&occupied].into_iter()).is_ok());
        assert!(matches!(
            validate_layout(dashboard, &invalid, std::iter::empty()),
            Err(InstanceError::InvalidLayout)
        ));
        assert!(matches!(
            validate_layout(dashboard, &collision, [&occupied].into_iter()),
            Err(InstanceError::LayoutOccupied)
        ));
    }
}
