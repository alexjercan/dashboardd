# Build desktop-hosted standalone widget surfaces

- STATUS: IN_PROGRESS
- PRIORITY: 100
- TAGS: desktop, tauri, runtime, widgets, surface, nix

## Goal

Build the dashboardd-side runtime, standalone surface, and resident Tauri desktop service needed to open live widget windows through a same-user local control API.

## Source design

- Parent research task: `20260818-222337`.
- Follow its accepted runtime, input, desktop lifecycle, Unix socket, logging, and window semantics.
- This task implements dashboardd components only. The Pi assistant and delegated-agent orchestrator belong in a separate repository.

## Architecture correction after Step 5

Accepted correction:

- `dashboardd-runtime` is a transport-free Rust library. It owns widget discovery, instance lifecycle, inputs, health, events, theme configuration, and shared state through direct typed methods. Remove Axum, OpenAPI, static web assets, and `web_dir` from it.
- `dashboardd-server` exclusively owns the Axum HTTP API, HTTP DTO and error mapping, SSE versioning and serialization, OpenAPI, and Dashboard browser assets.
- Remove the browser `/surface/{instance_id}` route and its HTTP standalone host. The Dashboard web application does not use it.
- `dashboardd-desktop` will own the standalone surface HTML, CSS, and JavaScript. Its webviews use narrow typed Tauri commands and events to call the embedded runtime directly. It does not start an HTTP listener or depend on `dashboardd-server`.
- The previous Step 5 HTTP surface implementation is superseded. Preserve only behavior that moves into the later native desktop surface host.

## Steps

### 1. Build the resident desktop lifecycle slice

- Add retained `dashboardd-desktop` and `dashboardd-desktop-control` crates. Keep all versioned wire types, size limits, encoding rules, and the `dashboardctl` binary in the small shared control crate; the Tauri service depends on its library.
- Start hidden with a system tray item and remain resident with no windows.
- Implement the same-user Unix socket, bounded versioned JSON request protocol, metadata-only JSONL audit log, and static local demo windows.
- Add `open-demo`, `list`, `focus`, and `close` commands.
- Create normal decorated and resizable 720x480 logical-pixel demo windows. Use Tauri's stable process-wide X11 class `dashboardd-desktop`; its per-window `window_classname` API is Windows-only. Do not use unsafe GTK hooks, force floating, or enable always-on-top behavior. Let i3 own placement, workspaces, and floating rules.
- Verify tray Quit closes windows, stops the socket server, removes the socket, and exits under X11 and i3.
- Keep this slice free of real widgets, runtime extraction, systemd units, and Nix deployment.

Completion gate: `dashboardctl open-demo` creates a controllable Tauri window while the tray service remains resident.

Step status: COMPLETE.

### 2. Extract `dashboardd-runtime`

- Move widget discovery, instance lifecycle, backend supervision, events, health, and shared state into a reusable transport-free Rust library. The later architecture correction moves the preserved HTTP API to `dashboardd-server`.
- Keep `dashboardd` as the browser service binary.
- Preserve existing browser behavior and checks during extraction.

Completion gate: the current browser dashboard and integration tests pass against the extracted runtime.

Step status: COMPLETE.

### 3. Decouple runtime instances from Dashboard composition

- Provide global memory-only instance CRUD.
- Remove dashboard identity, layout, links, window identity, and ownership from runtime instances and events.
- Move Dashboard documents, layout, navigation, and link graphs into browser-local storage.
- Reconcile and recreate browser-owned instances after runtime restart.

Completion gate: separate browsers can keep different local Dashboard compositions against one runtime.

Step status: COMPLETE.

### 4. Add typed direct widget inputs

Accepted contract:

- Represent each direct input as `{ "type": "<manifest-type>", "value": <opaque-json> }`, keyed by input port ID on runtime instances and creation requests.
- Replace the complete direct-input map atomically with `PUT /api/v1/instances/{instance_id}/inputs`. Advance runtime events to version 3 and publish the complete map through `instance_inputs_updated` events.
- Runtime validates port existence, variant applicability, and exact manifest type. Keep values opaque and enforce the existing request size bound.
- Hosts validate required bindings because only a host knows both direct values and dynamic links.
- Persist direct inputs on browser-local Dashboard placements. Each applicable port has exactly one direct binding, dynamic Dashboard link, or no binding when optional. Reconcile changed direct inputs without recreating the runtime instance.
- Replace SDK `links` with `inputs.get`, `inputs.subscribe`, and `outputs.publish`. Missing or removed effective values are `undefined`. Keep inputs as frontend capabilities; do not change the widget backend protocol.
- Dashboard input controls provide Unbound, Direct JSON, and compatible widget-output choices.

- Add versioned typed input envelopes to instance creation and update.
- Validate port existence, variant applicability, required bindings, and exact manifest type while leaving opaque JSON value validation to the widget.
- Publish input updates through instance events.
- Split the frontend SDK into `inputs.get`, `inputs.subscribe`, and `outputs.publish` capabilities.
- Adapt Dashboard-local links to the new SDK contract with exactly one direct or dynamic binding per input.

Completion gate: a widget receives and updates a direct typed input without a source widget.

Step status: COMPLETE.

### 5. Add the standalone surface host

Accepted contract:

- Serve a dedicated standalone host at `/surface/{instance_id}` using separate `surface.html`, `surface.js`, and `surface.css` build outputs.
- Attach to exactly one existing runtime instance. The surface never creates or deletes it. The caller owns instance lifetime; unload destroys only the frontend and subscriptions.
- Load the instance, widget descriptor and frontend, theme, health, and shared state. Subscribe to runtime event protocol version 3 for backend updates, direct inputs, health, shared state, theme, and instance deletion.
- Provide direct SDK inputs, no-op outputs, shared state, and backend messages. Exclude Dashboard storage, composition, navigation, links, and reconciliation.
- Accept `?presentation=focus|tile`, default to `focus`, and fail closed on invalid values.
- Show a compact Restart overlay only for degraded, stale, or failed health. Show a terminal unavailable state after instance deletion.

- Add `web/surface` to mount exactly one runtime instance.
- Support direct inputs, backend updates, health, presentation, and cleanup.
- Exclude Dashboard composition, navigation, layout, and links.

Completion gate: a browser-hosted standalone route displays one live CPU widget without a Dashboard document.

Step status: SUPERSEDED by the architecture correction and native desktop surface host.

### 6. Connect desktop windows to real widgets

Accepted contract:

- Embed and own `dashboardd-runtime` in `dashboardd-desktop`; do not provide an external-runtime mode or internal HTTP listener.
- Replace protocol version 1's demo command with protocol version 2 typed `discover`, `open`, `update`, `focus`, `list`, `close`, and `quit` commands. Do not retain `open-demo` compatibility.
- `discover` returns installed widget, variant, option, and input metadata without backend paths, frontend paths, or runtime data.
- `open` requires explicit widget and variant IDs. Options and direct typed inputs default to empty maps; presentation defaults to `focus`. Validate all required inputs before creating resources. Every open creates a generated surface ID, runtime instance, and native window.
- `update` requires an explicit surface ID. It can replace the complete direct-input map and change presentation. Omitted fields remain unchanged; reject an update with neither field. Options remain immutable.
- Use narrow Tauri commands scoped to the invoking webview for initialization, backend messages, restart, and shared-state mutation. Derive the surface from the invoking window label. Do not accept instance IDs, URLs, or paths from JavaScript. Send filtered runtime updates through one tagged, invoking-webview-scoped IPC channel.
- Serve each surface's exact runtime-validated frontend module through a read-only custom Tauri protocol. The protocol accepts a surface ID, not a path. Do not start an HTTP listener or grant broad filesystem access.
- Move the Dashboard frontend from top-level `web/` to `crates/dashboardd-server/frontend/`. Put the standalone TypeScript, HTML, and CSS under `crates/dashboardd-desktop/frontend/`. Keep shared widget APIs under `packages/widget-sdk`.
- Size initial windows from the manifest aspect ratio at 240 logical pixels per unit: `3x3 -> 720x720`, `3x2 -> 720x480`, and `3x1 -> 720x240`. Scale both dimensions proportionally when needed to fit a 1200x960 maximum. Keep windows ordinary, decorated, and resizable.
- Title windows `<widget name> - dashboardd`. Roll back the runtime instance if window creation fails. Native close deletes the instance. Quit deletes all instances, shuts down the embedded runtime, removes the socket, and exits.
- Use existing widget-path and theme-configuration environment inputs. Store desktop shared state separately through `DASHBOARDD_DESKTOP_STATE_FILE`, defaulting to `$XDG_STATE_HOME/dashboardd-desktop/runtime.json`.

Completion gate: `dashboardctl open cpu --variant full` opens a live 720x720 native CPU widget and later commands control it by surface ID.

Step status: COMPLETE.

### 7. Add direct Tatr Task Artifact surfaces

- Define direct project, worktree, task, and artifact reference inputs.
- Validate opaque identities and resolve the selected artifact without hidden Projects or Tasks widgets.
- Keep filesystem paths and sensitive values out of browser payloads and control logs.

Completion gate: `dashboardctl` can open a specific Tatr task artifact in a standalone native window.

### 8. Package the desktop service

- Add required Tauri Linux dependencies, tray assets, and Nix packages.
- Add optional `systemd --user` deployment through Nix for later actual use.
- Support explicit rofi-triggered startup and clean tray Quit without automatic restart.
- Keep automatic login startup disabled by default.

Completion gate: the packaged desktop service starts from rofi, accepts control requests, and exits completely from the tray.

## Excluded

- Pi assistant extension and delegated-agent orchestration.
- MCP or an unrestricted desktop command bridge.
- Implicit window reuse, semantic deduplication, or a `show` command.
- Cross-platform desktop support.
- Assistant-safe data-query APIs until their contract is designed.

## Verification

- Add focused Rust, TypeScript, protocol, SDK, browser, and packaging coverage with each step.
- Playtest tray lifecycle, window creation, focus, close, restart, stale socket handling, and multi-window behavior under X11 and i3.
- Review CPU and Tatr Artifact windows at practical wide and narrow sizes.
- Before final landing, run the repository formatting, workspace tests, Clippy with warnings denied, production builds, widget preparation, Chromium integration, documentation build, and Nix flake checks.

## Step 1 implementation notes

- Added `dashboardd-desktop` and `dashboardd-desktop-control` packages. The shared control package owns protocol version 1, 64 KiB JSON-line framing, command and response types, the session socket path, and the `dashboardctl` binary.
- Added a Clap-based client, hidden Tauri process, generated tray icon, Quit menu, UI-thread window dispatch, memory-only surface registry, static CSP-restricted demo asset, safe same-user stale-socket replacement, and metadata-only rotating audit log.
- Added Linux Tauri build and runtime libraries to the Nix development shell. `LD_LIBRARY_PATH` is required because the tray library loads AppIndicator dynamically.
- Kept windows ordinary, decorated, resizable, and WM-owned. Tauri exposes `window_classname` only on Windows, so i3 can match the stable process-wide X11 class `Dashboardd-desktop`.

## Step 1 bugs and fixes

- The initial generated PNG omitted all scanlines. Tauri decoded an empty icon and Tao panicked while creating the first window. Regenerated a valid RGBA PNG.
- The first Nix shell exposed AppIndicator through pkg-config but not the runtime loader. Added the Linux library path to the shell.
- Binding the socket inside Tauri setup made an already-running second process panic through Tauri's setup failure path. Moved socket and audit preparation before Tauri initialization so a second process exits cleanly with status 1.

## Step 1 verification results

- Protocol and client tests, formatting, affected-package Clippy with warnings denied, and the desktop build pass.
- Live socket checks cover empty list, two opens, focus, close, and retained list state. The socket is owned by the user with mode 0600, and audit records contain no titles or payloads.
- X11 reports the live demo as `WM_CLASS(STRING) = "dashboardd-desktop", "Dashboardd-desktop"`.
- A second service process exits with status 1 and `dashboardd desktop is already running` rather than panicking.
- User playtest confirmed tray visibility, visual rendering, focus, and close behavior. Tray Quit stopped PID 1591776 and removed the control socket.

## Step 3 accepted contract

- Replace dashboard-scoped runtime resources with global memory-only instance CRUD at `/api/v1/instances`. An instance contains only a server-generated random ID, widget ID, variant ID, and normalized options. Keep health, restart, messages, and events global. Reserve instance updates for Step 4 direct inputs.
- Advance runtime events to version 2. Remove dashboard and link events and remove dashboard identity from instance, health, error, and widget update events.
- Store version 1 Dashboard documents at `dashboardd.dashboards/v1` in browser local storage. Documents own dashboard identity, name, columns, stable placement IDs, positions, options, and links between placement IDs.
- Store transient `placement_id -> runtime_instance_id` bindings separately at `dashboardd.instance-bindings/v1`. Reconcile all local Dashboard placements whenever a browser page connects. Retain exact live matches and recreate missing bindings after runtime restart.
- Serialize cross-tab reconciliation and mutations with Web Locks when available and an in-process fallback otherwise. Use storage events to refresh other tabs. Separate browser storage contexts keep independent compositions and runtime instances.
- Persist the local Dashboard document before deleting removed runtime resources. Leave unknown global instances untouched because runtime instances have no creator or ownership metadata.
- Replace server state with schema version 4 containing only durable package-wide widget state. Runtime instances always start empty. Rename the default state file to `runtime.json`, reject explicitly selected old state files, and remove `dashboard.initial_widgets` configuration.
- Do not migrate old server-owned Dashboard composition or add backward-compatible API routes.

## Step 3 implementation notes

- Replaced all dashboard-scoped HTTP resources with global memory-only instance CRUD, health, restart, messages, and version 2 runtime events. Runtime instances use server-generated `instance-<uuid>` IDs and contain only widget ID, variant ID, and normalized options. Old composition fields and dashboard API routes are rejected.
- Reduced durable runtime state to schema version 4 package-wide widget state. Renamed the default file to `runtime.json`, removed `dashboard.initial_widgets`, and made every runtime start with zero instances.
- Added `web/src/dashboard-store.ts`. Browser local storage owns version 1 Dashboard documents, stable placement IDs, layout, options, and links. A separate binding cache maps placements to current runtime instance IDs.
- Reworked Home and Dashboard hosts around local documents. Dashboard creation, rename, duplication, deletion, column changes, placement movement, collision checks, and links no longer call server composition APIs.
- Reconciliation runs on event-stream connection and browser storage changes. It retains exact runtime matches, recreates missing instances after restart, filters global events through local bindings, and leaves unknown global instances untouched.
- Added cross-tab binding claims in addition to Web Locks. This prevents two tabs from creating duplicate runtime instances when both react to the same local storage mutation. Abandoned claims expire after five seconds.
- Updated browser integration to prove two isolated browser contexts keep different Dashboard documents against one runtime and independently recreate their instances after two runtime restarts.

## Step 3 bugs and fixes

- Comparing options with direct JSON serialization treated different object key orders as different specifications and recreated valid instances. Compare sorted option entries.
- Web Locks were unavailable in the integration browser, so two tabs could create the same placement concurrently. Added local storage claim-and-verify binding acquisition.
- A stale reconciliation snapshot could overwrite a resolved claim with its old pending value. Changed stale cleanup to reload and update one current binding at a time.
- Removing the old instance mutex exposed concurrent shared-state revision updates. Added a dedicated async mutation lock so only one writer can commit a revision.
- A placement retained its mounted frontend when reconciliation assigned a new runtime ID, leaving widget commands bound to the stopped backend. Remount the frontend whenever its runtime binding changes.

## Step 3 verification results

- All workspace Rust tests pass, including 23 runtime tests. Workspace Clippy passes for all targets with warnings denied.
- Rust formatting, Prettier formatting, contract tests, external SDK tests, production frontend builds, widget preparation, backend probes, documentation build, and the complete Chromium integration suite pass.
- Chromium verifies local Dashboard CRUD and layout, cross-tab synchronization, browser-local links, global runtime CRUD, memory-only restart behavior, independent browser compositions, shared widget state schema 4 persistence, and graceful shutdown.

## Step 4 implementation notes

- Added typed direct-input maps to runtime instances and creation requests. `PUT /api/v1/instances/{instance_id}/inputs` replaces the complete map, validates active manifest ports and exact type strings, returns the updated instance, and publishes a version 3 `instance_inputs_updated` event.
- Kept required-binding validation in presentation hosts. Browser-local Dashboard documents now persist direct inputs and reject unknown, inapplicable, mistyped, duplicate, or missing required bindings during reconciliation.
- Reconciliation updates direct inputs on an existing matching runtime instance. It recreates an instance only when widget, variant, or options differ.
- Replaced SDK `context.links` with `context.inputs.get`, `context.inputs.subscribe`, and `context.outputs.publish`. The browser input bus combines direct values and dynamic links and publishes `undefined` when an effective value is missing or removed.
- Added Dashboard controls for Unbound, Direct JSON value, and compatible widget outputs. Input editing updates local composition before the runtime resource. A source widget cannot be removed while it supplies a required dynamic input.
- Adapted bundled widgets to the split SDK capabilities and to clear selection when an input becomes `undefined`.
- Extended the external fixture widget and Chromium suite to create, display, update, unbind, reconcile, and reject mistyped direct inputs.

## Step 4 bugs and fixes

- Existing linked widgets treated `undefined` as an invalid payload and retained stale selections after unlinking. Treat missing effective values as explicit selection removal.
- Removing an output source could leave a required target input unbound and make the Dashboard document invalid. Block source removal until required targets are rebound.
- Adding an event kind under protocol version 2 would change a strict event union without changing its version. Advanced the runtime event protocol to version 3.
- The local Cargo cache contained generated Swagger UI paths from another worktree. Cleaned only the affected package build cache before continuing checks.

## Step 4 verification results

- All workspace Rust tests pass, including 25 runtime tests. Workspace Clippy passes for all targets with warnings denied.
- Rust formatting, Prettier formatting, contract tests, external SDK tests, production builds, widget preparation, documentation build, and the complete Chromium integration suite pass.
- Chromium proves direct input creation, frontend `get` and subscription delivery, atomic update without instance recreation, unbinding to `undefined`, required dynamic rebinding, runtime type rejection, restart reconciliation, and existing dynamic links.

## Step 5 implementation notes

- Added a dedicated multi-entry web build. `surface.html`, `surface.js`, and `surface.css` are independent from the Dashboard entry and are served at `/surface/{instance_id}`.
- Added a standalone host that attaches to one existing runtime instance, loads its descriptor, frontend, theme, health, and shared state, and consumes runtime event protocol version 3. It does not import or mutate Dashboard storage.
- Added direct input delivery, no-op outputs, backend messages, shared-state updates, backend payload updates, health tracking, and frontend presentation selection. Focus is the default; `?presentation=tile` selects tile presentation.
- Added a compact degraded-health overlay with Restart and a terminal unavailable state for invalid routes, missing instances, invalid presentation values, and instance deletion.
- Kept runtime ownership outside the page. Closing a surface destroys its frontend and event stream but leaves the runtime instance alive.
- Updated the runtime facade test, Nix package assertions, user documentation, and the external fixture backend. The fixture can report degraded health for Restart coverage.

## Step 5 bugs and fixes

- The first surface module initialized its direct-input bus before the class declaration, which strict TypeScript rejected. Moved initialization below the declaration while keeping all event callbacks asynchronous.
- Terminal surfaces initially retained an idle event stream after deletion or invalid startup. Close the runtime connection when entering the unavailable state.

## Step 5 verification results

- All workspace Rust tests pass, including 25 runtime tests. Workspace Clippy passes for all targets with warnings denied.
- Rust formatting, Prettier formatting, contract tests, external SDK tests, production multi-entry builds, widget preparation, documentation build, and the complete Chromium integration suite pass.
- Chromium proves live standalone CPU rendering, default Focus and explicit tile presentation, direct input updates, degraded health and Restart, deletion handling, invalid-route rejection, unchanged Dashboard storage, and caller-owned instance lifetime after page close.

## Architecture correction implementation notes

- Removed Axum, tower-http, utoipa, Swagger UI, HTTP event serialization, static web paths, and all HTTP-specific dependencies from `dashboardd-runtime`.
- Added cloneable `RuntimeHandle` direct operations for widget discovery, frontend resolution, instance CRUD, inputs, health, restart, backend messages, shared state, theme, and domain-event subscriptions.
- Moved the complete Axum router, request DTOs, error mapping, SSE version 3 envelope, OpenAPI, static Dashboard assets, and browser widget frontend delivery into `dashboardd-server`.
- Kept the existing browser HTTP wire contract unchanged. Added server-owned schema-only OpenAPI models so transport documentation does not require OpenAPI derives on runtime domain types.
- Removed the `/surface/{instance_id}` server route, standalone HTTP frontend entry, browser surface tests, package assertions, and documentation. The Dashboard build is single-entry again.
- Replaced the runtime HTTP facade test with direct-operation coverage. Server tests now own HTTP routing, OpenAPI, SSE serialization, and rejection of Dashboard and surface routes.

## Architecture correction bugs and fixes

- Moving domain structs out of OpenAPI derives initially removed response schemas from generated documentation. Added server-owned schema models that describe the unchanged serialized domain resources.
- The former runtime error mapping had no domain-level unknown-widget variant because HTTP resolved widgets before calling the manager. Added `InstanceError::UnknownWidget` so direct hosts receive the same typed failure.
- Rust-flake's filtered `self` default retained invalid store-path context after the crate boundary move. Set `rust-project.src` to an explicit locally filtered source path.

## Architecture correction verification results

- All workspace Rust tests pass: 17 runtime tests and 9 server tests cover the corrected split. Workspace Clippy passes for all targets with warnings denied.
- The runtime dependency tree contains no Axum, tower-http, utoipa, Hyper, or HTTP body crates.
- Rust and Prettier formatting, contract tests, external SDK tests, production Dashboard build, widget preparation, documentation build, and the complete Chromium HTTP and SSE integration suite pass.

## Step 6 implementation notes

- Replaced the demo control contract with protocol version 2 discovery, open, update, focus, list, close, and quit operations. The CLI accepts typed option and input JSON and returns the bounded JSON-line response unchanged.
- Embedded one independent runtime in the resident Tauri process. Desktop runtime state uses `dashboardd-desktop/runtime.json`; widget roots and theme configuration remain shared environment inputs.
- Added transaction-like open and close handling. Open validates required inputs, creates the runtime instance, registers its validated frontend path, creates the native window, and rolls back on failure. Native and controlled close remove the surface and instance.
- Added invoking-window-scoped Tauri initialization, backend message, restart, and shared-state mutation commands. Runtime events are filtered by instance or widget before emission to each surface.
- Restored the standalone surface TypeScript, HTML, and CSS under the desktop crate. It uses Tauri IPC for direct inputs, backend updates, health, restart, shared state, theme, and presentation.
- Added a read-only custom protocol that returns only the validated frontend module assigned to the requesting surface. The requesting webview label must equal the requested surface ID.
- Moved the Dashboard frontend from top-level `web/` to `crates/dashboardd-server/frontend/`. Added both server and desktop frontends as explicit root npm workspaces.
- Initial native content dimensions use 240 logical pixels per manifest unit and proportional 1200x960 fitting. Windows remain ordinary, decorated, and resizable.

## Step 6 bugs and fixes

- The restored standalone module initially constructed its input and state buses before their class declarations. Moved initialization below both declarations.
- The first desktop TypeScript configuration inherited `noEmit` behavior unsuitable for webpack's `ts-loader`. Enabled compiler output for the webpack pipeline.
- Input replacement initially relied only on runtime port and type validation, which permits an absent required port by design. Added presentation-host required-input validation to both open and update.
- Tauri's global event listener did not complete under the live WebKitGTK host, leaving the surface before initialization. Replaced the global event plugin with one invoking-webview-scoped Tauri IPC channel.
- WebKitGTK mounted the complete widget DOM but rendered a gray surface while repeatedly failing GBM buffer allocation. Default `WEBKIT_DISABLE_DMABUF_RENDERER=1` before Tauri initialization unless the caller explicitly sets it.

## Step 6 verification results

- Both production frontend builds pass after the ownership move.
- Desktop and control package tests pass. Focused Clippy passes for all targets with warnings denied.
- The live X11/i3 playtest confirmed custom frontend delivery, CPU telemetry rendering, healthy backend updates, and exact 720x720 floating dimensions after disabling WebKitGTK DMA-BUF rendering.
- Live update, focus, list, close, and Quit commands pass. Close removes the instance and surface; Quit exits the recorded PID and removes the control socket.
- Full workspace tests and Clippy with warnings denied pass. Contract, SDK, production frontend, widget preparation, Chromium integration, and documentation builds pass.
- Updated the root npm dependency hash for Nix. `nix flake check --no-build` remains blocked by the local Nix 2.34 evaluator producing an unrealized filtered Rust source store path; checking the archived flake fails at the same rust-flake source lookup.

## Step 2 implementation notes

- Added the reusable `dashboardd-runtime` library with a small `RuntimeConfig`, `Runtime`, `RuntimeError`, and cloneable `ShutdownHandle` facade. Renamed the default HTTP host package to `dashboardd-server`; its installed binary remains `dashboardd`.
- Moved the HTTP API, configuration watching, events, health, instance supervision, persisted state, and widget discovery modules into the library. API, event, health, instance, state, and widget module contents are byte-identical to their pre-extraction versions.
- Renamed shared packages by role: `dashboardd-widget-protocol` for runtime/backend wire types and `dashboardd-widget-bundle` for bundle packing and validation. The bundle package still installs the `dashboardd-widget` command.
- Kept environment parsing, tracing, TCP listener selection, Ctrl-C handling, and server startup in the `dashboardd` binary. Configuration-path environment resolution also moved to the binary.
- Added a facade integration test that starts an empty runtime, serves `/health` through its router, and shuts down configuration watching cleanly.

## Step 2 verification results

- All 35 runtime tests and 3 binary tests pass. Affected-package formatting and Clippy with warnings denied pass.
- Contract and external SDK tests pass.
- The initial headless browser runs reached all runtime behavior but failed at the Project Brief narrow-layout Focus-clearance assertion. Two runs against the clean pre-extraction commit reproduced the failure, including the exact assertion.
- Fixed the existing narrow Project Brief media query so it preserves the documented shell Focus-control clearance instead of replacing both inline paddings.
- The complete contract, SDK, workspace build, frontend production build, widget preparation, backend health, browser integration, persistence, restart, and shutdown suite passes after the fix.
- A process smoke test served `/health`, handled SIGINT through `ShutdownHandle`, exited with status 0, and logged complete shutdown.

## Package structure refinement

- Merged the former `dashboardctl` package into `dashboardd-desktop-control` as a second target. The package now provides the small protocol library and the `dashboardctl` binary without introducing Tauri dependencies.
- Renamed packages by role: `dashboardd` -> `dashboardd-server`, `dashboard-protocol` -> `dashboardd-widget-protocol`, and `dashboardd-widget` -> `dashboardd-widget-bundle`. Installed commands remain `dashboardd` and `dashboardd-widget`.
- Updated Rust imports, workspace dependencies, development commands, Nix crate references, and the workspace map. Nix outputs now expose `dashboardd-server` and `dashboardd-widget-bundle`; `dashboardd-unwrapped` remains the server-only alias.
- Focused package tests, workspace Cargo check, workspace Clippy with warnings denied, Rust formatting, Prettier formatting, CLI help, documentation build, full browser integration, and Nix flake evaluation pass.
- Built the renamed Nix outputs. `dashboardd-widget-bundle` contains `dashboardd-widget`, `dashboardd-unwrapped` contains `dashboardd`, and `dashboardd-desktop-control` contains `dashboardctl`.
