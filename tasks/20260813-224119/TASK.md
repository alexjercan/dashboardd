# Dashboard composition edit mode

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, editing, layout, frontend, backend

## Goal

Replace hardcoded default widgets with a complete slot-based composition flow that works with mouse, touch, keyboard, and multiple open pages.

## Accepted design

### Page chrome

- Use one compact header row with `Scufris Dashboard` as the page title.
- Normal mode has a visible `Edit` button in the header.
- Edit mode has `Done` in the header.
- Move connection status to a normal page footer.
- Show a status circle and label: green Connected, yellow animated Connecting or Reconnecting, red Connection error.

### Slot canvas

- Normal mode displays only occupied widget cells.
- Edit mode displays a minimum 3x2 canonical canvas.
- Empty cells have dashed contours and a centered `+` button.
- Keep one additional empty row when the last occupied row reaches the current canvas end.
- Use row-major slots. On narrow screens, canonical desktop slots project to one visible column without changing saved coordinates.
- Enter edit mode automatically when the dashboard is empty.
- Keep movement and resizing out of this slice.

### Add flow

- Selecting an empty slot opens an Add Widget modal for that exact position.
- The modal lists installed widget definitions.
- Selecting a definition shows its name, target column and row, fixed 1x1 size, and a reserved configuration section that says `No options`.
- Add creates the widget atomically with the selected 1x1 layout.
- Parameters and a generic parameter protocol are deferred until a real widget needs them.

### Instances and removal

- Remove automatic CPU and Memory creation.
- Allow unlimited instances of each installed widget definition.
- Duplicate system widgets run independent backends and may show the same host telemetry.
- Each occupied cell has a remove control in edit mode.
- Removal requires confirmation and clears the slot only after server confirmation.
- Creation and removal synchronize through existing SSE events across open tabs.

### Layout constraints

- Dashboardd owns the canonical desktop column count.
- Expose it as `GET /api/v1/layout` with `{ "columns": 3 }`.
- Use the same backend layout configuration for instance create and update validation.
- Fetch the constraint during browser reconciliation and use it to render canonical slots.
- Keep minimum rows, 350 px row height, and responsive breakpoints as frontend presentation settings.
- Do not let clients supply server validation constraints.

### Persistence

- Keep server-owned in-memory state for this slice.
- Refresh and open tabs share composition.
- A dashboardd restart resets composition.
- Durable storage is deferred until the layout editing model is complete.

## Verification

- API tests cover atomic create layouts, duplicate widget instances, and layout validation.
- Browser integration covers empty startup, automatic edit mode, slot modal creation, duplicate instances, telemetry, refresh, two-page add/remove synchronization, confirmation, footer status, mobile slots, reconnect, and clean shutdown.
- Inspect wide and narrow screenshots before review.

## Implementation notes

- `POST /api/v1/instances` now requires an initial layout and validates it before starting the backend. This prevents transient creation in the wrong slot.
- Removed per-definition instance uniqueness. Duplicate CPU or Memory instances start independent backend processes.
- Centralized three-column bounds and collision validation in the instance manager so create and update share the same rules.
- Removed browser-side default reconciliation. An empty server remains empty and enters edit mode.
- Added compact header controls, footer connection indicator, explicit canonical slots, Add Widget selection/details modal, reserved `No options` area, and confirmed removal.
- Widget descriptions remain host-local presentation copy for now. A richer catalog manifest contract is deferred with parameter schemas.
- Responsive CSS projects canonical slots into two or one columns without mutating server layout.

## Verification results

- Focused dashboardd tests pass, including layout bounds and collision checks.
- Dashboard production TypeScript/Webpack build passes.
- Real Chromium integration passes empty startup, edit canvas, duplicate CPU instances, CPU and Memory telemetry, refresh, two-page add/remove synchronization, cancel and confirm removal, collision rejection, responsive layout, reconnect, frontend caching, and graceful shutdown.
- Inspected `tests/artifacts/dashboard-edit-wide.png` and `tests/artifacts/dashboard-edit-narrow.png`. Header, edit contours, empty slots, widget sizing, mobile projection, and footer status are visually coherent.
- Review follow-up: replaced duplicated canonical column literals with backend-owned `DashboardLayout`. `GET /api/v1/layout` returns the same value used by create and update validation, and browser reconciliation uses it for slots and desktop CSS columns.
- Added API/OpenAPI, parser, production build, Clippy, and browser assertions for the layout constraint resource.
