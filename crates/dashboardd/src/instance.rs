//! Running widget instances and backend process lifecycle.

use std::{
    collections::{BTreeMap, HashMap},
    process::Stdio,
    sync::{
        Arc, RwLock,
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
    configuration::InitialWidget,
    event::DashboardEvent,
    health::{HealthTracker, InstanceHealth, PROBE_INTERVAL},
    state::{DashboardLink, DashboardStateFile, PersistedInstance, Position, StateStore},
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
    pub options: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct NewInstanceLink {
    pub source_instance_id: InstanceId,
    pub source_port: String,
    pub target_port: String,
}

#[derive(Clone)]
pub struct InstanceManager {
    inner: Arc<Inner>,
}

struct Inner {
    layout: DashboardLayout,
    instances: Mutex<HashMap<InstanceId, ManagedInstance>>,
    links: RwLock<Vec<DashboardLink>>,
    events: broadcast::Sender<DashboardEvent>,
    next_id: AtomicU64,
    store: Option<Arc<StateStore>>,
    widget_state: RwLock<BTreeMap<WidgetId, Value>>,
    widget_state_revisions: RwLock<BTreeMap<WidgetId, u64>>,
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
    #[error("layout must fit within the dashboard grid and have a positive size")]
    InvalidLayout,
    #[error("layout overlaps another widget instance")]
    LayoutOccupied,
    #[error("widget options are invalid: {0}")]
    InvalidOptions(String),
    #[error("widget link is invalid: {0}")]
    InvalidLink(String),
    #[error("widget link was not found")]
    UnknownLink,
    #[error("could not save dashboard composition")]
    PersistenceFailed,
    #[error("widget state exceeds 64 KiB")]
    WidgetStateTooLarge,
    #[error("widget state revision is stale")]
    WidgetStateConflict,
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
                links: RwLock::new(Vec::new()),
                events,
                next_id: AtomicU64::new(1),
                store: None,
                widget_state: RwLock::new(BTreeMap::new()),
                widget_state_revisions: RwLock::new(BTreeMap::new()),
            }),
        }
    }

    pub async fn restore(
        layout: DashboardLayout,
        widgets: WidgetsManager,
        store: Arc<StateStore>,
        initial_widgets: &[InitialWidget],
    ) -> Result<Self, InstanceError> {
        let mut saved = store.load().map_err(|error| {
            InstanceError::InvalidState(format!("could not read state: {error}"))
        })?;
        if saved.is_none() && !initial_widgets.is_empty() {
            let initial = initial_state(layout, &widgets, initial_widgets)?;
            store.save(&initial).map_err(|error| {
                InstanceError::InvalidState(format!(
                    "could not save initial dashboard composition: {error}"
                ))
            })?;
            saved = Some(initial);
        }
        let had_saved_state = saved.is_some();
        let (events, _) = broadcast::channel(256);
        let mut restored = Vec::new();
        let mut restored_links = Vec::new();
        let mut restored_widget_state = BTreeMap::new();
        let mut next_id = 1;
        if let Some(saved) = saved {
            restored_links = saved.links;
            restored_widget_state = saved.widget_state;
            for value in restored_widget_state.values() {
                validate_widget_state(value).map_err(|error| {
                    InstanceError::InvalidState(format!("invalid widget state: {error}"))
                })?;
            }
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
                let options = config
                    .normalize_options(&persisted.variant_id, &persisted.options)
                    .map_err(|error| {
                        InstanceError::InvalidState(format!(
                            "instance {:?} has invalid options: {error}",
                            persisted.id
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
                        options,
                    },
                    config,
                ));
            }
        }
        let instances = restored
            .into_iter()
            .map(|(resource, config)| {
                let health = HealthTracker::new(resource.id.clone(), events.clone());
                let backend = WidgetBackend::start(
                    config.clone(),
                    resource.id.clone(),
                    resource.variant_id.clone(),
                    resource.options.clone(),
                    events.clone(),
                    health.clone(),
                );
                (
                    resource.id.clone(),
                    ManagedInstance {
                        resource,
                        config,
                        backend,
                        health,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        validate_links(&instances, &restored_links).map_err(|error| {
            InstanceError::InvalidState(format!("dashboard has invalid links: {error}"))
        })?;
        if had_saved_state {
            let mut normalized = instances
                .values()
                .map(|instance| PersistedInstance::from(&instance.resource))
                .collect::<Vec<_>>();
            normalized.sort_by(|left, right| left.id.cmp(&right.id));
            sort_links(&mut restored_links);
            store
                .save(
                    &DashboardStateFile::new(normalized, restored_links.clone())
                        .with_widget_state(restored_widget_state.clone()),
                )
                .map_err(|error| {
                    InstanceError::InvalidState(format!("could not migrate state: {error}"))
                })?;
        }
        Ok(Self {
            inner: Arc::new(Inner {
                layout,
                instances: Mutex::new(instances),
                links: RwLock::new(restored_links),
                events,
                next_id: AtomicU64::new(next_id),
                store: Some(store),
                widget_state_revisions: RwLock::new(
                    restored_widget_state
                        .keys()
                        .map(|widget_id| (widget_id.clone(), 0))
                        .collect(),
                ),
                widget_state: RwLock::new(restored_widget_state),
            }),
        })
    }

    pub fn layout(&self) -> DashboardLayout {
        self.inner.layout
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DashboardEvent> {
        self.inner.events.subscribe()
    }

    pub fn publish(&self, event: DashboardEvent) {
        let _ = self.inner.events.send(event);
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

    pub async fn list_health(&self) -> Vec<InstanceHealth> {
        let instances = self.inner.instances.lock().await;
        let mut health = instances
            .values()
            .map(|instance| instance.health.snapshot())
            .collect::<Vec<_>>();
        health.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
        health
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

    pub fn list_links(&self) -> Vec<DashboardLink> {
        self.inner
            .links
            .read()
            .expect("links lock is poisoned")
            .clone()
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
        supplied_options: BTreeMap<String, Value>,
        supplied_links: Vec<NewInstanceLink>,
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
        let options = config
            .normalize_options(&variant_id, &supplied_options)
            .map_err(InstanceError::InvalidOptions)?;
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

        let mut resource = Instance {
            id: String::new(),
            widget_id: widget_id.clone(),
            variant_id,
            layout,
            options,
        };
        let mut new_links =
            validate_new_instance_links(&instances, &resource, &config, supplied_links)?;
        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        resource.id = format!("{widget_id}-{sequence}");
        for link in &mut new_links {
            link.target_instance_id.clone_from(&resource.id);
        }
        let mut proposed_links = self.list_links();
        proposed_links.extend(new_links.iter().cloned());
        self.persist_composition(
            instances
                .values()
                .map(|instance| &instance.resource)
                .chain(std::iter::once(&resource)),
            &proposed_links,
        )?;
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
        instances.insert(
            resource.id.clone(),
            ManagedInstance {
                resource: resource.clone(),
                config,
                backend,
                health: health.clone(),
            },
        );
        if !new_links.is_empty() {
            self.inner
                .links
                .write()
                .expect("links lock is poisoned")
                .extend(new_links.iter().cloned());
        }
        drop(instances);

        let _ = self.inner.events.send(DashboardEvent::InstanceCreated {
            instance: resource.clone(),
        });
        health.publish();
        for link in new_links {
            let _ = self.inner.events.send(DashboardEvent::LinkUpdated { link });
        }
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

    pub async fn set_link(&self, link: DashboardLink) -> Result<DashboardLink, InstanceError> {
        let instances = self.inner.instances.lock().await;
        validate_link(&instances, &link).map_err(InstanceError::InvalidLink)?;
        let mut proposed = self.list_links();
        proposed.retain(|existing| {
            existing.target_instance_id != link.target_instance_id
                || existing.target_port != link.target_port
        });
        proposed.push(link.clone());
        self.persist_composition(
            instances.values().map(|instance| &instance.resource),
            &proposed,
        )?;
        sort_links(&mut proposed);
        *self.inner.links.write().expect("links lock is poisoned") = proposed;
        drop(instances);
        let _ = self
            .inner
            .events
            .send(DashboardEvent::LinkUpdated { link: link.clone() });
        Ok(link)
    }

    pub async fn delete_link(
        &self,
        target_instance_id: &str,
        target_port: &str,
    ) -> Result<(), InstanceError> {
        let instances = self.inner.instances.lock().await;
        let mut proposed = self.list_links();
        let previous_len = proposed.len();
        proposed.retain(|link| {
            link.target_instance_id != target_instance_id || link.target_port != target_port
        });
        if proposed.len() == previous_len {
            return Err(InstanceError::UnknownLink);
        }
        self.persist_composition(
            instances.values().map(|instance| &instance.resource),
            &proposed,
        )?;
        *self.inner.links.write().expect("links lock is poisoned") = proposed;
        drop(instances);
        let _ = self.inner.events.send(DashboardEvent::LinkDestroyed {
            target_instance_id: target_instance_id.into(),
            target_port: target_port.into(),
        });
        Ok(())
    }

    pub async fn destroy(&self, instance_id: &str) -> Result<(), InstanceError> {
        let mut instances = self.inner.instances.lock().await;
        if !instances.contains_key(instance_id) {
            return Err(InstanceError::UnknownInstance);
        }
        let current_links = self.list_links();
        let (removed_links, retained_links): (Vec<_>, Vec<_>) =
            current_links.into_iter().partition(|link| {
                link.source_instance_id == instance_id || link.target_instance_id == instance_id
            });
        self.persist_composition(
            instances
                .iter()
                .filter(|(id, _)| id.as_str() != instance_id)
                .map(|(_, instance)| &instance.resource),
            &retained_links,
        )?;
        let mut instance = instances
            .remove(instance_id)
            .expect("instance existence is checked");
        *self.inner.links.write().expect("links lock is poisoned") = retained_links;
        drop(instances);

        tracing::info!(instance_id, "destroying widget instance");
        let _ = self.inner.events.send(DashboardEvent::InstanceDestroyed {
            instance_id: instance_id.into(),
        });
        for link in removed_links {
            let _ = self.inner.events.send(DashboardEvent::LinkDestroyed {
                target_instance_id: link.target_instance_id,
                target_port: link.target_port,
            });
        }
        instance.backend.shutdown().await;
        Ok(())
    }

    fn persist<'a>(
        &self,
        resources: impl Iterator<Item = &'a Instance>,
    ) -> Result<(), InstanceError> {
        let links = self.inner.links.read().expect("links lock is poisoned");
        self.persist_composition(resources, &links)
    }

    fn persist_composition<'a>(
        &self,
        resources: impl Iterator<Item = &'a Instance>,
        links: &[DashboardLink],
    ) -> Result<(), InstanceError> {
        let widget_state = self
            .inner
            .widget_state
            .read()
            .expect("widget state lock is poisoned")
            .clone();
        self.persist_dashboard(resources, links, widget_state)
    }

    fn persist_dashboard<'a>(
        &self,
        resources: impl Iterator<Item = &'a Instance>,
        links: &[DashboardLink],
        widget_state: BTreeMap<WidgetId, Value>,
    ) -> Result<(), InstanceError> {
        let Some(store) = &self.inner.store else {
            return Ok(());
        };
        let mut instances = resources.map(PersistedInstance::from).collect::<Vec<_>>();
        instances.sort_by(|left, right| left.id.cmp(&right.id));
        let mut links = links.to_vec();
        sort_links(&mut links);
        store
            .save(&DashboardStateFile::new(instances, links).with_widget_state(widget_state))
            .map_err(|error| {
                tracing::error!(%error, path = %store.path().display(), "failed to persist dashboard composition");
                InstanceError::PersistenceFailed
            })
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
        let instances = self.inner.instances.lock().await;
        let links = self.inner.links.read().expect("links lock is poisoned");
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
        self.persist_dashboard(
            instances.values().map(|instance| &instance.resource),
            &links,
            proposed,
        )?;
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
        drop(links);
        drop(instances);
        let _ = self.inner.events.send(DashboardEvent::WidgetStateUpdated {
            widget_id: widget_id.into(),
            revision,
            value: value.clone(),
        });
        Ok((revision, value))
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
            options: instance.options.clone(),
        }
    }
}

fn initial_state(
    dashboard: DashboardLayout,
    widgets: &WidgetsManager,
    initial_widgets: &[InitialWidget],
) -> Result<DashboardStateFile, InstanceError> {
    let mut layouts = Vec::new();
    let mut instances = Vec::new();
    for (index, initial) in initial_widgets.iter().enumerate() {
        let config = widgets.get(&initial.widget).ok_or_else(|| {
            InstanceError::InvalidState(format!(
                "initial widget references unknown widget {:?}",
                initial.widget
            ))
        })?;
        let variant = config.variant(&initial.variant).ok_or_else(|| {
            InstanceError::InvalidState(format!(
                "initial widget {:?} references unknown variant {:?}",
                initial.widget, initial.variant
            ))
        })?;
        let options = config
            .normalize_options(&initial.variant, &initial.options)
            .map_err(|error| {
                InstanceError::InvalidState(format!(
                    "initial widget {:?} has invalid options: {error}",
                    initial.widget
                ))
            })?;
        let position = Position {
            column: initial.position[0].checked_sub(1).ok_or_else(|| {
                InstanceError::InvalidState("initial widget column must be positive".into())
            })?,
            row: initial.position[1].checked_sub(1).ok_or_else(|| {
                InstanceError::InvalidState("initial widget row must be positive".into())
            })?,
        };
        let layout = InstanceLayout {
            column: position.column,
            row: position.row,
            width: variant.width,
            height: variant.height,
        };
        validate_layout(dashboard, &layout, layouts.iter()).map_err(|error| {
            InstanceError::InvalidState(format!(
                "initial widget {:?} has invalid position: {error}",
                initial.widget
            ))
        })?;
        layouts.push(layout);
        instances.push(PersistedInstance {
            id: format!("{}-{}", initial.widget, index + 1),
            widget_id: initial.widget.clone(),
            variant_id: initial.variant.clone(),
            position,
            options,
        });
    }
    Ok(DashboardStateFile::new(instances, Vec::new()))
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

fn sequence_after(instance_id: &str) -> u64 {
    instance_id
        .rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<u64>().ok())
        .and_then(|sequence| sequence.checked_add(1))
        .unwrap_or(1)
}

fn validate_new_instance_links(
    instances: &HashMap<InstanceId, ManagedInstance>,
    target: &Instance,
    target_config: &WidgetConfig,
    supplied: Vec<NewInstanceLink>,
) -> Result<Vec<DashboardLink>, InstanceError> {
    let mut target_ports = std::collections::HashSet::new();
    let links = supplied
        .into_iter()
        .map(|link| DashboardLink {
            source_instance_id: link.source_instance_id,
            source_port: link.source_port,
            target_instance_id: target.id.clone(),
            target_port: link.target_port,
        })
        .collect::<Vec<_>>();
    for link in &links {
        if !target_ports.insert(&link.target_port) {
            return Err(InstanceError::InvalidLink(format!(
                "input {:?} has multiple sources",
                link.target_port
            )));
        }
        validate_link_parts(instances, target, target_config, link)
            .map_err(InstanceError::InvalidLink)?;
    }
    if let Some(port) = target_config.descriptor.inputs.iter().find(|port| {
        port.required
            && (port.variants.is_empty()
                || port
                    .variants
                    .iter()
                    .any(|variant| variant == &target.variant_id))
            && !target_ports.contains(&port.id)
    }) {
        return Err(InstanceError::InvalidLink(format!(
            "required input {:?} is not linked",
            port.id
        )));
    }
    Ok(links)
}

fn validate_links(
    instances: &HashMap<InstanceId, ManagedInstance>,
    links: &[DashboardLink],
) -> Result<(), String> {
    let mut targets = std::collections::HashSet::new();
    for link in links {
        if !targets.insert((&link.target_instance_id, &link.target_port)) {
            return Err(format!(
                "input {:?} on instance {:?} has multiple sources",
                link.target_port, link.target_instance_id
            ));
        }
        validate_link(instances, link)?;
    }
    Ok(())
}

fn validate_link(
    instances: &HashMap<InstanceId, ManagedInstance>,
    link: &DashboardLink,
) -> Result<(), String> {
    let target = instances.get(&link.target_instance_id).ok_or_else(|| {
        format!(
            "target instance {:?} does not exist",
            link.target_instance_id
        )
    })?;
    validate_link_parts(instances, &target.resource, &target.config, link)
}

fn validate_link_parts(
    instances: &HashMap<InstanceId, ManagedInstance>,
    target: &Instance,
    target_config: &WidgetConfig,
    link: &DashboardLink,
) -> Result<(), String> {
    if link.source_instance_id == target.id {
        return Err("an instance cannot link to itself".into());
    }
    let source = instances.get(&link.source_instance_id).ok_or_else(|| {
        format!(
            "source instance {:?} does not exist",
            link.source_instance_id
        )
    })?;
    let output = source
        .config
        .output(&source.resource.variant_id, &link.source_port)
        .ok_or_else(|| format!("source output {:?} does not exist", link.source_port))?;
    let input = target_config
        .input(&target.variant_id, &link.target_port)
        .ok_or_else(|| format!("target input {:?} does not exist", link.target_port))?;
    if output.link_type != input.link_type {
        return Err(format!(
            "link types {:?} and {:?} do not match",
            output.link_type, input.link_type
        ));
    }
    Ok(())
}

fn sort_links(links: &mut [DashboardLink]) {
    links.sort_by(|left, right| {
        (&left.target_instance_id, &left.target_port)
            .cmp(&(&right.target_instance_id, &right.target_port))
    });
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
        variant_id: String,
        options: BTreeMap<String, Value>,
        events: broadcast::Sender<DashboardEvent>,
        health: HealthTracker,
    ) -> Self {
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let task_instance_id = instance_id.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = run_backend(
                &config,
                &task_instance_id,
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
    variant_id: &str,
    options: BTreeMap<String, Value>,
    events: &broadcast::Sender<DashboardEvent>,
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
                if requested_shutdown {
                    break;
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                handle_backend_message(
                    config,
                    instance_id,
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
    health: &HealthTracker,
    line: &str,
    ready: &mut bool,
    pending_probe: &mut Option<u64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match dashboard_protocol::parse::<WidgetToServer>(line)? {
        WidgetToServer::Ready { widget_id } if widget_id == config.descriptor.id => {
            *ready = true;
            health.ready();
            tracing::info!(
                instance_id = expected_instance_id,
                %widget_id,
                "widget backend is ready"
            );
        }
        WidgetToServer::Update {
            instance_id,
            payload,
        } if *ready && instance_id == expected_instance_id => {
            health.update();
            tracing::debug!(%instance_id, "received widget telemetry");
            let _ = events.send(DashboardEvent::WidgetUpdate {
                instance_id,
                payload,
            });
        }
        WidgetToServer::Error {
            instance_id: Some(instance_id),
            error,
        } if instance_id == expected_instance_id => {
            health.reported_error(&error.code, &error.message);
            tracing::warn!(
                %instance_id,
                code = %error.code,
                message = %error.message,
                "widget backend reported an error"
            );
        }
        WidgetToServer::Error {
            instance_id: None,
            error,
        } => {
            health.activity();
            tracing::warn!(
                code = %error.code,
                message = %error.message,
                "widget backend reported an unscoped error"
            );
            let _ = events.send(DashboardEvent::InstanceError {
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
    async fn persists_shared_widget_state_before_publishing_it() {
        let root = std::env::temp_dir().join(format!(
            "scufris-widget-state-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&root).unwrap();
        let state_path = root.join("dashboard.json");
        let store = Arc::new(StateStore::new(state_path.clone()));
        store
            .save(
                &DashboardStateFile::new(Vec::new(), Vec::new()).with_widget_state(BTreeMap::from(
                    [("projects".into(), serde_json::json!({"pins": []}))],
                )),
            )
            .unwrap();
        let manager = InstanceManager::restore(
            DashboardLayout::default(),
            WidgetsManager::default(),
            store.clone(),
            &[],
        )
        .await
        .unwrap();
        let mut events = manager.subscribe();

        let value = serde_json::json!({"pins": [{"project_id": "project-1", "project": "one"}]});
        assert_eq!(
            manager
                .set_widget_state("projects", 0, value.clone())
                .await
                .unwrap(),
            (1, value.clone())
        );
        assert_eq!(manager.get_widget_state("projects"), (1, value.clone()));
        assert_eq!(
            store.load().unwrap().unwrap().widget_state["projects"],
            value
        );
        assert!(matches!(
            events.recv().await.unwrap(),
            DashboardEvent::WidgetStateUpdated { revision: 1, .. }
        ));
        assert!(matches!(
            manager
                .set_widget_state("projects", 0, serde_json::json!({}))
                .await,
            Err(InstanceError::WidgetStateConflict)
        ));
        assert!(matches!(
            manager
                .set_widget_state("projects", 1, Value::String("x".repeat(64 * 1024 + 1)))
                .await,
            Err(InstanceError::WidgetStateTooLarge)
        ));

        fs::remove_file(&state_path).unwrap();
        fs::create_dir(&state_path).unwrap();
        assert!(matches!(
            manager
                .set_widget_state("projects", 1, serde_json::json!({"pins": []}))
                .await,
            Err(InstanceError::PersistenceFailed)
        ));
        assert_eq!(manager.get_widget_state("projects"), (1, value));
        assert!(events.try_recv().is_err());
        fs::remove_dir_all(root).unwrap();
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
    fn initial_widgets_are_normalized_and_collisions_are_rejected() {
        let root = std::env::temp_dir().join(format!(
            "scufris-initial-widgets-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"schema_version":2,"id":"cpu","name":"CPU","description":"Processor usage","backend":"backend","variants":[{"id":"compact","name":"Compact","width":1,"height":1,"frontend":"compact.js"}],"options":[]}"#,
        )
        .unwrap();
        fs::write(cpu.join("backend"), "backend").unwrap();
        fs::write(cpu.join("compact.js"), "frontend").unwrap();
        let widgets = WidgetsManager::discover(&root).unwrap();
        let initial = InitialWidget {
            widget: "cpu".into(),
            variant: "compact".into(),
            position: [1, 2],
            options: BTreeMap::new(),
        };

        let state = initial_state(
            DashboardLayout::default(),
            &widgets,
            std::slice::from_ref(&initial),
        )
        .unwrap();

        assert_eq!(state.instances[0].id, "cpu-1");
        assert_eq!(state.instances[0].position.column, 0);
        assert_eq!(state.instances[0].position.row, 1);
        assert!(
            initial_state(
                DashboardLayout::default(),
                &widgets,
                &[initial.clone(), initial],
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn restores_valid_links_and_rejects_invalid_ports() {
        let root = std::env::temp_dir().join(format!(
            "scufris-linked-state-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let widget = root.join("widgets/tatr-tasks");
        fs::create_dir_all(&widget).unwrap();
        fs::write(
            widget.join("widget.json"),
            r#"{"schema_version":2,"id":"tatr-tasks","name":"Tatr Tasks","description":"Tasks","backend":"backend","variants":[{"id":"full","name":"Full","width":1,"height":1,"frontend":"full.js"},{"id":"details","name":"Details","width":1,"height":1,"frontend":"details.js"}],"options":[],"inputs":[{"id":"task","name":"Task","type":"tatr.task/v1","variants":["details"],"required":true}],"outputs":[{"id":"selected_task","name":"Selected","type":"tatr.task/v1","variants":["full"],"required":false}]}"#,
        )
        .unwrap();
        fs::write(widget.join("backend"), "backend").unwrap();
        fs::write(widget.join("full.js"), "frontend").unwrap();
        fs::write(widget.join("details.js"), "frontend").unwrap();
        let widgets = WidgetsManager::discover(&root.join("widgets")).unwrap();
        let state_path = root.join("dashboard.json");
        let store = Arc::new(StateStore::new(state_path));
        let instances = vec![
            PersistedInstance {
                id: "tatr-tasks-1".into(),
                widget_id: "tatr-tasks".into(),
                variant_id: "full".into(),
                position: Position { column: 0, row: 0 },
                options: BTreeMap::new(),
            },
            PersistedInstance {
                id: "tatr-tasks-2".into(),
                widget_id: "tatr-tasks".into(),
                variant_id: "details".into(),
                position: Position { column: 1, row: 0 },
                options: BTreeMap::new(),
            },
        ];
        let link = DashboardLink {
            source_instance_id: "tatr-tasks-1".into(),
            source_port: "selected_task".into(),
            target_instance_id: "tatr-tasks-2".into(),
            target_port: "task".into(),
        };
        store
            .save(&DashboardStateFile::new(
                instances.clone(),
                vec![link.clone()],
            ))
            .unwrap();

        let manager = InstanceManager::restore(
            DashboardLayout::default(),
            widgets.clone(),
            store.clone(),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(manager.list_links(), vec![link.clone()]);
        drop(manager);

        let mut invalid = link;
        invalid.source_port = "missing".into();
        store
            .save(&DashboardStateFile::new(instances, vec![invalid]))
            .unwrap();
        assert!(matches!(
            InstanceManager::restore(DashboardLayout::default(), widgets, store, &[],).await,
            Err(InstanceError::InvalidState(_))
        ));
        fs::remove_dir_all(root).unwrap();
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
