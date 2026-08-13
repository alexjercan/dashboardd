# Build widget-owned CPU dashboard UI

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, cpu, frontend

# Scope

Move CPU rendering into the CPU widget and expand telemetry to history, per-core usage, temperatures, frequency, and load averages.

# Accepted design

- Add a manifest-declared browser ES module owned by `widgets/cpu`.
- Serve only each widget's declared frontend file at a dashboardd-controlled URL.
- Advertise `frontend_url` in `WidgetDescriptor`.
- Use a generic `mount(container, context) -> { update(payload), destroy() }` module contract.
- Include `widgetId`, `instanceId`, and `send(payload)` in the mount context.
- Load modules dynamically in the core dashboard and route updates by instance ID.
- Remove CPU-specific parsing, state, markup, and rendering from the core dashboard.
- Isolate widget markup and CSS with Shadow DOM.
- Expose inherited Gruber Darker semantic CSS variables from the dashboard host.
- Keep 60 one-second samples in the browser and render total CPU usage as a compact SVG history graph.
- Show raw 1, 5, and 15 minute load averages on one line.
- Target a compact card near 360 x 360 px in a responsive three-column dashboard grid, so six cards fit in a 3x2 desktop layout.
- Arrange 24 logical cores as a 6x4 grid; choose up to six columns dynamically for other core counts.
- Render each core as a fixed square with an internal bottom-up fill representing usage.
- Show only direct core temperature in the square; omit visible core IDs.
- Put core ID, usage, frequency, and temperature in the core tooltip.
- Use green below 70 percent, yellow from 70 percent, and red from 90 percent.
- Show a temperature in a core only when a sensor label maps directly to it.
- Show package temperature separately when available; use `null` when unavailable.
- Use `sysinfo` for CPU, load, and temperature telemetry.
- Support the frontend context's `send` path through dashboardd to the backend, though CPU has no controls yet.
- Defer frontend SDK packaging, persistence, movement, resizing, and multiple instances.

# Verification

- Test manifest frontend discovery and descriptor URL.
- Test structured CPU payload shape and temperature mapping.
- Test dashboard-to-widget message routing.
- Run focused Rust and frontend format, test, lint, and build checks.
- Playtest the graph and core grid in a browser before commit.

# Implementation

- Expanded CPU updates with total usage, logical-core usage and frequency, load averages, direct core temperatures, and package temperature.
- Added a manifest-owned `frontend.js` module rendered in Shadow DOM.
- Added a compact responsive 60-second SVG graph, one-line load averages, and a per-core usage grid using the Gruber Darker palette.
- Changed each core to a 38 px square with bottom-up usage fill and centered temperature; kept core ID, usage, frequency, and temperature in the tooltip.
- Added a responsive 3-column desktop dashboard layout for a 3x2 widget viewport.
- Added restricted dashboardd module serving and `frontend_url` discovery metadata.
- Replaced CPU-specific host rendering with generic module loading and instance routing.
- Added frontend-to-backend widget message forwarding.

# Verification results

- CPU tests pass: 3.
- Dashboardd tests pass: 6.
- Protocol tests pass: 10.
- Focused Clippy passes with warnings denied.
- Frontend formatting and production build pass after the compact layout refinement.
- Widget ES module syntax check passes.
- Live flow passes: descriptor URL, module serving, backend spawn, 24 logical cores, load averages, and package temperature.
- Browser visual playtest passed after compacting the card and removing visible core IDs.
