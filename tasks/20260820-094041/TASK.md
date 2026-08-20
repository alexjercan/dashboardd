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

- Move widget discovery, instance lifecycle, backend supervision, events, health, shared state, and the runtime HTTP API into a reusable Rust library.
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

- Add versioned typed input envelopes to instance creation and update.
- Validate port existence, variant applicability, required bindings, and exact manifest type while leaving opaque JSON value validation to the widget.
- Publish input updates through instance events.
- Split the frontend SDK into `inputs.get`, `inputs.subscribe`, and `outputs.publish` capabilities.
- Adapt Dashboard-local links to the new SDK contract with exactly one direct or dynamic binding per input.

Completion gate: a widget receives and updates a direct typed input without a source widget.

### 5. Add the standalone surface host

- Add `web/surface` to mount exactly one runtime instance.
- Support direct inputs, backend updates, health, presentation, and cleanup.
- Exclude Dashboard composition, navigation, layout, and links.

Completion gate: a browser-hosted standalone route displays one live CPU widget without a Dashboard document.

### 6. Connect desktop windows to real widgets

- Embed `dashboardd-runtime` in `dashboardd-desktop` by default and retain an explicit external-runtime mode.
- Replace static demo windows with `web/surface` webviews.
- Implement typed discover, open, update, focus, list, close, and quit control commands.
- Make every open create a new surface, runtime instance, and native window with a generated surface ID.
- Delete the runtime instance when its window closes.

Completion gate: `dashboardctl open cpu --variant full` opens a live native CPU widget and later commands control it by surface ID.

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
