//! Public protocol types for consumers that prefer a compact import surface.

pub use crate::{
    DashboardToServer, Envelope, ErrorData, InstanceId, PROTOCOL_VERSION, ProtocolError, RequestId,
    ServerToDashboard, ServerToWidget, WidgetDescriptor, WidgetId, WidgetToServer, message, parse,
    serialize,
};
