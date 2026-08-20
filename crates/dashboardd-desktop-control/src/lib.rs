use std::{
    collections::BTreeMap,
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Wire protocol version accepted by the desktop service.
pub const PROTOCOL_VERSION: u32 = 2;
/// Maximum encoded request or response size, including its LF terminator.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Socket name below the caller's `XDG_RUNTIME_DIR`.
pub const SOCKET_FILE_NAME: &str = "dashboardd-desktop.sock";

/// Returns the control socket path for the current user session.
pub fn socket_path() -> Result<PathBuf, ControlPathError> {
    let runtime_dir = env::var_os("XDG_RUNTIME_DIR").ok_or(ControlPathError::MissingRuntimeDir)?;
    if runtime_dir.is_empty() {
        return Err(ControlPathError::MissingRuntimeDir);
    }
    Ok(PathBuf::from(runtime_dir).join(SOCKET_FILE_NAME))
}

/// Failure to resolve the current user's control socket path.
#[derive(Debug, Error)]
pub enum ControlPathError {
    /// The process has no non-empty `XDG_RUNTIME_DIR`.
    #[error("XDG_RUNTIME_DIR is required")]
    MissingRuntimeDir,
}

/// One versioned command sent to the desktop service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// Requested wire protocol version.
    pub version: u32,
    /// Typed command and its command-specific fields.
    #[serde(flatten)]
    pub command: Command,
}

/// Standalone widget presentation selected by a control client.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presentation {
    /// Full standalone widget presentation.
    #[default]
    Focus,
    /// Compact Dashboard-style presentation.
    Tile,
}

/// One opaque value paired with its declared manifest type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectInput {
    /// Exact versioned manifest type.
    #[serde(rename = "type")]
    pub input_type: String,
    /// Widget-owned JSON value.
    pub value: Value,
}

/// Supported desktop commands for protocol version 2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    /// Lists installed widgets and their public opening contract.
    Discover,
    /// Creates a new runtime instance and native widget surface.
    Open {
        /// Installed widget identifier.
        widget_id: String,
        /// Explicit widget variant identifier.
        variant_id: String,
        /// Supplied option values. Manifest defaults fill omitted options.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        options: BTreeMap<String, Value>,
        /// Complete direct typed-input map.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        inputs: BTreeMap<String, DirectInput>,
        /// Initial frontend presentation.
        #[serde(default, skip_serializing_if = "is_focus")]
        presentation: Presentation,
    },
    /// Changes mutable fields on one explicit surface.
    Update {
        /// Surface identifier returned by `Open`.
        surface_id: String,
        /// Replacement direct-input map. Omission retains current inputs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inputs: Option<BTreeMap<String, DirectInput>>,
        /// Replacement presentation. Omission retains the current value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
    },
    /// Returns every currently open surface.
    List,
    /// Requests native focus for one surface.
    Focus {
        /// Surface identifier returned by `Open`.
        surface_id: String,
    },
    /// Closes one surface and deletes its runtime instance.
    Close {
        /// Surface identifier returned by `Open`.
        surface_id: String,
    },
    /// Shuts down the resident desktop service.
    Quit,
}

impl Command {
    /// Returns the stable wire name used in metadata-only audit records.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Discover => "discover",
            Self::Open { .. } => "open",
            Self::Update { .. } => "update",
            Self::List => "list",
            Self::Focus { .. } => "focus",
            Self::Close { .. } => "close",
            Self::Quit => "quit",
        }
    }
}

fn is_focus(presentation: &Presentation) -> bool {
    *presentation == Presentation::Focus
}

/// One versioned response returned after command completion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Wire protocol version used to encode the response.
    pub version: u32,
    /// Completed command outcome.
    #[serde(flatten)]
    pub outcome: Outcome,
}

impl Response {
    /// Creates a successful response with command-specific JSON data.
    pub fn ok(result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            outcome: Outcome::Ok { result },
        }
    }

    /// Creates a failed response with a stable code and safe user message.
    pub fn failed(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            outcome: Outcome::Failed {
                error: ErrorData {
                    code: code.into(),
                    message: message.into(),
                },
            },
        }
    }

    /// Returns the stable response status used by control logs.
    pub fn status(&self) -> &'static str {
        match self.outcome {
            Outcome::Ok { .. } => "ok",
            Outcome::Failed { .. } => "failed",
        }
    }

    /// Returns the failure code without exposing command payloads.
    pub fn error_code(&self) -> Option<&str> {
        match &self.outcome {
            Outcome::Ok { .. } => None,
            Outcome::Failed { error } => Some(&error.code),
        }
    }
}

/// Synchronous command result encoded through the `status` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    /// The requested operation completed.
    Ok {
        /// Command-specific result data.
        result: Value,
    },
    /// The requested operation did not complete.
    Failed {
        /// Stable failure details safe to return to the local client.
        error: ErrorData,
    },
}

/// Stable failure details returned to a control client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorData {
    /// Machine-readable error identifier.
    pub code: String,
    /// Concise message safe for local display.
    pub message: String,
}

/// Failure to read or write one bounded JSON-line control message.
#[derive(Debug, Error)]
pub enum MessageError {
    /// The peer closed the connection before sending data.
    #[error("control message is empty")]
    Empty,
    /// The encoded message exceeded `MAX_MESSAGE_BYTES`.
    #[error("control message exceeds {MAX_MESSAGE_BYTES} bytes")]
    TooLarge,
    /// The peer did not terminate its message with one LF byte.
    #[error("control message must end with LF")]
    MissingTerminator,
    /// The bounded line was not valid JSON for the requested type.
    #[error("control message is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    /// The underlying local transport failed.
    #[error("control transport failed: {0}")]
    Io(#[from] io::Error),
}

/// Reads and decodes one bounded LF-terminated JSON message.
pub fn read_message<T: for<'de> Deserialize<'de>>(
    reader: &mut impl BufRead,
) -> Result<T, MessageError> {
    let mut bytes = Vec::new();
    let mut limited = std::io::Read::take(reader, (MAX_MESSAGE_BYTES + 1) as u64);
    limited.read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Err(MessageError::Empty);
    }
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(MessageError::TooLarge);
    }
    if bytes.pop() != Some(b'\n') {
        return Err(MessageError::MissingTerminator);
    }
    if bytes.last() == Some(&b'\r') {
        return Err(MessageError::MissingTerminator);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// Encodes and writes one bounded LF-terminated JSON message.
pub fn write_message<T: Serialize>(
    writer: &mut impl Write,
    message: &T,
) -> Result<(), MessageError> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() + 1 > MAX_MESSAGE_BYTES {
        return Err(MessageError::TooLarge);
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;

    use super::*;

    #[test]
    fn request_round_trips_as_one_json_line() {
        let request = Request {
            version: PROTOCOL_VERSION,
            command: Command::Open {
                widget_id: "cpu".into(),
                variant_id: "full".into(),
                options: BTreeMap::new(),
                inputs: BTreeMap::new(),
                presentation: Presentation::Focus,
            },
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &request).unwrap();
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            "{\"version\":2,\"command\":\"open\",\"widget_id\":\"cpu\",\"variant_id\":\"full\"}\n"
        );
        assert_eq!(
            read_message::<Request>(&mut Cursor::new(bytes)).unwrap(),
            request
        );
    }

    #[test]
    fn responses_use_named_statuses() {
        assert_eq!(
            serde_json::to_value(Response::ok(json!({ "surface_id": "surface-1" }))).unwrap(),
            json!({
                "version": 2,
                "status": "ok",
                "result": { "surface_id": "surface-1" }
            })
        );
        assert_eq!(
            serde_json::to_value(Response::failed("surface_not_found", "missing")).unwrap(),
            json!({
                "version": 2,
                "status": "failed",
                "error": { "code": "surface_not_found", "message": "missing" }
            })
        );
    }

    #[test]
    fn rejects_missing_lf_and_oversized_messages() {
        assert!(matches!(
            read_message::<Request>(&mut Cursor::new(b"{}")),
            Err(MessageError::MissingTerminator)
        ));
        let oversized = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        assert!(matches!(
            read_message::<Request>(&mut Cursor::new(oversized)),
            Err(MessageError::TooLarge)
        ));
    }
}
