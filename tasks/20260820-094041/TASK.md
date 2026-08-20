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

- Add retained `dashboardd-desktop`, `dashboardd-desktop-control`, and `dashboardctl` crates. Keep all versioned wire types, size limits, and encoding rules in the small shared control crate; the Tauri service and CLI client depend on it.
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

### 3. Decouple runtime instances from Dashboard composition

- Provide global memory-only instance CRUD.
- Remove dashboard identity, layout, links, window identity, and ownership from runtime instances and events.
- Move Dashboard documents, layout, navigation, and link graphs into browser-local storage.
- Reconcile and recreate browser-owned instances after runtime restart.

Completion gate: separate browsers can keep different local Dashboard compositions against one runtime.

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

- Added separate `dashboardd-desktop-control`, `dashboardctl`, and `dashboardd-desktop` packages. The shared crate owns protocol version 1, 64 KiB JSON-line framing, command and response types, and the session socket path.
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
