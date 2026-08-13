# Build tested TypeScript widget frontend platform

- STATUS: IMPLEMENTED
- PRIORITY: 100
- TAGS: frontend, widget, sdk, testing, tooling

# Goal

Build a tested frontend platform for independently packaged TypeScript widgets. Share the host/widget contract and theme tokens, preserve Shadow DOM isolation, and separate source manifests from generated runtime manifests.

# Current repository state

The backend HTTP/SSE architecture is committed:

- `67545c4 Replace dashboard WebSocket with HTTP and SSE`
- `9b78f14 Move widget runtime into instance manager`

Backend boundaries:

- `crates/dashboardd/src/widget.rs` owns filesystem discovery and validated widget configuration.
- `crates/dashboardd/src/instance.rs` owns running instances and backend process lifecycle.
- `crates/dashboardd/src/api.rs` owns HTTP resources, SSE route, and Swagger.
- `crates/dashboardd/src/event.rs` owns versioned dashboard SSE events.
- `crates/dashboard-protocol` is limited to dashboardd/widget backend JSON-lines IPC.

Available browser API:

```text
GET    /api/v1/widgets
GET    /api/v1/widgets/{widget_id}
GET    /api/v1/instances
GET    /api/v1/instances/{instance_id}
POST   /api/v1/instances
PATCH  /api/v1/instances/{instance_id}
DELETE /api/v1/instances/{instance_id}
POST   /api/v1/instances/{instance_id}/messages
GET    /api/v1/events
```

Swagger:

```text
/docs
/api-docs/openapi.json
```

# Browser migration prerequisite

The browser HTTP/SSE migration is committed as:

```text
52fe57c fix: migrate web ui to SSE+HTTP
```

It replaced the obsolete browser WebSocket client with:

- `EventSource("/api/v1/events")` for events.
- `fetch` for widgets, instances, and widget commands.
- HTTP reconciliation after each SSE connection or reconnection.
- Hardcoded creation of one CPU instance when absent.
- `409 Conflict` handling by refetching instances.
- Server-owned instance survival after browser disconnect.
- Instance create, update, destroy, error, and widget update handling.
- Runtime validation of HTTP resources and SSE event envelopes.

Verification already completed for this migration:

- `cd web && npm run format:check && npm run build` passes.
- No `WebSocket`, `/ws`, `DashboardToServer`, or `ServerToDashboard` references remain under `web/src`.
- Real headless Chromium flow passes:
  - SSE connects.
  - UI creates `cpu-1` through HTTP.
  - CPU frontend module mounts.
  - Live CPU percentage replaces `--.-%`.
  - `cpu-1` remains after Chromium exits.

# Accepted architecture

## Browser integration tests

Use `playwright-core` with system Chromium from Nix. Do not download Playwright browsers.

Real test path:

```text
Chromium -> dashboard UI -> HTTP/SSE -> dashboardd -> CPU backend
```

Harness requirements:

- Build dashboardd, CPU backend, dashboard web, and widget frontend.
- Reserve a test port.
- Start dashboardd and record its PID.
- Wait for `/health`.
- Use the Nix/system Chromium executable.
- Stop dashboardd by recorded PID. Never use `pkill -f`.
- Preserve dashboardd logs and browser artifacts on failure.
- Prefer Playwright waiting assertions over arbitrary sleeps.

Initial browser scenarios:

1. Empty server state:
   - Open dashboard SSE.
   - Fetch widgets and instances.
   - Create one CPU instance.
   - Mount CPU frontend.
   - CPU usage changes from `--.-%`.
2. Browser refresh:
   - Keep the same server-owned instance.
   - Mount it again.
   - Do not create another backend.
3. Two browser pages:
   - Both show the same instance.
   - Server has only one CPU instance.
4. Instance deletion:
   - Delete through HTTP.
   - SSE removes the mounted widget from all pages.
5. SSE reconnect:
   - Interrupt and restore browser network access.
   - EventSource reconnects.
   - HTTP reconciliation restores authoritative instance state.

Optional fast client tests can use Vitest with mocked `fetch` and `EventSource` for:

- `409` creation race and refetch.
- Malformed SSE event handling.
- Serialized reconnect reconciliation.
- API error message extraction.

Test the client service as a whole. Avoid low-value isolated parser tests when browser integration covers the behavior.

## Root npm workspace

Use one root npm workspace instead of an independent dependency graph per widget.

Target layout:

```text
package.json
package-lock.json
packages/
  widget-sdk/
web/
  package.json
widgets/cpu/frontend/
  package.json
  tsconfig.json
  webpack.config.js
  src/
    index.ts
    styles.css
```

Keep npm. Do not add another package manager.

Expected commands:

```bash
npm run build
npm run test
npm run build -w @scufris/cpu-widget
npm run watch -w @scufris/cpu-widget
```

## Widget SDK

The SDK is shared by the dashboard host and widget frontends.

Start as a small package with shared types and module validation:

```ts
export interface WidgetContext {
  widgetId: string;
  instanceId: string;
  send(payload: unknown): Promise<void>;
}

export interface WidgetFrontend {
  update(payload: unknown): void;
  destroy(): void;
}

export interface WidgetModule {
  mount(
    container: HTMLElement,
    context: WidgetContext,
  ): WidgetFrontend;
}

export function isWidgetModule(value: unknown): value is WidgetModule;
```

The dashboard imports host-side types and validates dynamic imports. Widgets import the same contract.

Do not put these in the SDK:

- Dashboard state management.
- HTTP or SSE client code.
- CPU payload types.
- Layout policy.
- Widget-specific components.

Add runtime helpers only after a second widget proves repetition.

## Theme and CSS contract

Use public `--scufris-*` CSS custom properties. Replace current internal `--dashboard-*` names.

Initial public tokens:

```text
--scufris-color-canvas
--scufris-color-surface
--scufris-color-selection
--scufris-color-text
--scufris-color-text-bright
--scufris-color-text-muted
--scufris-color-text-dim
--scufris-color-accent
--scufris-color-border
--scufris-color-success
--scufris-color-danger
--scufris-color-secondary
--scufris-font-sans
--scufris-font-mono
--scufris-radius-widget
```

The SDK exports default Gruber Darker values:

```text
@scufris/widget-sdk/theme.css
```

The dashboard imports this once and owns the active theme. CSS custom properties inherit through Shadow DOM. Widgets consume inherited tokens and must not inject host theme defaults at dashboard runtime.

The SDK may export a minimal optional widget reset:

```text
@scufris/widget-sdk/widget.css
```

Keep this small, for example:

```css
:host {
  display: block;
  min-width: 0;
  color: var(--scufris-color-text);
  font-family: var(--scufris-font-mono);
}

* {
  box-sizing: border-box;
}
```

Do not commit to a large shared class or component system yet.

Ownership:

- Dashboard owns grid, widget outer frame, card border, background, radius, shadow, focus, and responsive sizing.
- Widget owns internal graph, core squares, telemetry typography, fill animation, and internal responsive behavior.
- Widgets retain Shadow DOM for isolation.
- Host global class selectors are not a public widget API.
- Tailwind utility classes are not a runtime widget API.

Recommended host structure:

```html
<section class="dashboard-widget" data-instance-id="cpu-1">
  <div class="dashboard-widget-mount"></div>
</section>
```

Mount the widget Shadow DOM inside `.dashboard-widget-mount`.

## TypeScript CPU frontend

Replace `widgets/cpu/frontend.js` with a small TypeScript/Webpack workspace.

Webpack output:

```text
widgets/cpu/frontend/dist/frontend.js
```

Requirements:

- TypeScript entry point.
- Browser ESM output.
- Stable `frontend.js` filename.
- No runtime chunk.
- CSS bundled into the widget module or injected into its Shadow DOM.
- Development source maps.
- Production minification.
- Watch mode.
- SDK types and theme tokens.

Preserve current behavior and compact design:

- 60-second CPU graph.
- One-line load averages.
- 6x4 grid for 24 logical cores.
- Fixed 38 px core squares.
- Bottom-up usage fill.
- Temperature only in each square.
- Core ID, usage, frequency, and temperature in tooltip.
- Green/yellow/red usage thresholds.
- Gruber Darker visual language through public theme tokens.

Dashboardd should send `Cache-Control: no-cache` for widget frontend modules during the PoC so browser refresh picks up a rebuilt bundle.

Webpack watch plus browser refresh is sufficient initially. Do not add HMR unless it becomes a separate accepted slice.

## Source and runtime manifests

The checked-in source manifest must not point to `target/` or `dist/` artifacts.

Use separate concepts.

Canonical source manifest:

```toml
# widgets/cpu/widget.toml
id = "cpu"
name = "CPU"

[backend]
package = "cpu"

[frontend]
workspace = "@scufris/cpu-widget"
entry = "src/index.ts"
```

Generated runtime manifest:

```json
{
  "schema_version": 1,
  "id": "cpu",
  "name": "CPU",
  "backend": "bin/cpu",
  "frontend": "frontend/frontend.js"
}
```

Generated runtime bundle:

```text
.build/widgets/cpu/
  widget.json
  bin/
    cpu
  frontend/
    frontend.js
```

Dashboardd continues to discover runtime manifests only. It must not interpret Cargo or npm source metadata.

Development generation may symlink `.build/widgets/cpu/bin/cpu` to `target/debug/cpu`. Packaging copies artifacts.

Add a Rust repository tool, preferably an `xtask` workspace member:

```bash
cargo xtask widget prepare cpu
cargo xtask widget prepare --all
```

Responsibilities:

- Parse `widget.toml`.
- Validate IDs and package/workspace names.
- Build or locate backend artifacts.
- Build the frontend npm workspace.
- Generate `.build/widgets/<id>/widget.json`.
- Symlink artifacts for development.
- Copy artifacts for packaging.
- Verify generated runtime paths exist.

Make the widget runtime root configurable, for example:

```text
DASHBOARDD_WIDGETS_DIR=.build/widgets
```

A later convenience command can prepare widgets, build the dashboard, and start dashboardd. Do not couple dashboardd itself to Cargo or npm layouts.

# Slice plan

## Slice 1 - Browser integration tests

- Use the committed HTTP/SSE browser migration as the integration baseline.
- Add root-level browser test harness using `playwright-core` and Nix Chromium.
- Cover create, telemetry, refresh, shared instance, deletion, and reconnect.
- Preserve logs and artifacts on failure.
- Keep current plain JavaScript CPU frontend unchanged.

## Slice 2 - Root npm workspace and widget SDK

- Convert existing `web` package into a root npm workspace.
- Add `packages/widget-sdk`.
- Share frontend lifecycle types and dynamic module validation.
- Add public `--scufris-*` Gruber theme tokens.
- Add only a minimal optional widget reset.
- Keep behavior unchanged and run Slice 1 tests.

## Slice 3 - TypeScript CPU frontend

- Move CPU frontend into its TypeScript/Webpack workspace.
- Emit one ESM bundle.
- Use SDK types and inherited theme tokens.
- Add build and watch commands.
- Update the temporary runtime manifest path as needed.
- Add no-cache widget module response.
- Run Slice 1 tests unchanged.

## Slice 4 - Shared visual contract

- Move outer card/frame styling into the dashboard host.
- Keep CPU internals in Shadow DOM.
- Remove duplicate widget card chrome.
- Add wide and narrow visual screenshots or assertions.
- Verify a 3x2 desktop dashboard layout.

## Slice 5 - Source and runtime manifests

- Add `widget.toml` source manifests.
- Add `xtask` generator.
- Generate runtime bundles under `.build/widgets`.
- Add configurable dashboardd widget root.
- Remove checked-in source references to `target/` and `dist/`.
- Update development documentation and Nix checks.

# Constraints

- Use Gruber Darker semantic colors.
- Preserve generic widget frontend loading.
- Keep widget backends as separate Rust processes using versioned JSON-lines IPC.
- HTTP state is authoritative. SSE carries notifications and telemetry.
- Instances remain dashboardd-owned and survive browser refresh.
- Widgets remain read-only definitions. Instances have CRUD operations.
- Keep the PoC hardcoded to ensure one CPU instance when absent.
- Do not add persistence, movement, resizing, or multiple instances in these slices unless separately accepted.
- Do not commit without review and approval.

# Verification per slice

Use the cheapest focused checks during implementation. Before each approved commit, run affected CI-equivalent checks.

Expected final checks:

```bash
nix develop --command bash -lc 'cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings'
npm run format:check
npm run build
npm run test
nix flake check
```

Also run real browser integration tests against dashboardd and the CPU backend.

# Reflection

- The current real headless Chromium script proved the end-to-end flow but hung when `--dump-dom` waited on the persistent SSE connection. Use Playwright/CDP-style assertions and explicit process cleanup instead.
- CSS custom properties cross Shadow DOM boundaries; normal host class selectors do not.
- Keep the SDK contract small until a second widget proves reusable runtime behavior.
- Establish actual frontend build metadata before implementing source/runtime manifest generation.

# Implementation

- Added a root npm workspace for the dashboard, widget SDK, and CPU frontend.
- Added the shared lifecycle contract, dynamic module validation, public theme tokens, and minimal widget reset.
- Replaced the CPU JavaScript module with a typed, single-file ESM Webpack build.
- Moved widget frame ownership to the dashboard while retaining widget Shadow DOM isolation.
- Added wide, narrow, 3x2 grid, lifecycle, deletion, and reconnect browser coverage with system Chromium.
- Added canonical TOML source manifests and `cargo xtask widget prepare` development and packaging bundles.
- Made the runtime widget root configurable and added no-cache frontend responses.
- Updated Nix development tooling and development documentation.

# Implementation reflection

- Raw CSS module imports let each widget inject only its internal CSS into its Shadow DOM. The dashboard imports theme defaults once.
- Runtime manifests now validate their schema and both artifact paths. Source build metadata remains outside dashboardd.
- The browser harness owns dashboardd by recorded PID and keeps logs and screenshots after failures.
- The hardcoded single-instance PoC cannot render six real instances. The layout test inserts temporary host frames to verify the accepted 3x2 host grid without changing backend constraints.

# Verification results

- Rust formatting, 18 workspace tests, and Clippy with warnings denied pass.
- Root npm formatting and both production Webpack builds pass.
- Browser integration passes create, telemetry, refresh, shared instance, deletion, real network interruption/reconnect, responsive layout, 3x2 grid, and no-cache checks.
- Development symlink and packaging copy modes both produce valid runtime bundles.
- `nix flake check path:$PWD` passes, including the new xtask package and Clippy check.

# Follow-up fixes

- Fixed the initial creation race where `instance_created` could arrive before widget descriptors. Instances now wait for reconciliation instead of showing a false missing-descriptor error.
- Added info logs for discovery, event streams, instance lifecycle, backend startup/readiness/shutdown, and failures.
- Added debug logs for HTTP requests, frontend serving, backend commands, and telemetry.
- Added browser console logs for SSE state, reconciliation, events, and widget mounts.
- Fixed Ctrl+C shutdown with active SSE clients by closing event streams before Axum drains connections.
- Bounded backend shutdown to three seconds, then aborts the owning task so `kill_on_drop` terminates an unresponsive child.
- Added a browser integration assertion that dashboardd exits after SIGINT while SSE pages remain connected.
- Fixed a 15-second initial-load delay by flushing an immediate SSE comment. EventSource previously emitted `open` only after the first keep-alive body bytes arrived.
- Put widget backends in separate Unix process groups so terminal Ctrl+C reaches dashboardd, which then performs the protocol shutdown, instead of signaling children directly.
- Added integration limits for initial widget mount time and clean shutdown with a live backend.
