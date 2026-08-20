//! Versioned runtime events sent to presentation hosts.

use dashboardd_widget_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{configuration::Theme, health::InstanceHealth, instance::Instance};

pub const EVENT_VERSION: u16 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeErrorData {
    pub code: String,
    pub message: String,
}

impl From<dashboardd_widget_protocol::ErrorData> for RuntimeErrorData {
    fn from(error: dashboardd_widget_protocol::ErrorData) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum RuntimeEvent {
    InstanceCreated {
        instance: Instance,
    },
    InstanceDestroyed {
        instance_id: InstanceId,
    },
    InstanceError {
        instance_id: Option<InstanceId>,
        error: RuntimeErrorData,
    },
    InstanceHealthUpdated {
        health: InstanceHealth,
    },
    WidgetUpdate {
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
        error: RuntimeErrorData,
    },
}

#[derive(Serialize)]
struct EventEnvelope<T> {
    version: u16,
    #[serde(flatten)]
    event: T,
}

pub fn serialize(event: RuntimeEvent) -> Result<String, serde_json::Error> {
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
    fn instance_event_has_no_composition_identity() {
        let encoded = serialize(RuntimeEvent::InstanceDestroyed {
            instance_id: "instance-1".into(),
        })
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            json!({
                "version": 2,
                "kind": "instance_destroyed",
                "data": {"instance_id": "instance-1"}
            })
        );
    }

    #[test]
    fn widget_update_has_only_runtime_identity() {
        let encoded = serialize(RuntimeEvent::WidgetUpdate {
            instance_id: "instance-1".into(),
            payload: json!({"usage_percent": 42.5}),
        })
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            json!({
                "version": 2,
                "kind": "widget_update",
                "data": {
                    "instance_id": "instance-1",
                    "payload": {"usage_percent": 42.5}
                }
            })
        );
    }
}
