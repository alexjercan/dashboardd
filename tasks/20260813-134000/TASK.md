# dashboardd HTTP service and static frontend

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboardd, http, frontend

# Scope

Implement the first dashboardd service slice:

- Serve the built frontend from `web/dist`.
- Bind to `DASHBOARDD_HOST`, defaulting to `127.0.0.1`.
- Use `DASHBOARDD_PORT` when set.
- Otherwise choose a free port in `7000-7999`.
- Log the final listening URL.
- Add `GET /health`.
- Serve `/` and static assets.
- Return a useful error when `web/dist` is missing.
- Shut down cleanly on Ctrl-C.

# Design constraints

- Use environment variables with localhost defaults.
- Keep the first slice HTTP-only.
- Do not add WebSockets, polling, widget discovery, layout persistence, or the widget protocol.
- Create a separate transport task after this slice.

# Verification

- Run Rust formatting and workspace checks through Nix.
- Build the frontend before serving it.
- Exercise `/health` and `/` against a running dashboardd process.

# Implementation

- Added Axum and Tokio HTTP serving in `crates/dashboardd`.
- Added `DASHBOARDD_HOST` and `DASHBOARDD_PORT` configuration.
- Automatic ports use a shuffled `7000..8000` range and retain the bound listener.
- Added static `web/dist` serving and `GET /health`.
- Added structured startup and shutdown logs.
- Added graceful Ctrl-C shutdown.
- Missing `web/dist` returns an actionable startup error.
- Logging defaults to `info`; `RUST_LOG` can override the filter.

# Verification

- Nightly `cargo fmt --check` passes.
- Nightly `cargo check --workspace` passes.
- `npm run build` passes.
- `npm run format:check` passes.
- Live checks pass for a random `7000..7999` port and explicit port `8000`.
- Live checks pass for `/health`, `/`, and SIGINT shutdown.
