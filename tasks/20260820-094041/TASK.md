# Build desktop-hosted standalone widget surfaces

- STATUS: OPEN
- PRIORITY: 100
- TAGS: desktop,tauri,runtime,widgets,surface,nix

## Goal

Build the dashboardd-side runtime, standalone surface, and resident Tauri desktop service needed to open live widget windows through a same-user local control API.

## Source design

- Parent research task: `20260818-222337`.
- Follow its accepted runtime, input, desktop lifecycle, Unix socket, logging, and window semantics.
- This task implements dashboardd components only. The Pi assistant and delegated-agent orchestrator belong in a separate repository.

## Steps

### 1. Build the resident desktop lifecycle slice

- Add retained `dashboardd-desktop` and `dashboardctl` crates.
- Start hidden with a system tray item and remain resident with no windows.
- Implement the same-user Unix socket, bounded versioned JSON request protocol, metadata-only JSONL audit log, and static local demo windows.
- Add `open-demo`, `list`, `focus`, and `close` commands.
- Verify tray Quit closes windows, stops the socket server, removes the socket, and exits under X11 and i3.
- Keep this slice free of real widgets, runtime extraction, systemd units, and Nix deployment.

Completion gate: `dashboardctl open-demo` creates a controllable Tauri window while the tray service remains resident.

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
