//! Versioned events sent from dashboardd to browser event streams.

use dashboard_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    configuration::Theme,
    health::InstanceHealth,
    instance::{Dashboard, Instance},
    state::{DashboardId, DashboardLink},
};

pub const EVENT_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DashboardError {
    pub code: String,
    pub message: String,
}

impl From<dashboard_protocol::ErrorData> for DashboardError {
    fn from(error: dashboard_protocol::ErrorData) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum DashboardEvent {
    DashboardCreated {
        dashboard: Dashboard,
    },
    DashboardUpdated {
        dashboard: Dashboard,
    },
    DashboardDestroyed {
        dashboard_id: DashboardId,
    },
    InstanceCreated {
        dashboard_id: DashboardId,
        instance: Instance,
    },
    InstanceUpdated {
        dashboard_id: DashboardId,
        instance: Instance,
    },
    InstanceDestroyed {
        dashboard_id: DashboardId,
        instance_id: InstanceId,
    },
    LinkUpdated {
        dashboard_id: DashboardId,
        link: DashboardLink,
    },
    LinkDestroyed {
        dashboard_id: DashboardId,
        target_instance_id: InstanceId,
        target_port: String,
    },
    InstanceError {
        dashboard_id: Option<DashboardId>,
        instance_id: Option<InstanceId>,
        error: DashboardError,
    },
    InstanceHealthUpdated {
        dashboard_id: DashboardId,
        health: InstanceHealth,
    },
    WidgetUpdate {
        dashboard_id: DashboardId,
        instance_id: InstanceId,
        payload: Value,
    },
    WidgetStateUpdated {
        widget_id: WidgetId,
        revision: u64,
        value: Value,
    },
    ThemeUpdated {
        theme: Box<Theme>,
    },
    ConfigurationError {
        error: DashboardError,
    },
}

#[derive(Serialize)]
struct EventEnvelope<T> {
    version: u16,
    #[serde(flatten)]
    event: T,
}

pub fn serialize(event: DashboardEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(&EventEnvelope {
        version: EVENT_VERSION,
        event,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn widget_state_update_serializes_as_a_versioned_event() {
        let encoded = serialize(DashboardEvent::WidgetStateUpdated {
            widget_id: "projects".into(),
            revision: 3,
            value: json!({"pins": []}),
        })
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            json!({
                "version": 1,
                "kind": "widget_state_updated",
                "data": {
                    "widget_id": "projects",
                    "revision": 3,
                    "value": {"pins": []}
                }
            })
        );
    }

    #[test]
    fn composition_update_serializes_with_dashboard_identity() {
        let encoded = serialize(DashboardEvent::InstanceDestroyed {
            dashboard_id: "dashboard-2".into(),
            instance_id: "cpu-1".into(),
        })
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            json!({
                "version": 1,
                "kind": "instance_destroyed",
                "data": {
                    "dashboard_id": "dashboard-2",
                    "instance_id": "cpu-1"
                }
            })
        );
    }

    #[test]
    fn widget_update_serializes_as_a_versioned_event() {
        let encoded = serialize(DashboardEvent::WidgetUpdate {
            dashboard_id: "dashboard-1".into(),
            instance_id: "cpu-1".into(),
            payload: json!({"usage_percent": 42.5}),
        })
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            json!({
                "version": 1,
                "kind": "widget_update",
                "data": {
                    "dashboard_id": "dashboard-1",
                    "instance_id": "cpu-1",
                    "payload": {"usage_percent": 42.5}
                }
            })
        );
    }
}
