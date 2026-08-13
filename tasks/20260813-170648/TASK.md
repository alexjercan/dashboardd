# Replace dashboard WebSocket with HTTP and SSE

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboardd, http, sse, protocol

# Scope

Replace the browser WebSocket proof of concept with an HTTP control plane and server-sent event stream.

# Accepted design

- Remove the browser WebSocket route and protocol without compatibility support.
- Keep widget definitions read-only through `GET /api/v1/widgets` and `GET /api/v1/widgets/{widget_id}`.
- Give dashboardd-owned global instances HTTP CRUD routes under `/api/v1/instances`.
- Add `POST /api/v1/instances/{instance_id}/messages` for widget commands.
- Store canonical instance layout in dashboardd as `column`, `row`, `width`, and `height`.
- Keep instance and layout state in memory for this PoC.
- Use `GET /api/v1/events` as a server-to-browser SSE stream.
- Keep versioned envelopes for SSE events and widget JSON-lines messages.
- Use unversioned JSON resources under the versioned `/api/v1` path.
- Publish `instance_created`, `instance_updated`, `instance_destroyed`, `instance_error`, and `widget_update` events.
- Treat HTTP instance state as authoritative; reconcile after SSE connection and reconnection.
- Do not add event replay or `Last-Event-ID` support for ephemeral telemetry.
- Hardcode the PoC dashboard to create one CPU instance when none exists.
- Return `409 Conflict` if concurrent clients try to create a second CPU instance.
- Keep widget backend JSON-lines transport unchanged.
- Implement only the backend API, instance manager, SSE stream, and protocol cleanup in this slice.
- Allow the existing browser frontend to break; migrate it in the next slice.
- Generate OpenAPI from Rust types with `utoipa`.
- Serve Swagger UI at `/docs` and the raw specification at `/api-docs/openapi.json`.
- Document SSE as `text/event-stream` with a `curl -N` usage note.
- Keep `dashboard-protocol` limited to versioned widget backend JSON-lines messages.
- Keep dashboard HTTP resources, SSE events, event versioning, and OpenAPI schemas in dashboardd.
- Compose `AppState` from an immutable `WidgetsManager` and mutable `InstanceManager`.
- Have `WidgetsManager` own discovery, validation, lookup, and `WidgetConfig` values.
- Have the HTTP create handler resolve a widget ID before calling `InstanceManager::create(Arc<WidgetConfig>)`.
- Do not store widget definitions in `InstanceManager` or pass a separate widget ID beside its config.
- Keep `ApiJson<T>` for transport-level JSON validation and consistent JSON errors.

# Verification

- Test widget and instance HTTP resources.
- Test instance CRUD and widget command routing.
- Test SSE event serialization and delivery.
- Test live CPU updates through SSE.
- Verify the server-owned CPU instance remains after event clients disconnect.
- Verify Swagger UI and the raw OpenAPI document.
- Run focused Rust checks before review.
- Defer browser checks until its HTTP/SSE migration.

# Implementation

- Reduced `dashboard-protocol` to versioned widget backend JSON-lines messages.
- Added dashboardd-owned HTTP resources and independently versioned `DashboardEvent` SSE messages.
- Added `WidgetsManager` for immutable discovery, validation, lookup, and validated `WidgetConfig` ownership.
- Added a global in-memory `InstanceManager` with list, get, create, update, delete, message, and shutdown operations.
- Kept widget definitions out of `InstanceManager`; HTTP creation resolves an ID and passes `Arc<WidgetConfig>`.
- Composed `AppState` from only `WidgetsManager` and `InstanceManager`.
- Added all accepted `/api/v1/widgets`, `/api/v1/instances`, and `/api/v1/events` routes.
- Added consistent JSON API errors, including malformed request bodies.
- Added backend lifecycle, command routing, graceful shutdown, and broadcast event publication.
- Removed the dashboardd WebSocket route and Axum WebSocket feature.
- Added generated OpenAPI and Swagger UI at `/docs` with vendored assets for pure Nix builds.
- Left the browser WebSocket client unchanged and intentionally broken for the next slice.

# Review corrections

- Split immutable installed-widget ownership from mutable instance ownership.
- Move dashboard HTTP and SSE types out of `dashboard-protocol`.
- Give SSE an independent versioned envelope in dashboardd.
- Remove OpenAPI dependencies and derives from the widget protocol crate.

# Verification results

- Widget protocol tests pass: 6.
- Dashboardd tests pass: 9.
- CPU backend tests pass: 3.
- Focused Clippy passes with warnings denied.
- Live API flow passes after the ownership refactor for widget discovery, instance CRUD, duplicate conflict, widget commands, and consistent statuses.
- SSE receives instance creation, update, destruction, and live CPU telemetry.
- An instance remains alive after its SSE client disconnects.
- Swagger UI and `/api-docs/openapi.json` load successfully.
- Full workspace tests and Clippy pass.
- `nix flake check` passes.
- Browser checks were not run by design.
