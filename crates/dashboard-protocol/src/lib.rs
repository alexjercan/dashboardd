//! Versioned JSON wire types shared by dashboardd and widget backend processes.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

pub mod prelude;

/// Version used by the widget process JSON-lines contract.
pub const PROTOCOL_VERSION: u16 = 1;

/// Stable identifier declared by a widget manifest.
pub type WidgetId = String;
/// Identifier assigned to one running widget instance.
pub type InstanceId = String;

/// Versioned envelope carried by widget process messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Wire schema version used to encode the message.
    pub version: u16,
    /// Direction-specific message kind and data.
    #[serde(flatten)]
    pub message: T,
}

/// Wraps a widget process message with the current protocol version.
pub fn message<T>(message: T) -> Envelope<T> {
    Envelope {
        version: PROTOCOL_VERSION,
        message,
    }
}

/// Errors raised while decoding a widget process message.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// The input is not valid JSON or does not match the requested message type.
    #[error("invalid protocol message: {0}")]
    InvalidMessage(#[from] serde_json::Error),
    /// The message uses a protocol version this crate does not support.
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u16),
}

/// Parses and validates a versioned widget process message.
pub fn parse<T>(json: &str) -> Result<T, ProtocolError>
where
    T: DeserializeOwned,
{
    let envelope: Envelope<T> = serde_json::from_str(json)?;

    if envelope.version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(envelope.version));
    }

    Ok(envelope.message)
}

/// Wraps and serializes a widget process message.
pub fn serialize<T>(message: T) -> Result<String, serde_json::Error>
where
    T: Serialize,
{
    serde_json::to_string(&self::message(message))
}

/// Machine-readable and human-readable widget process error details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorData {
    /// Stable machine-readable error code.
    pub code: String,
    /// Human-readable error description.
    pub message: String,
}

/// Messages sent by a widget backend process to dashboardd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum WidgetToServer {
    /// Announces that the backend process is ready.
    Ready {
        /// Widget manifest identifier served by the process.
        widget_id: WidgetId,
    },
    /// Sends a widget update to dashboardd.
    Update {
        /// Target running instance identifier.
        instance_id: InstanceId,
        /// Widget-owned JSON payload.
        payload: Value,
    },
    /// Reports a backend or instance error.
    Error {
        /// Affected instance, when one exists.
        instance_id: Option<InstanceId>,
        /// Error details.
        error: ErrorData,
    },
}

/// Messages sent by dashboardd to a widget backend process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ServerToWidget {
    /// Associates a backend process with a running widget instance.
    Initialize {
        /// Running instance identifier.
        instance_id: InstanceId,
        /// Widget manifest identifier.
        widget_id: WidgetId,
        /// Validated effective options active for the selected variant.
        #[serde(default)]
        options: BTreeMap<String, Value>,
    },
    /// Sends widget-specific data to the backend process.
    Message {
        /// Target running instance identifier.
        instance_id: InstanceId,
        /// Widget-owned JSON payload.
        payload: Value,
    },
    /// Reports an error to the widget backend process.
    Error {
        /// Error details.
        error: ErrorData,
    },
    /// Requests that the backend process exit.
    Shutdown {},
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn widget_payloads_round_trip_arbitrary_json() {
        let message = message(WidgetToServer::Update {
            instance_id: "cpu-1".into(),
            payload: json!({"usage": 42.5, "cores": [1, 2, 3]}),
        });

        let encoded = serde_json::to_string(&message).unwrap();
        let decoded: Envelope<WidgetToServer> = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded, message);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let message: Envelope<ServerToWidget> = serde_json::from_value(json!({
            "version": 1,
            "kind": "shutdown",
            "data": {},
            "future_field": true
        }))
        .unwrap();

        assert_eq!(
            message,
            Envelope {
                version: 1,
                message: ServerToWidget::Shutdown {},
            }
        );
    }

    #[test]
    fn unknown_message_kind_fails_to_deserialize() {
        let result = serde_json::from_value::<Envelope<ServerToWidget>>(json!({
            "version": 1,
            "kind": "future_message",
            "data": {}
        }));

        assert!(result.is_err());
    }

    #[test]
    fn missing_required_fields_fail_to_deserialize() {
        let result = serde_json::from_value::<Envelope<ServerToWidget>>(json!({
            "version": 1,
            "kind": "initialize",
            "data": {"widget_id": "cpu"}
        }));

        assert!(result.is_err());
    }

    #[test]
    fn parse_returns_message_data_and_validates_version() {
        let parsed = parse::<ServerToWidget>(
            r#"{"version":1,"kind":"initialize","data":{"instance_id":"cpu-1","widget_id":"cpu","options":{"history_points":40}}}"#,
        )
        .unwrap();

        assert_eq!(
            parsed,
            ServerToWidget::Initialize {
                instance_id: "cpu-1".into(),
                widget_id: "cpu".into(),
                options: BTreeMap::from([("history_points".into(), json!(40))]),
            }
        );
        assert_eq!(
            parse::<ServerToWidget>(r#"{"version":2,"kind":"shutdown","data":{}}"#)
                .unwrap_err()
                .to_string(),
            "unsupported protocol version: 2"
        );
    }

    #[test]
    fn serialize_wraps_message_with_current_version() {
        assert_eq!(
            serialize(ServerToWidget::Shutdown {}).unwrap(),
            r#"{"version":1,"kind":"shutdown","data":{}}"#
        );
    }
}
