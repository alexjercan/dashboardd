# Add basic CPU widget vertical slice

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, cpu, dashboardd

# Scope

Add the first real CPU widget as an end-to-end vertical slice.

# Accepted design

- Use `widgets/cpu` as a Rust workspace member.
- Use `sysinfo` for cross-platform CPU sampling.
- Discover widgets from `widgets/*/widget.json`.
- Use a minimal manifest with `id`, `name`, and `backend`.
- Dashboardd owns backend process startup and routing.
- Have the dashboard automatically request one CPU instance after discovery.
- Stream one CPU update per second.
- Render CPU data in a dashboard-owned temporary card.
- Defer dynamic frontend modules, layout persistence, multiple instances, and restart policy.

# Protocol flow

- Dashboard requests widget discovery after the handshake.
- Server returns widget descriptors and the dashboard requests CPU instance creation.
- Server starts the CPU backend and sends `initialize`.
- Backend sends `ready` and periodic `update` messages.
- Server forwards CPU updates to the dashboard.

# Verification

- Test manifest discovery.
- Test CPU sampling output.
- Test backend protocol handling.
- Test the dashboardd CPU flow.
- Run Rust and frontend checks.

# Implementation

- Added `widgets/cpu` as a Rust workspace member using `sysinfo`.
- Added `widgets/cpu/widget.json` and manifest discovery in dashboardd.
- Added JSON-lines backend startup, initialization, update forwarding, and cleanup.
- Added `list_widgets` and `create_instance` handling for one instance per browser session.
- Added browser discovery, CPU instance creation, and a temporary CPU usage card.
- Kept widget-specific CPU payload handling out of dashboardd.

# Verification

- `cargo test -p cpu` passes: 1 test.
- `cargo test -p dashboardd` passes: 4 tests.
- `cargo test -p dashboard-protocol` passes: 10 tests.
- `cargo check --workspace` passes.
- `npm run build` and `npm run format:check` pass.
- Live vertical slice passed: discover CPU, create instance, spawn backend, and receive numeric CPU usage.
