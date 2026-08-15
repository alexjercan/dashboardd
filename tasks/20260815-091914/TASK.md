# Add full-screen dashboard canvases

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, layout, wallpaper, responsive

## Goal

Make each desktop dashboard a full-viewport canvas suitable for persistent wallboard or wallpaper presentation.

## Accepted design

- Give each dashboard a durable canonical column count from 3 through 24.
- Suggest new dashboard columns as `round(available viewport width / 160)`, clamped to 3 through 24. API creation without a supplied count defaults to 9.
- Add Editor minus and plus controls for columns. Reject a reduction when any widget would become out of bounds.
- Keep canonical placement server-owned and validated against that dashboard's columns.
- Derive rows automatically. Do not persist a row count or add a row setting.
- Compute desktop natural rows as `ceil(columns * viewport height / viewport width)` and display the greater of natural rows and occupied row extent.
- Editor shows one trailing insertion row when below the server row bound. Placing into it extends the occupied canvas; removing bottom widgets contracts it.
- Bound canonical placement to 24 rows.
- Use the complete desktop viewport with 8 px outer padding. Keep widgets and gaps inside that canvas.
- Overlay Editor and Zen controls. Fade Zen controls while idle and restore them for pointer, touch, or keyboard activity.
- Preserve narrow responsive projection and vertical scrolling rather than squeezing the canonical canvas onto phones.
- Home schematic previews use each dashboard's configured columns and occupied rows.
- Advance the prototype state schema without migration. Old schema versions fail startup. Remove the existing legacy migration code and do not add compatibility routes or fields.
- Initial widgets create a 9-column `Main` dashboard only when no state file exists.

## API and persistence

- Dashboard resources expose `columns`.
- Dashboard creation accepts optional `columns`; absence means 9.
- Dashboard PATCH accepts optional `name` and `columns`, requires at least one, and applies both atomically.
- Duplicate preserves the source dashboard's column count and allocates independent instances and links.
- Dashboard summaries, SSE lifecycle events, and home previews include columns.

## Verification plan

- Test schema rejection, column defaults and bounds, atomic update validation, occupied-layout reduction rejection, duplicate preservation, independent dashboard dimensions, and 24-row placement bounds.
- Test width-based creation suggestions, plus and minus controls, full viewport sizing, automatic row growth and contraction, desktop widget geometry, idle controls, home previews, narrow projection, reload persistence, and tab isolation in Chromium.
- Re-run all existing widget, composition, Focus, link, Projects, Tatr, shared-state, privacy, and dashboard lifecycle scenarios.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks.

## Implementation notes

- Advanced the prototype state schema to version 3 and removed all legacy migration parsing. Old state now fails startup unchanged.
- Added durable per-dashboard columns with 3 through 24 bounds, API default 9, viewport-based browser suggestions, duplicate preservation, and dashboard lifecycle event synchronization.
- Added atomic dashboard PATCH updates for optional names and columns. Column reductions fail before persistence when any widget would leave the canvas.
- Added a 24-row server bound to creation, movement, swapping, restoration, and initial composition validation.
- Replaced the global layout resource with dashboard-owned columns from the dashboard resource.
- Added Editor minus and plus controls. Other tabs apply column changes from dashboard SSE events.
- Desktop Zen and Editor now use the full viewport with 8 px padding. Rows derive from viewport aspect ratio and occupied extent, while Editor includes one bounded insertion row.
- Kept narrow screens on the existing three-column, 110 px row, vertically scrolling projection.
- Added idle Zen control fading and fixed overlay Editor controls.
- Updated home creation and switcher creation to suggest `round(width / 160)` columns, and updated metadata previews to use each dashboard's canonical columns.

## Bugs and fixes

- The home initially replaced every card for each backend health timestamp, which detached an open Manage menu. Health events now update only the existing card's aggregate health content.
- Fixed-width browser assertions encoded the old 110 px desktop row model. Replaced them with viewport geometry and relative size assertions.
- A full-width overlay Editor header intercepted first-row slots. The Editor canvas now reserves overlay-safe top padding inside the same viewport bounds.
- Dashboard column changes initially updated only the initiating tab. Dashboard lifecycle callbacks now carry resources so routed tabs update canvas geometry immediately.

## Verification results

- State schema rejection, empty version-3 state, column defaults, column persistence, duplicate preservation, occupied reduction rejection, cross-dashboard links, and row bounds pass focused Rust tests.
- Chromium integration passes viewport-derived rows, 8 px full-screen geometry, column controls, existing composition operations, responsive projection, Focus, all widgets, Projects, Tatr, shared state, dashboard lifecycle, and restart scenarios.
- Reviewed sparse Zen, full Editor, and dense linked dashboard screenshots at 1440x1000.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
