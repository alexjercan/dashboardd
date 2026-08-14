# Add declarative widget options and improve widget selection

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, widgets, options, manifests, frontend, backend

## Goal

Present one catalog entry per widget, then let the user select its variant and configure manifest-defined options before creation.

## Accepted design

### Selector

- Show one catalog card per widget: CPU, RAM, Claude Usage, and Codex Usage.
- Desktop uses a widget catalog beside the selected widget configuration.
- Narrow screens replace the catalog with configuration after selection.
- Narrow configuration includes `Back`, which restores the catalog and focus to the selected card.
- Configuration shows the widget description, variant choices with dimensions, applicable options, and Add widget.

### Declarative options

- Source `widget.toml` owns option definitions.
- Runtime manifests and widget descriptors expose validated option definitions.
- dashboardd renders no widget-owned configuration code and validates submitted values.
- Supported types are Boolean, bounded integer, and static select.
- Every option has an explicit default.
- `variants` limits option applicability; omission applies it to every variant.
- Effective precedence is submitted instance value, then manifest default. There are no dashboard defaults.
- Reject unknown, inapplicable, incorrectly typed, out-of-range, or invalid-choice values atomically.
- Persist normalized effective values so later manifest default changes do not alter existing instances.
- Strict startup validation rejects invalid stored options.
- Option values are non-secret and may appear in APIs, SSE events, browser state, and composition storage.

### Runtime delivery

- Instance resources include active effective options.
- Backend initialization includes active effective options.
- Widget SDK exposes active effective options as `context.options`.
- Widget frontends consume values but do not render selector forms.
- Custom widget configuration frontends, dynamic choices, nested values, and secrets are deferred.

### Initial options

- CPU Full: `show_core_temperatures`, Boolean, default `true`.
- CPU Full: `history_points`, integer from 20 through 120 in steps of 10, default 40.
- Memory Full: `show_swap`, Boolean, default `true`.
- Claude Usage Full: `display_mode`, select `usage` or `remaining`, default `remaining`.
- Codex Usage Compact: `display_mode`, select `usage` or `remaining`, default `remaining`.
- Usage mode shows consumed percentage and fills the bar by consumed usage.
- Remaining mode preserves current percentage and bar behavior.
- Minimal variants have no options.

### Naming

- Display names are CPU, RAM, Claude Usage, and Codex Usage.
- Stable widget IDs remain unchanged.

## Verification

- Manifest tests cover supported schemas and invalid declarations.
- Backend tests cover defaults, submitted values, validation, runtime delivery, persistence, and strict restoration.
- Browser integration covers widget-first selection, variant selection, generated option controls, narrow Back behavior, create payloads, and option effects.

## Implementation notes

- Added source and runtime manifest option schemas with duplicate, variant, default, range, step, and choice validation.
- Added normalized options to instance APIs, SSE resources, persistence, backend initialization, and frontend SDK context.
- Existing composition files without options are normalized and saved during restoration.
- Replaced the flattened widget/variant catalog with widget cards and a separate variant and options panel.
- Narrow selection replaces the catalog and Back restores the selected card and keyboard focus.
- Added the accepted CPU, RAM, Claude Usage, and Codex Usage option effects.

## Verification results

- Workspace Rust tests pass.
- Clippy passes for all workspace targets with warnings denied.
- Prettier checks and all production frontend builds pass.
- Real Chromium integration passes catalog, option validation, option effects, narrow navigation, persistence, composition, and usage refresh scenarios.
- Nix flake checks pass.
