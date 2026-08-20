//! Runtime domain events sent to presentation hosts.

use dashboardd_widget_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::collections::BTreeMap;

use crate::{
    configuration::Theme,
    health::InstanceHealth,
    instance::{Instance, TypedInput},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum RuntimeEvent {
    InstanceCreated {
        instance: Instance,
    },
    InstanceDestroyed {
        instance_id: InstanceId,
    },
    InstanceInputsUpdated {
        instance_id: InstanceId,
        inputs: BTreeMap<String, TypedInput>,
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
