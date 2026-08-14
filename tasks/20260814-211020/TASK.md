# Add dashboard Focus view

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, focus, widget, tatr, artifact

## Goal

Add a route-backed full-viewport Focus presentation for opt-in widget variants, with Tatr Artifact as the first consumer.

## Accepted design

- Use the user-facing name `Focus`, route `/focus/<instance-id>`, and lifecycle states `"tile"` and `"focus"`.
- Declare Focus support per frontend variant with `focus = true` in `widget.toml`.
- Add optional `WidgetFrontend.setPresentation(presentation)` lifecycle support. Keep one mounted frontend and preserve its page-local state when presentation changes.
- Keep Focus page-local and non-persistent. It does not alter canonical placement, dimensions, composition, links, options, or backend instance state.
- Make Focus available from Zen mode only. Editor mode remains composition-only.
- Dashboard owns the Focus control, routing, full-viewport layer, Z order, close behavior, keyboard focus, background interaction blocking, missing-instance handling, and accessible labeling.
- Show a compact dashboard-owned Focus control at the top-right of supported widgets. Keep it low contrast until hover or keyboard focus on pointer devices and discoverable on touch devices.
- Focus occupies the full viewport above the dashboard. Background content is non-interactive. Close, Escape, and browser Back leave Focus.
- Direct route loads restore Focus when the instance exists. A missing, deleted, unsupported, or failed instance returns to `/` with a clear dashboard error.
- The same widget frontend owns tile and Focus layouts and may request richer data when focused. Do not mount a second frontend or create duplicate SSE/link subscriptions.
- Tatr Artifact keeps the current selector and selected artifact while entering or leaving Focus. Focus uses the extra viewport for a larger document/image surface and readable expanded typography.

## Verification plan

- Manifest preparation and dashboard discovery tests cover the Focus capability.
- SDK and browser integration cover the lifecycle callback, route entry, direct reload, Close, Escape, browser Back, unsupported controls, editor exclusion, retained artifact selection, full viewport layout, background interaction blocking, deletion recovery, and mobile rendering.
- Review focused Tatr Markdown and image screenshots at wide and narrow viewport sizes.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before the final commit.

## Implementation notes

- Added `focus` to source and packaged variant manifests, runtime discovery, public descriptors, frontend parsing, and generated API schemas. Existing packaged manifests default to unsupported.
- Added optional `WidgetFrontend.setPresentation()` without changing existing widget lifecycle requirements.
- Added a dashboard-owned full-viewport layer that moves the existing frame between the grid and Focus stage. No frontend, SSE stream, link subscription, or backend instance is duplicated.
- Added route history behavior for Focus controls, Close, Escape, Back, direct loads, unsupported variants, failed mounts, and removed instances.
- Made the background inert and inaccessible while focused, restored keyboard focus on close, and kept editor mode free of Focus controls.
- Added a responsive Tatr Artifact Focus presentation while preserving selected task, artifact, menu, content, and scrollable surfaces.
- Made the generated dashboard bundle URL root-relative so direct `/focus/...` and `/edit` document loads resolve frontend assets correctly.

## Bugs and fixes

- Direct Focus routes initially served the document but loaded `focus/<instance>/bundle.js` because the generated script URL was relative. Set the dashboard webpack public path to `/`.
- Deferring route focus restoration with `requestAnimationFrame` broke the existing synchronous editor focus contract. Focus targets are available after synchronous rendering, so focus restoration now runs immediately.
- Selecting the already active Artifact menu item returned before closing the menu. The menu now closes before checking whether a backend selection request is needed.

## Verification results

- Dashboard tests, production builds, widget preparation, formatting, and Chromium integration pass.
- Chromium covers opt-in controls, editor exclusion, lifecycle state, full-viewport layout, retained artifact selection, Close, Escape, browser Back, direct routes, unsupported variants, deleted instances, mobile and desktop rendering, and active Artifact menu closure.
- Wide and narrow focused Markdown and image screenshots were reviewed.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
