//! Public widget protocol types for consumers that prefer a compact import surface.

pub use crate::{
    Envelope, ErrorData, InstanceId, PROTOCOL_VERSION, ProtocolError, ServerToWidget, WidgetId,
    WidgetToServer, message, parse, serialize,
};
