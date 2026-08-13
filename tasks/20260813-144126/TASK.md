# Add dashboardd WebSocket handshake

- STATUS: IN_PROGRESS
- PRIORITY: 100
- TAGS: dashboardd, websocket, protocol

# Scope

Add the first dashboardd consumer of `dashboard-protocol`.

# Behavior

- Add `GET /ws` with an Axum WebSocket upgrade.
- Parse versioned `Envelope<DashboardToServer>` messages.
- Require protocol version `1`.
- Require `hello` before other dashboard messages.
- Reply to a valid hello with versioned `ready`.
- Reply to malformed, unsupported, or out-of-order messages with versioned errors.
- Keep widget discovery and instance management out of scope.

# Verification

- Test valid hello produces ready.
- Test unsupported versions produce an error.
- Test messages before hello produce an error.
- Keep existing HTTP and workspace checks passing.

# Implementation

- Added Axum WebSocket support at `/ws`.
- Added versioned JSON request parsing and response serialization.
- Added `hello -> ready` handshake handling.
- Added errors for unsupported versions, invalid messages, missing handshakes, and unimplemented messages.
- Added generic protocol `parse<T>` and `serialize<T>` helpers.
- Added typed `ProtocolError` parsing failures and shared `ErrorData`.
- Replaced boolean handshake state with `SessionState`.
- Made session handling a consuming state transition returning `(next_state, response)`.
- Added two handshake state-machine tests.

# Verification

- `cargo fmt --check` passes.
- `cargo test -p dashboardd` passes: 2 tests.
- `cargo test -p dashboard-protocol` passes: 10 tests.
- `cargo check --workspace` passes.
- Live WebSocket client verified `/ws` upgrade and `hello -> ready` response.
