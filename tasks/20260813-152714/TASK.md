# Connect dashboard UI to WebSocket handshake

- STATUS: IN_PROGRESS
- PRIORITY: 100
- TAGS: dashboardd, websocket, frontend

# Scope

Connect the browser dashboard to the dashboardd WebSocket handshake.

# Accepted design

- Keep protocol types hand-maintained in TypeScript.
- Use a same-origin `/ws` URL with `ws` or `wss` selected from the page protocol.
- Send `hello` with protocol version `1`.
- Render connection status for connecting, connected, disconnected, and error states.
- Do not add reconnect logic, widget discovery, or widget instances yet.

# Verification

- Build the Webpack frontend.
- Format-check the frontend.
- Serve the built UI through dashboardd.
- Exercise the WebSocket handshake from a browser-like client.

# Implementation

- Added hand-maintained TypeScript protocol types and envelope helpers.
- Added same-origin WebSocket connection setup in `web/src/dashboard.ts`.
- Added `hello` transmission and `ready`/error handling.
- Added visible connection status to the dashboard page.
- Added exact protocol-version validation for server messages.

# Verification

- `npm run build` passes.
- `npm run format:check` passes.
- Rust dashboardd and protocol tests pass.
- Workspace checks pass.
- The existing live WebSocket client verified the `/ws` handshake.
