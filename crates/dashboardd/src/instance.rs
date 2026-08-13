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
    widget::WidgetConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DashboardLayout {
    pub columns: u32,
}

impl Default for DashboardLayout {
    fn default() -> Self {
        Self { columns: 3 }
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
    #[error("widget backend executable was not found")]
    BackendNotFound,
    #[error("widget backend is unavailable")]
    BackendUnavailable,
    #[error("layout must fit within the dashboard grid and have a positive size")]
    InvalidLayout,
    #[error("layout overlaps another widget instance")]
    LayoutOccupied,
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
            }),
        }
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
        layout: InstanceLayout,
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
            layout,
        };
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
        layout: InstanceLayout,
    ) -> Result<Instance, InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        if !instances.contains_key(instance_id) {
            return Err(InstanceError::UnknownInstance);
        }
        validate_layout(
            self.inner.layout,
            &layout,
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != instance_id)
                .map(|(_, instance)| &instance.resource.layout),
        )?;
        let instance = instances
            .get_mut(instance_id)
            .expect("instance existence is checked");
        instance.resource.layout = layout;
        let resource = instance.resource.clone();
        drop(instances);

        tracing::info!(instance_id, ?resource.layout, "updated widget instance");
        let _ = self.inner.events.send(DashboardEvent::InstanceUpdated {
            instance: resource.clone(),
        });
        Ok(resource)
    }

    pub async fn destroy(&self, instance_id: &str) -> Result<(), InstanceError> {
        let instance = self
            .inner
            .instances
            .lock()
            .await
            .remove(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;

        tracing::info!(instance_id, "destroying widget instance");
        let _ = self.inner.events.send(DashboardEvent::InstanceDestroyed {
            instance_id: instance_id.into(),
        });
        instance.backend.shutdown().await;
        Ok(())
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
