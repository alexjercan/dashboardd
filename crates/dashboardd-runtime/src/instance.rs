//! Memory-only widget instances and backend process lifecycle.

use std::{
    collections::{BTreeMap, HashMap},
    process::Stdio,
    sync::{Arc, RwLock},
};

use dashboardd_widget_protocol::{InstanceId, ServerToWidget, WidgetId, WidgetToServer};
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
use uuid::Uuid;

use crate::{
    event::RuntimeEvent,
    health::{HealthTracker, InstanceHealth, PROBE_INTERVAL},
    state::{RuntimeStateFile, StateStore},
    widget::WidgetConfig,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Instance {
    pub id: InstanceId,
    pub widget_id: WidgetId,
    pub variant_id: String,
    pub options: BTreeMap<String, Value>,
    pub inputs: BTreeMap<String, TypedInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TypedInput {
    #[serde(rename = "type")]
    pub input_type: String,
    pub value: Value,
}

pub struct CreateInstanceSpec {
    pub variant_id: String,
    pub options: BTreeMap<String, Value>,
    pub inputs: BTreeMap<String, TypedInput>,
}

#[derive(Clone)]
pub struct InstanceManager {
    inner: Arc<Inner>,
}

struct Inner {
    instances: Mutex<HashMap<InstanceId, ManagedInstance>>,
    events: broadcast::Sender<RuntimeEvent>,
    store: Arc<StateStore>,
    widget_state: RwLock<BTreeMap<WidgetId, Value>>,
    widget_state_revisions: RwLock<BTreeMap<WidgetId, u64>>,
    widget_state_update: Mutex<()>,
}

struct ManagedInstance {
    resource: Instance,
    config: Arc<WidgetConfig>,
    backend: WidgetBackend,
    health: HealthTracker,
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
    #[error("widget options are invalid: {0}")]
    InvalidOptions(String),
    #[error("widget inputs are invalid: {0}")]
    InvalidInputs(String),
    #[error("could not save runtime state")]
    PersistenceFailed,
    #[error("widget state exceeds 64 KiB")]
    WidgetStateTooLarge,
    #[error("widget state revision is stale")]
    WidgetStateConflict,
    #[error("{0}")]
    InvalidState(String),
}

impl InstanceManager {
    pub fn restore(store: Arc<StateStore>) -> Result<Self, InstanceError> {
        let saved = store.load().map_err(|error| {
            InstanceError::InvalidState(format!("could not read runtime state: {error}"))
        })?;
        for value in saved.widget_state.values() {
            validate_widget_state(value).map_err(|error| {
                InstanceError::InvalidState(format!("invalid widget state: {error}"))
            })?;
        }
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            inner: Arc::new(Inner {
                instances: Mutex::new(HashMap::new()),
                events,
                store,
                widget_state_revisions: RwLock::new(
                    saved
                        .widget_state
                        .keys()
                        .map(|widget_id| (widget_id.clone(), 0))
                        .collect(),
                ),
                widget_state: RwLock::new(saved.widget_state),
                widget_state_update: Mutex::new(()),
            }),
        })
    }

    #[cfg(test)]
    pub fn empty(store: Arc<StateStore>) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                instances: Mutex::new(HashMap::new()),
                events,
                store,
                widget_state: RwLock::new(BTreeMap::new()),
                widget_state_revisions: RwLock::new(BTreeMap::new()),
                widget_state_update: Mutex::new(()),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.inner.events.subscribe()
    }

    pub fn publish(&self, event: RuntimeEvent) {
        let _ = self.inner.events.send(event);
    }

    pub async fn list(&self) -> Vec<Instance> {
        let instances = self.inner.instances.lock().await;
        let mut resources = instances
            .values()
            .map(|instance| instance.resource.clone())
            .collect::<Vec<_>>();
        resources.sort_by(|left, right| left.id.cmp(&right.id));
        resources
    }

    pub async fn list_health(&self) -> Vec<InstanceHealth> {
        let instances = self.inner.instances.lock().await;
        let mut health = instances
            .values()
            .map(|instance| instance.health.snapshot())
            .collect::<Vec<_>>();
        health.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
        health
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

    pub async fn health(&self, instance_id: &str) -> Result<InstanceHealth, InstanceError> {
        self.inner
            .instances
            .lock()
            .await
            .get(instance_id)
            .map(|instance| instance.health.snapshot())
            .ok_or(InstanceError::UnknownInstance)
    }

    pub async fn create(
        &self,
        config: Arc<WidgetConfig>,
        spec: CreateInstanceSpec,
    ) -> Result<Instance, InstanceError> {
        if !config.backend.is_file() {
            tracing::warn!(
                widget_id = %config.descriptor.id,
                path = %config.backend.display(),
                "widget backend executable was not found"
            );
            return Err(InstanceError::BackendNotFound);
        }
        config
            .variant(&spec.variant_id)
            .ok_or(InstanceError::UnknownVariant)?;
        let options = config
            .normalize_options(&spec.variant_id, &spec.options)
            .map_err(InstanceError::InvalidOptions)?;
        let inputs = normalize_inputs(&config, &spec.variant_id, spec.inputs)?;
        let resource = Instance {
            id: format!("instance-{}", Uuid::new_v4()),
            widget_id: config.descriptor.id.clone(),
            variant_id: spec.variant_id,
            options,
            inputs,
        };
        tracing::info!(
            instance_id = %resource.id,
            widget_id = %resource.widget_id,
            "creating widget instance"
        );
        let health = HealthTracker::new(resource.id.clone(), self.inner.events.clone());
        let backend = WidgetBackend::start(
            config.clone(),
            resource.id.clone(),
            resource.variant_id.clone(),
            resource.options.clone(),
            self.inner.events.clone(),
            health.clone(),
        );
        self.inner.instances.lock().await.insert(
            resource.id.clone(),
            ManagedInstance {
                resource: resource.clone(),
                config,
                backend,
                health: health.clone(),
            },
        );
        let _ = self.inner.events.send(RuntimeEvent::InstanceCreated {
            instance: resource.clone(),
        });
        health.publish();
        Ok(resource)
    }

    pub async fn destroy(&self, instance_id: &str) -> Result<(), InstanceError> {
        let mut instance = self
            .inner
            .instances
            .lock()
            .await
            .remove(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;
        tracing::info!(instance_id, "destroying widget instance");
        let _ = self.inner.events.send(RuntimeEvent::InstanceDestroyed {
            instance_id: instance_id.into(),
        });
        instance.backend.shutdown().await;
        Ok(())
    }

    pub async fn set_inputs(
        &self,
        instance_id: &str,
        inputs: BTreeMap<String, TypedInput>,
    ) -> Result<Instance, InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        let instance = instances
            .get_mut(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;
        let inputs = normalize_inputs(&instance.config, &instance.resource.variant_id, inputs)?;
        instance.resource.inputs = inputs.clone();
        let resource = instance.resource.clone();
        let _ = self.inner.events.send(RuntimeEvent::InstanceInputsUpdated {
            instance_id: instance_id.into(),
            inputs,
        });
        Ok(resource)
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

    pub async fn restart(&self, instance_id: &str) -> Result<InstanceHealth, InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        let instance = instances
            .get_mut(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;
        tracing::info!(instance_id, "restarting widget backend");
        instance.backend.shutdown().await;
        instance.health.restarted();
        instance.backend = WidgetBackend::start(
            instance.config.clone(),
            instance.resource.id.clone(),
            instance.resource.variant_id.clone(),
            instance.resource.options.clone(),
            self.inner.events.clone(),
            instance.health.clone(),
        );
        Ok(instance.health.snapshot())
    }

    pub fn get_widget_state(&self, widget_id: &str) -> (u64, Value) {
        let revision = self
            .inner
            .widget_state_revisions
            .read()
            .expect("widget state revision lock is poisoned")
            .get(widget_id)
            .copied()
            .unwrap_or(0);
        let value = self
            .inner
            .widget_state
            .read()
            .expect("widget state lock is poisoned")
            .get(widget_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        (revision, value)
    }

    pub async fn set_widget_state(
        &self,
        widget_id: &str,
        expected_revision: u64,
        value: Value,
    ) -> Result<(u64, Value), InstanceError> {
        validate_widget_state(&value)?;
        let _update = self.inner.widget_state_update.lock().await;
        let revisions = self
            .inner
            .widget_state_revisions
            .read()
            .expect("widget state revision lock is poisoned");
        let current_revision = revisions.get(widget_id).copied().unwrap_or(0);
        if expected_revision != current_revision {
            return Err(InstanceError::WidgetStateConflict);
        }
        let revision = current_revision
            .checked_add(1)
            .ok_or(InstanceError::WidgetStateConflict)?;
        let mut proposed = self
            .inner
            .widget_state
            .read()
            .expect("widget state lock is poisoned")
            .clone();
        proposed.insert(widget_id.into(), value.clone());
        self.inner
            .store
            .save(&RuntimeStateFile::with_widget_state(proposed))
            .map_err(|error| {
                tracing::error!(%error, path = %self.inner.store.path().display(), "failed to persist runtime state");
                InstanceError::PersistenceFailed
            })?;
        self.inner
            .widget_state
            .write()
            .expect("widget state lock is poisoned")
            .insert(widget_id.into(), value.clone());
        drop(revisions);
        self.inner
            .widget_state_revisions
            .write()
            .expect("widget state revision lock is poisoned")
            .insert(widget_id.into(), revision);
        let _ = self.inner.events.send(RuntimeEvent::WidgetStateUpdated {
            widget_id: widget_id.into(),
            revision,
            value: value.clone(),
        });
        Ok((revision, value))
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
        for mut instance in instances {
            instance.backend.shutdown().await;
        }
    }
}

fn normalize_inputs(
    config: &WidgetConfig,
    variant_id: &str,
    inputs: BTreeMap<String, TypedInput>,
) -> Result<BTreeMap<String, TypedInput>, InstanceError> {
    for (port_id, input) in &inputs {
        let port = config.input(variant_id, port_id).ok_or_else(|| {
            InstanceError::InvalidInputs(format!("unknown or inapplicable input port {port_id:?}"))
        })?;
        if input.input_type != port.link_type {
            return Err(InstanceError::InvalidInputs(format!(
                "input port {port_id:?} requires type {:?}",
                port.link_type
            )));
        }
    }
    Ok(inputs)
}

fn validate_widget_state(value: &Value) -> Result<(), InstanceError> {
    let length = serde_json::to_vec(value)
        .map_err(|_| InstanceError::WidgetStateTooLarge)?
        .len();
    if length > 64 * 1024 {
        return Err(InstanceError::WidgetStateTooLarge);
    }
    Ok(())
}

impl WidgetBackend {
    fn start(
        config: Arc<WidgetConfig>,
        instance_id: InstanceId,
        variant_id: String,
        options: BTreeMap<String, Value>,
        events: broadcast::Sender<RuntimeEvent>,
        health: HealthTracker,
    ) -> Self {
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let task_instance_id = instance_id.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = run_backend(
                &task_instance_id,
                &config,
                &variant_id,
                options,
                &events,
                commands_rx,
                &health,
            )
            .await
            {
                tracing::error!(
                    %error,
                    instance_id = %task_instance_id,
                    widget_id = %config.descriptor.id,
                    "widget backend failed"
                );
                health.failed();
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

    async fn shutdown(&mut self) {
        tracing::debug!(instance_id = %self.instance_id, "sending shutdown to widget backend");
        let _ = self.commands.send(ServerToWidget::Shutdown {});
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await {
                Ok(result) => {
                    if let Err(error) = result {
                        tracing::debug!(%error, instance_id = %self.instance_id, "widget backend task did not join cleanly");
                    }
                }
                Err(_) => {
                    tracing::warn!(instance_id = %self.instance_id, "widget backend shutdown timed out; terminating it");
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
    instance_id: &str,
    config: &WidgetConfig,
    variant_id: &str,
    options: BTreeMap<String, Value>,
    events: &broadcast::Sender<RuntimeEvent>,
    mut commands: mpsc::UnboundedReceiver<ServerToWidget>,
    health: &HealthTracker,
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
    let mut probes =
        tokio::time::interval_at(tokio::time::Instant::now() + PROBE_INTERVAL, PROBE_INTERVAL);
    let mut next_nonce = 1_u64;
    let mut pending_probe = None;
    let mut requested_shutdown = false;
    let mut ready = false;

    write_backend_message(
        &mut stdin,
        ServerToWidget::Initialize {
            instance_id: instance_id.into(),
            widget_id: config.descriptor.id.clone(),
            variant_id: variant_id.into(),
            options,
        },
    )
    .await?;

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                requested_shutdown = matches!(command, ServerToWidget::Shutdown {});
                write_backend_message(&mut stdin, command).await?;
                if requested_shutdown { break; }
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                handle_backend_message(
                    instance_id,
                    config,
                    events,
                    health,
                    &line,
                    &mut ready,
                    &mut pending_probe,
                )?;
            }
            _ = probes.tick() => {
                health.check_stale();
                if pending_probe.is_none() {
                    let nonce = next_nonce;
                    next_nonce = next_nonce.wrapping_add(1);
                    write_backend_message(&mut stdin, ServerToWidget::Ping { nonce }).await?;
                    pending_probe = Some(nonce);
                }
            }
        }
    }

    drop(stdin);
    let status = child.wait().await?;
    if !requested_shutdown {
        return Err(format!("widget backend exited unexpectedly with {status}").into());
    }
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
    let encoded = dashboardd_widget_protocol::serialize(message)?;
    stdin.write_all(encoded.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

fn handle_backend_message(
    expected_instance_id: &str,
    config: &WidgetConfig,
    events: &broadcast::Sender<RuntimeEvent>,
    health: &HealthTracker,
    line: &str,
    ready: &mut bool,
    pending_probe: &mut Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match dashboardd_widget_protocol::parse::<WidgetToServer>(line)? {
        WidgetToServer::Ready { widget_id } if widget_id == config.descriptor.id => {
            *ready = true;
            health.ready();
            tracing::info!(instance_id = expected_instance_id, %widget_id, "widget backend is ready");
        }
        WidgetToServer::Update {
            instance_id,
            payload,
        } if *ready && instance_id == expected_instance_id => {
            health.update();
            tracing::debug!(%instance_id, "received widget telemetry");
            let _ = events.send(RuntimeEvent::WidgetUpdate {
                instance_id,
                payload,
            });
        }
        WidgetToServer::Error {
            instance_id: Some(instance_id),
            error,
        } if instance_id == expected_instance_id => {
            health.reported_error(&error.code, &error.message);
            tracing::warn!(%instance_id, code = %error.code, message = %error.message, "widget backend reported an error");
        }
        WidgetToServer::Error {
            instance_id: None,
            error,
        } => {
            health.activity();
            tracing::warn!(code = %error.code, message = %error.message, "widget backend reported an unscoped error");
            let _ = events.send(RuntimeEvent::InstanceError {
                instance_id: None,
                error: error.into(),
            });
        }
        WidgetToServer::Pong { nonce } if *pending_probe == Some(nonce) => {
            *pending_probe = None;
            health.activity();
        }
        WidgetToServer::Ready { widget_id } => {
            return Err(format!("backend announced unexpected widget id {widget_id}").into());
        }
        WidgetToServer::Update { instance_id, .. }
        | WidgetToServer::Error {
            instance_id: Some(instance_id),
            ..
        } => {
            return Err(format!("backend used unexpected instance id {instance_id}").into());
        }
        WidgetToServer::Pong { nonce } => {
            return Err(format!("backend answered unexpected probe {nonce}").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::widget::{WidgetDescriptor, WidgetLinkPort, WidgetVariant};

    fn manager(label: &str) -> (InstanceManager, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "dashboardd-instance-{label}-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&root).unwrap();
        let store = Arc::new(StateStore::new(root.join("runtime.json")));
        (InstanceManager::empty(store), root)
    }

    #[tokio::test]
    async fn empty_manager_lists_no_instances() {
        let (manager, root) = manager("empty");
        assert!(manager.list().await.is_empty());
        assert!(matches!(
            manager.get("missing").await,
            Err(InstanceError::UnknownInstance)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_direct_input_ports_and_exact_types() {
        let config = WidgetConfig {
            descriptor: WidgetDescriptor {
                id: "fixture".into(),
                name: "Fixture".into(),
                description: "Fixture widget".into(),
                variants: vec![WidgetVariant {
                    id: "summary".into(),
                    name: "Summary".into(),
                    width: 1,
                    height: 1,
                    frontend_url: "/fixture.js".into(),
                    focus: false,
                }],
                options: vec![],
                inputs: vec![WidgetLinkPort {
                    id: "message".into(),
                    name: "Message".into(),
                    link_type: "fixture.message/v1".into(),
                    variants: vec!["summary".into()],
                    required: true,
                }],
                outputs: vec![],
            },
            backend: "backend".into(),
            frontends: vec!["fixture.js".into()],
        };
        let input = TypedInput {
            input_type: "fixture.message/v1".into(),
            value: serde_json::json!({"opaque": [1, true, null]}),
        };
        assert_eq!(
            normalize_inputs(
                &config,
                "summary",
                BTreeMap::from([("message".into(), input.clone())]),
            )
            .unwrap(),
            BTreeMap::from([("message".into(), input)])
        );
        assert!(matches!(
            normalize_inputs(
                &config,
                "summary",
                BTreeMap::from([(
                    "message".into(),
                    TypedInput {
                        input_type: "wrong/v1".into(),
                        value: Value::Null,
                    },
                )]),
            ),
            Err(InstanceError::InvalidInputs(_))
        ));
        assert!(matches!(
            normalize_inputs(
                &config,
                "summary",
                BTreeMap::from([(
                    "unknown".into(),
                    TypedInput {
                        input_type: "fixture.message/v1".into(),
                        value: Value::Null,
                    },
                )]),
            ),
            Err(InstanceError::InvalidInputs(_))
        ));
    }

    #[tokio::test]
    async fn persists_shared_widget_state_before_publishing_it() {
        let (manager, root) = manager("state");
        let mut events = manager.subscribe();
        let value = serde_json::json!({"pins": []});
        assert_eq!(
            manager
                .set_widget_state("projects", 0, value.clone())
                .await
                .unwrap(),
            (1, value.clone())
        );
        assert!(matches!(
            events.recv().await.unwrap(),
            RuntimeEvent::WidgetStateUpdated { revision: 1, .. }
        ));
        assert!(matches!(
            manager
                .set_widget_state("projects", 0, serde_json::json!({}))
                .await,
            Err(InstanceError::WidgetStateConflict)
        ));
        let (left, right) = tokio::join!(
            manager.set_widget_state("projects", 1, serde_json::json!({"writer": "left"})),
            manager.set_widget_state("projects", 1, serde_json::json!({"writer": "right"})),
        );
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        assert!(matches!(
            left.err().or_else(|| right.err()),
            Some(InstanceError::WidgetStateConflict)
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
