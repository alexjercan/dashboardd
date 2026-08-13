# Define dashboard protocol crate

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: protocol, rust, architecture

# Scope

Create the shared `dashboard-protocol` crate.

# Accepted terminology

- `DashboardToServer`: browser dashboard to `dashboardd`.
- `ServerToDashboard`: `dashboardd` to browser dashboard.
- `WidgetToServer`: widget backend process to `dashboardd`.
- `ServerToWidget`: `dashboardd` to widget backend process.

# Accepted wire format

- Every JSON message is an envelope with `version`, `kind`, and `data` fields.
- `kind` uses snake-case names.
- Protocol version starts at `1`.
- Widget payloads use arbitrary JSON values.
- Unit messages use an empty `data` object.
- The envelope version is the only protocol version field.
- Request IDs are opaque strings and are optional on server errors.
- Unknown JSON fields are ignored for forward compatibility.

# Initial messages

## DashboardToServer

- `hello {}`
- `list_widgets { request_id }`
- `create_instance { request_id, widget_id }`
- `destroy_instance { request_id, instance_id }`
- `widget_message { instance_id, payload }`

## ServerToDashboard

- `ready {}`
- `widgets { request_id, widgets }`
- `instance_created { request_id, instance_id, widget_id }`
- `instance_destroyed { request_id, instance_id }`
- `widget_message { instance_id, payload }`
- `error { request_id, code, message }`

## WidgetToServer

- `ready { widget_id }`
- `update { instance_id, payload }`
- `error { instance_id, code, message }`

## ServerToWidget

- `initialize { instance_id, widget_id }`
- `message { instance_id, payload }`
- `shutdown`

# Verification

- Test exact JSON serialization for representative messages.
- Test deserialization and arbitrary payload round-trips.
- Test unknown fields are accepted.
- Test unknown message types and missing required fields fail.

# Implementation

- Added `crates/dashboard-protocol` to the Cargo workspace.
- Added serde-based direction-specific kind enums for dashboard, server, and widget messages.
- Added a generic versioned `Envelope<T>` for every wire message.
- Added shared opaque ID aliases and `WidgetDescriptor`.
- Added protocol version constant `PROTOCOL_VERSION = 1`.
- Added public prelude exports.
- Added `message<T>` to wrap messages with the current protocol version.
- Added eight wire-contract tests.

# Verification

- `cargo fmt --check` passes.
- `cargo test -p dashboard-protocol` passes: 8 tests.
- `cargo check --workspace` passes.
