# Add Memory widget

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, memory, frontend, backend, testing

## Goal

Add a second independently packaged widget that reports live RAM and swap usage. Use it to prove the generic widget platform with multiple simultaneous widgets.

## Accepted design

### Identity

- Widget ID: `memory`.
- Rust backend package: `memory`.
- npm frontend workspace: `@scufris/memory-widget`.
- Source manifest: `widgets/memory/widget.toml`.

### Telemetry

Report once per second:

- RAM usage percentage.
- Used, total, and available RAM in bytes.
- Swap usage percentage.
- Used and total swap in bytes.

Use `sysinfo` values. Do not add Linux-specific cached-memory parsing.

### Visual contract

- Match the CPU widget header, 60-second graph, dimensions, spacing, typography, and theme tokens.
- Show memory percentage and total RAM in the header.
- Graph the last 60 memory percentage samples.
- Show a horizontal RAM usage bar followed by used and available values.
- Keep Swap inside the Memory widget with its own horizontal bar and used / total values.
- If swap is absent, keep the section stable and show `Not configured` with an empty bar.
- Format bytes with IEC units.
- Use green below 70%, yellow from 70%, and red from 90%.
- Keep graph and bar code widget-local. Extract shared SDK helpers only after implementation proves useful repetition.

### Dashboard behavior

- Ensure one CPU and one Memory instance when their definitions are installed.
- Preserve the existing PoC behavior: deletion is immediate, but refresh or SSE reconciliation recreates a missing default.
- Keep widget-specific rendering out of the dashboard host.

### Unit grid follow-up

- Use a fixed 350 px host row as one height unit.
- One width unit is one responsive dashboard column.
- Apply instance `width` and `height` as CSS grid spans.
- CPU and Memory default to 1x1, appear first and second, and have equal host dimensions.
- Keep automatic placement while default instance coordinates are both zero.
- On a one-column viewport, force one-column width while preserving height units.
- Widgets fill their host frame. Internal unused space belongs to the widget, not a variable host card size.
- Add browser assertions for equal 1x1 dimensions and layout span behavior.

### Verification

- `cargo xtask widget prepare --all` builds both runtime bundles.
- CPU and Memory mount and receive telemetry.
- Refresh preserves the same two server-owned instances.
- Two pages share both instances.
- Deleting Memory removes it from both pages while CPU remains.
- Reconnect restores both authoritative instances.
- Wide and narrow layouts do not overflow.
- SIGINT cleanly stops two running backends while SSE clients remain connected.
- Run affected formatting, tests, builds, Clippy, browser integration, and Nix checks before commit.

## Reference

The earlier implementation at `/home/alex/personal/_tests/scufris-old/web/src/stats-cards.ts` inspired the integrated RAM graph, RAM bar, and Swap subsection. The new widget follows the current CPU visual contract rather than copying the old card chrome.

## Implementation

- Added the independently packaged Memory Rust backend and TypeScript frontend.
- Added RAM and swap telemetry from `sysinfo`, including zero-total handling and bounded percentages.
- Added the 60-second memory graph, RAM and swap usage bars, IEC values, stable no-swap state, and CPU-aligned styling.
- Generalized dashboard default reconciliation to ensure all installed default widget IDs without adding widget rendering logic to the host.
- Extended the browser flow to cover two widget definitions, two live backends, both frontend bundles, shared pages, Memory deletion, CPU survival, reconnect, responsive screenshots, and graceful two-backend shutdown.
- Kept graph and bar implementation local to Memory. The second implementation confirms visual repetition, but not yet enough behavioral complexity to justify expanding the SDK contract.

## Reflection

- A second real widget exposed the default-instance logic as the remaining CPU-specific host behavior. A small ordered default ID list keeps the PoC explicit while making creation generic.
- `sysinfo` supplies portable used and available values but no portable cached-memory value. Omitting cached memory keeps the backend portable and truthful.
- Keeping Swap visible when absent prevents card movement and distinguishes an unconfigured resource from missing telemetry.
- The Memory card is naturally shorter than the 24-core CPU card. Host cards remain content-sized; equal-height policy belongs with future editable layout rather than widget internals.

## Verification results

- Rust formatting, 20 workspace tests, and Clippy with warnings denied pass.
- Root npm formatting and all three production Webpack builds pass.
- `cargo xtask widget prepare --all` produces CPU and Memory runtime bundles.
- Real Chromium integration passes both live widgets, telemetry and Memory bars, refresh, two pages, deletion with CPU survival, reconnect, wide and narrow layouts, and clean SIGINT with two backends.
- Wide and narrow screenshots were inspected at `tests/artifacts/dashboard-wide.png` and `tests/artifacts/dashboard-narrow.png` during implementation.
- `nix flake check path:$PWD` passes, including Memory package, docs, and Clippy derivations.

## Unit grid implementation

- Added a fixed 350 px CSS grid row unit and responsive 3, 2, and 1 column widths.
- Applied authoritative instance width and height as host CSS grid spans on mount and update.
- Added `data-layout` as an observable host state for integration assertions.
- Made widget Shadow DOM hosts fill the entire outer frame, so CPU and Memory 1x1 instances have equal dimensions.
- Kept automatic dense placement because coordinates remain deferred.
- Browser integration verifies equal 1x1 dimensions at wide and narrow widths and verifies a live PATCH from 1x1 to 2x2 and back.
- Re-ran and inspected wide and narrow screenshots after unit sizing.
