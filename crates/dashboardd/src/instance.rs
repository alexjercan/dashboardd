//! Global in-memory widget instance management.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use dashboard_protocol::{InstanceId, ServerToWidget, WidgetId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};
use utoipa::ToSchema;

use crate::{
    event::DashboardEvent,
    widget::{self, WidgetBackend, WidgetConfig},
};

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
    instances: Mutex<HashMap<InstanceId, ManagedInstance>>,
    events: broadcast::Sender<DashboardEvent>,
    next_id: AtomicU64,
}

struct ManagedInstance {
    resource: Instance,
    backend: WidgetBackend,
}

#[derive(Debug, Error)]
pub enum InstanceError {
    #[error("instance was not found")]
    UnknownInstance,
    #[error("this widget already has an instance")]
    InstanceExists,
    #[error("widget backend executable was not found")]
    BackendNotFound,
    #[error("widget backend is unavailable")]
    BackendUnavailable,
    #[error("layout width and height must be greater than zero")]
    InvalidLayout,
}

impl InstanceManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                instances: Mutex::new(HashMap::new()),
                events,
                next_id: AtomicU64::new(1),
            }),
        }
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

    pub async fn create(&self, config: Arc<WidgetConfig>) -> Result<Instance, InstanceError> {
        if !config.backend.is_file() {
            return Err(InstanceError::BackendNotFound);
        }

        let widget_id = &config.descriptor.id;
        let mut instances = self.inner.instances.lock().await;
        if instances
            .values()
            .any(|instance| instance.resource.widget_id == *widget_id)
        {
            return Err(InstanceError::InstanceExists);
        }

        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let resource = Instance {
            id: format!("{widget_id}-{sequence}"),
            widget_id: widget_id.clone(),
            layout: InstanceLayout::default(),
        };
        let backend = widget::start_backend(config, resource.id.clone(), self.inner.events.clone());
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
        if layout.width == 0 || layout.height == 0 {
            return Err(InstanceError::InvalidLayout);
        }

        let mut instances = self.inner.instances.lock().await;
        let instance = instances
            .get_mut(instance_id)
            .ok_or(InstanceError::UnknownInstance)?;
        instance.resource.layout = layout;
        let resource = instance.resource.clone();
        drop(instances);

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

        for instance in instances {
            instance.backend.shutdown().await;
        }
    }
}

impl Default for InstanceManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_manager_lists_no_instances() {
        let manager = InstanceManager::new();

        assert!(manager.list().await.is_empty());
        assert!(matches!(
            manager.get("missing").await,
            Err(InstanceError::UnknownInstance)
        ));
    }

    #[tokio::test]
    async fn rejects_zero_sized_layout_before_lookup() {
        let manager = InstanceManager::new();

        assert!(matches!(
            manager
                .update(
                    "missing",
                    InstanceLayout {
                        column: 0,
                        row: 0,
                        width: 0,
                        height: 1,
                    },
                )
                .await,
            Err(InstanceError::InvalidLayout)
        ));
    }
}
