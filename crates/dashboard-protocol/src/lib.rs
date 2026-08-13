//! Versioned JSON wire types shared by the dashboard and widget endpoints.
//!
//! This crate owns transport-neutral messages and payloads; change it when the
//! wire contract changes.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;

pub mod prelude;

/// Version used by the JSON wire contract.
pub const PROTOCOL_VERSION: u16 = 1;

/// Opaque identifier used to correlate a request with its response.
pub type RequestId = String;
/// Stable identifier declared by a widget manifest.
pub type WidgetId = String;
/// Identifier assigned to one running widget instance.
pub type InstanceId = String;

/// Versioned envelope carried by every protocol message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Wire schema version used to encode the message.
    pub version: u16,
    /// Direction-specific message kind and data.
    #[serde(flatten)]
    pub message: T,
}

/// Wraps a message with the current protocol version.
pub fn message<T>(message: T) -> Envelope<T> {
    Envelope {
        version: PROTOCOL_VERSION,
        message,
    }
}

/// Errors raised while decoding a protocol message.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// The input is not valid JSON or does not match the requested message type.
    #[error("invalid protocol message: {0}")]
    InvalidMessage(#[from] serde_json::Error),
    /// The message uses a protocol version this crate does not support.
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u16),
}

/// Parses and validates a versioned protocol message.
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

/// Wraps and serializes a protocol message.
pub fn serialize<T>(message: T) -> Result<String, serde_json::Error>
where
    T: Serialize,
{
    serde_json::to_string(&self::message(message))
}

/// Messages sent by the browser dashboard to `dashboardd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum DashboardToServer {
    /// Starts the browser-to-server protocol handshake.
    Hello {},
    /// Requests the widgets currently available to the server.
    ListWidgets {
        /// Correlates the request with the widget-list response.
        request_id: RequestId,
    },
    /// Requests a new instance of a widget.
    CreateInstance {
        /// Correlates the request with the instance-created response.
        request_id: RequestId,
        /// Widget manifest identifier.
        widget_id: WidgetId,
    },
    /// Requests that a widget instance be stopped.
    DestroyInstance {
        /// Correlates the request with the instance-destroyed response.
        request_id: RequestId,
        /// Running instance identifier.
        instance_id: InstanceId,
    },
    /// Sends widget-specific data to an instance.
    WidgetMessage {
        /// Running instance identifier.
        instance_id: InstanceId,
        /// Widget-owned JSON payload.
        payload: Value,
    },
}

/// Messages sent by `dashboardd` to the browser dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ServerToDashboard {
    /// Completes the browser-to-server protocol handshake.
    Ready {},
    /// Returns widgets available to the server.
    Widgets {
        /// Correlates the response with the list request.
        request_id: RequestId,
        /// Available widget descriptors.
        widgets: Vec<WidgetDescriptor>,
    },
    /// Confirms that a widget instance was started.
    InstanceCreated {
        /// Correlates the response with the create request.
        request_id: RequestId,
        /// New running instance identifier.
        instance_id: InstanceId,
        /// Widget manifest identifier.
        widget_id: WidgetId,
    },
    /// Confirms that a widget instance was stopped.
    InstanceDestroyed {
        /// Correlates the response with the destroy request.
        request_id: RequestId,
        /// Stopped instance identifier.
        instance_id: InstanceId,
    },
    /// Sends widget-specific data to the browser dashboard.
    WidgetMessage {
        /// Running instance identifier.
        instance_id: InstanceId,
        /// Widget-owned JSON payload.
        payload: Value,
    },
    /// Reports a request or connection error.
    Error {
        /// Request correlation ID when the error belongs to a request.
        request_id: Option<RequestId>,
        /// Error details.
        error: ErrorData,
    },
}

/// Metadata advertised for one available widget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetDescriptor {
    /// Stable widget manifest identifier.
    pub id: WidgetId,
    /// Display name shown by the dashboard.
    pub name: String,
    /// Browser module URL served by dashboardd.
    pub frontend_url: String,
}

/// Machine-readable and human-readable details for an application error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorData {
    /// Stable machine-readable error code.
    pub code: String,
    /// Human-readable error description.
    pub message: String,
}

/// Messages sent by a widget backend process to `dashboardd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum WidgetToServer {
    /// Announces that the backend process is ready.
    Ready {
        /// Widget manifest identifier served by the process.
        widget_id: WidgetId,
    },
    /// Sends a widget update to the dashboard server.
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

/// Messages sent by `dashboardd` to a widget backend process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ServerToWidget {
    /// Associates a backend process with a running widget instance.
    Initialize {
        /// Running instance identifier.
        instance_id: InstanceId,
        /// Widget manifest identifier.
        widget_id: WidgetId,
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
    fn dashboard_hello_serializes_as_a_versioned_envelope() {
        let message = message(DashboardToServer::Hello {});

        assert_eq!(
            serde_json::to_value(message).unwrap(),
            json!({"version": 1, "kind": "hello", "data": {}})
        );
    }

    #[test]
    fn server_widgets_deserializes_from_a_versioned_envelope() {
        let message: Envelope<ServerToDashboard> = serde_json::from_value(json!({
            "version": 1,
            "kind": "widgets",
            "data": {
                "request_id": "request-1",
                "widgets": [{
                    "id": "cpu",
                    "name": "CPU",
                    "frontend_url": "/widgets/cpu/frontend.js"
                }]
            }
        }))
        .unwrap();

        assert_eq!(
            message,
            Envelope {
                version: 1,
                message: ServerToDashboard::Widgets {
                    request_id: "request-1".into(),
                    widgets: vec![WidgetDescriptor {
                        id: "cpu".into(),
                        name: "CPU".into(),
                        frontend_url: "/widgets/cpu/frontend.js".into(),
                    }],
                },
            }
        );
    }

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
        let result = serde_json::from_value::<Envelope<DashboardToServer>>(json!({
            "version": 1,
            "kind": "future_message",
            "data": {}
        }));

        assert!(result.is_err());
    }

    #[test]
    fn missing_required_fields_fail_to_deserialize() {
        let result = serde_json::from_value::<Envelope<ServerToDashboard>>(json!({
            "version": 1,
            "kind": "widgets",
            "data": {"request_id": "request-1"}
        }));

        assert!(result.is_err());
    }

    #[test]
    fn server_error_can_omit_request_id() {
        let message = message(ServerToDashboard::Error {
            request_id: None,
            error: ErrorData {
                code: "unknown_widget".into(),
                message: "Widget 'cpu' was not found".into(),
            },
        });

        assert_eq!(
            serde_json::to_value(message).unwrap(),
            json!({
                "version": 1,
                "kind": "error",
                "data": {
                    "request_id": null,
                    "error": {
                        "code": "unknown_widget",
                        "message": "Widget 'cpu' was not found"
                    }
                }
            })
        );
    }

    #[test]
    fn parse_returns_message_data_and_validates_version() {
        let parsed =
            parse::<DashboardToServer>(r#"{"version":1,"kind":"hello","data":{}}"#).unwrap();

        assert_eq!(parsed, DashboardToServer::Hello {});
        assert_eq!(
            parse::<DashboardToServer>(r#"{"version":2,"kind":"hello","data":{}}"#)
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

    #[test]
    fn message_injects_the_current_protocol_version() {
        let wrapped = message(ServerToWidget::Shutdown {});

        assert_eq!(wrapped.version, PROTOCOL_VERSION);
        assert_eq!(wrapped.message, ServerToWidget::Shutdown {});
    }
}
