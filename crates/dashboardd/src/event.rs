//! Versioned events sent from dashboardd to browser event streams.

use dashboard_protocol::InstanceId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{configuration::Theme, instance::Instance, state::DashboardLink};

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
    InstanceCreated {
        instance: Instance,
    },
    InstanceUpdated {
        instance: Instance,
    },
    InstanceDestroyed {
        instance_id: InstanceId,
    },
    LinkUpdated {
        link: DashboardLink,
    },
    LinkDestroyed {
        target_instance_id: InstanceId,
        target_port: String,
    },
    InstanceError {
        instance_id: Option<InstanceId>,
        error: DashboardError,
    },
    WidgetUpdate {
        instance_id: InstanceId,
        payload: Value,
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
    fn widget_update_serializes_as_a_versioned_event() {
        let encoded = serialize(DashboardEvent::WidgetUpdate {
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
                    "instance_id": "cpu-1",
                    "payload": {"usage_percent": 42.5}
                }
            })
        );
    }
}
