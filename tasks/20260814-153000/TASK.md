# Add linked Tatr task details

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, links, tatr, markdown

## Goal

Add first-class, server-owned widget links and a 3x3 Tatr Details variant that safely renders the selected task's `TASK.md`.

## Accepted design

### Link declarations

- Variants declare typed input and output ports in `widget.toml`.
- Tatr Full declares output `selected_task` with type `tatr.task-selection/v1`.
- Tatr Details declares required input `task` with the same type.
- Dashboardd validates variant applicability, matching types, existing instances, one source per input, and duplicate links.
- One output can feed multiple inputs.

### Persistence and APIs

- Store links separately from instance options in `dashboard.json`.
- Link records contain source instance and port plus target instance and port.
- Dashboardd owns link creation, replacement, deletion, validation, and persistence.
- Removing a source removes its links but retains target instances.
- Restored invalid or incompatible links stop startup.

### Browser link bus

- Add `context.links.publish(output, payload)` and `context.links.subscribe(input, handler)` to the widget SDK.
- Dashboard binds each context to its instance and routes only through server-validated links.
- Retain the latest payload per source output and replay it to targets mounted later.
- Link payloads are page-local, reset on reload, and do not synchronize across tabs.
- Backend task selection still validates project and Task ID.

### Editor experience

- Details has one required task input.
- Adding Details shows `Linked task list` with compatible placed Full instances.
- Source labels use `Tatr Tasks at column N, row N`.
- Disable Add when no compatible source exists.
- Show editor-only source and target link badges.
- Hovering or focusing a badge highlights linked frames.
- Clicking a target badge opens a compatible-source relink selector.
- Removed links leave Details in a `Not linked` state that can be relinked.
- Do not draw connector lines.

### Protocol

- Add `variant_id` to backend initialization.
- Update all packaged backends and protocol tests.

### Tatr variants

- Existing `Full`: 6x3.
- New `Details`: 3x3.
- Keep both under the `Tatr Tasks` widget card.
- Full row selection publishes `{ project, task_id }` through `selected_task`.
- Status and tag controls retain their existing behavior.
- Selected rows use a quiet accent treatment.

### Details first draft

- Header: `Task Details`.
- Show relative project and complete Task ID.
- Initial state: `Select a task`.
- Display only the selected task's `TASK.md`.
- Render sanitized Markdown without raw HTML.
- Do not load embedded local images.
- External links open in a new tab with safe relationship attributes.
- Use internal vertical scrolling.
- Reject files larger than 256 KiB.
- Poll only the selected `TASK.md` every 2 seconds.
- Preserve the last valid rendering on read errors.
- Never send absolute paths.

## Verification

- Manifest and dashboard tests cover port declarations and link validation.
- Persistence tests cover valid restoration, invalid restoration, source removal, and relinking.
- SDK/browser coverage exercises routing, replay, editor badges, compatible source selection, relinking, and page-local reset.
- Tatr tests cover task path validation, size limits, Markdown payload privacy, selected-file refresh, and error retention.
- Chromium screenshots cover linked editor state and desktop/narrow Details rendering.

## Implementation notes

- Added typed manifest input/output ports through source preparation, runtime discovery, APIs, and browser descriptors.
- Added durable dashboard links with atomic instance creation, replacement, source-removal cleanup, strict restoration, SSE updates, and stable target-input identity.
- Added `variant_id` to backend initialization and updated all packaged backends.
- Added a page-local retained link bus bound to each widget context.
- Added required compatible-source selection during Details creation and editor-only link badges with paired highlighting and relinking.
- Added the 3x3 Details variant, safe Markdown rendering, raw HTML and image suppression, external-link hardening, path containment, regular-file checks, and the 256 KiB limit.
- Added per-page view IDs to Details backend requests and responses. This prevents a server-owned backend update from leaking another tab's selection into the current tab while still polling each active view independently.
- Removing a linked source removes the durable link, retains Details, and changes its editor badge to `Not linked`.

## Bugs and fixes

- Initial page-local routing still produced cross-tab Details updates because widget backend updates are broadcast. Added per-view correlation and frontend filtering rather than changing selection to server-global state.
- Explicit desktop grid rows initially overrode narrow row placement. Kept equal-specificity narrow overrides and verified both projections.

## Verification results

- Protocol, dashboardd, Tatr backend, and manifest preparation tests pass.
- Dashboardd and Tatr Clippy pass with warnings denied.
- All production frontend builds and formatting checks pass.
- Chromium integration passes required source selection, durable link API state, editor badges, page-local selection, sanitized Markdown, desktop and narrow layouts, reload reset, relinking, source-removal cleanup, and existing dashboard scenarios.
- Linked editor, wide linked dashboard, and 420 px linked dashboard screenshots were reviewed.
