# Add multiple dashboards

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, composition, navigation, persistence

## Goal

Add durable independently composed dashboards with a dashboard home, routed Zen, Editor, and Focus views, and safe migration of the existing composition.

## Accepted design

### Dashboard ownership

- Treat dashboards as first-class durable resources.
- Each dashboard owns its widget instances, placements, instance options, and typed links.
- Keep instance IDs globally unique. Reject links across dashboards.
- Keep package-wide `widget_state` independent from dashboard lifetime, including Projects pins.
- Keep all instances from all dashboards running so switching is immediate, telemetry stays warm, and separate browser tabs can show different dashboards.
- Allow zero dashboards.

### Routes and navigation

- `/` is the dashboard home.
- `/d/<dashboard-id>` is dashboard Zen mode.
- `/d/<dashboard-id>/edit` is dashboard Editor mode.
- `/d/<dashboard-id>/focus/<instance-id>` is dashboard Focus mode.
- Do not retain the old `/edit` route as a compatibility interface.
- Add a compact dashboard switcher to Zen and Editor controls. It links to Home, every dashboard, and New dashboard.
- Route identity, not global mutable selection, determines the dashboard shown in each tab.

### Dashboard home

- Show a responsive dashboard gallery.
- Each dashboard card shows its name, widget count, aggregate backend health, and a schematic layout preview generated from composition metadata. Do not mount widget frontends in previews.
- Cards provide Open and Edit actions plus Rename, Duplicate, and Delete actions.
- Show a Create dashboard tile and top-level Create action.
- When no dashboards exist, show a concise empty state with a Create dashboard action.

### Lifecycle

- Creating a dashboard asks for its name, creates an empty composition, and opens its Editor route.
- Names are non-empty trimmed display labels. Dashboard IDs are opaque and stable so renaming does not break routes.
- Duplicate copies instances, options, placement, and links into a new dashboard with new globally unique instance IDs and rewritten copied links. It does not copy page-local selection state or package-wide shared state.
- Delete requires confirmation, stops the dashboard's backends, and removes its instances and links without changing package-wide shared state. Deleting the final dashboard returns to the empty home.
- A missing dashboard or a Focus instance outside the routed dashboard shows a not-found state with a Home action.

### Persistence and migration

- Advance `dashboard.json` to schema version 2 with top-level `dashboards` and `widget_state`.
- A dashboard record contains `id`, `name`, `instances`, and `links`.
- Migrate valid schema-version-1 state by placing its existing instances and links in a dashboard named `Main`. Preserve `widget_state` exactly.
- Persist migration before serving. Invalid state continues to stop startup.
- `config.toml` initial widgets create a `Main` dashboard only when no state file exists. An existing schema-version-2 state with zero dashboards remains empty.

### API and synchronization

- Add dashboard collection and item resources for list, create, rename, duplicate, and delete.
- Scope instance, movement, option, restart, health, and link composition operations to a dashboard resource.
- Include `dashboard_id` in composition and health SSE events. Clients reconcile only the routed dashboard while package shared-state events remain global.
- Keep backend telemetry addressed by globally unique instance ID.
- Keep server ownership of dimensions, collision checks, links, persistence ordering, and lifecycle.

### Bounds and privacy

- Bound dashboard names and dashboard count to prevent unbounded durable state and navigation payloads.
- Keep previews metadata-only. Do not add paths, remote URLs, credentials, or widget payloads to dashboard resources.

## Verification plan

- Test schema-version-1 migration, empty schema-version-2 state, persistence, invalid records, and retained widget state.
- Test dashboard create, rename, duplicate, delete, limits, name validation, globally unique copied IDs, rewritten links, cross-dashboard link rejection, and backend shutdown.
- Test scoped layout collisions, options, health, restart, links, and SSE events.
- Test dashboard home gallery, schematic previews, health summaries, creation, empty state, navigation, switching, rename, duplicate, confirmation delete, Zen, Editor, Focus, missing routes, mobile rendering, reload persistence, and tab isolation in Chromium.
- Verify existing widget, Projects, Pinned, Tatr, Artifact, Focus, editor, responsive, and privacy scenarios under routed dashboards.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks.

## Implementation notes

- Added schema-version-2 persistence with durable dashboard records and global widget state. Schema-version-1 files migrate atomically into `Main` before runtime restoration.
- Added a bounded dashboard manager for zero to 32 dashboards and trimmed names of 1 to 64 Unicode characters. Sequential duplicate names use `<name> (1)`, `<name> (2)`, and safe truncation.
- Added dashboard-scoped instance, health, restart, message, layout swap, and link resources. Globally unique instance IDs remain stable across reloads.
- Added dashboard lifecycle resources and SSE events for create, rename, duplicate, and delete. Composition, health, telemetry, and errors now carry dashboard identity.
- Kept every dashboard backend running. Delete persists first, removes links, then stops the removed backends. Package shared widget state remains unchanged.
- Duplicate allocates new instance IDs, copies options and placement, rewrites internal links, persists before runtime mutation, and starts independent backends.
- Added `/` dashboard home with responsive metadata-only layout previews, aggregate health, Open and Edit actions, a Manage menu, Create tile, and zero-dashboard onboarding.
- Added routed `/d/<id>`, `/d/<id>/edit`, and `/d/<id>/focus/<instance-id>` views. The fixed dashboard switcher provides Home, dashboard choices, and New dashboard while preserving per-tab route identity.
- Split the browser entry point so dashboard home does not mount widget frontends. Home reconciles metadata after dashboard, composition, health, and theme events.
- Existing configuration initial widgets create `Main` only when no state file exists. A persisted empty dashboard collection stays empty after restart.

## Bugs and fixes

- Dashboard collection operations initially took the dashboard lock before awaiting the instance lock, opposite to composition mutations. Standardized lock order on instances then dashboard metadata to avoid deadlocks and non-Send handlers.
- Scoped persistence needed dashboard ownership for proposed instances before runtime insertion. Added dashboard identity to runtime instance resources and centralized deterministic state grouping.
- Link duplication could retain source IDs from the original composition. Duplicate now builds a complete old-to-new ID map and rewrites both endpoints before persistence.
- Existing browser helpers selected global API routes. Updated them to the routed dashboard API and made generic creation waits recognize any dashboard instance collection.
- Dashboard rename events initially left switcher names stale in other tabs. Dashboard views now reconcile switcher options on lifecycle events and return Home when their dashboard is deleted.
- Inline card management actions did not match the accepted overflow design. Moved Rename, Duplicate, and Delete into an accessible Manage disclosure.

## Verification results

- Dashboard persistence, legacy migration, empty state, name bounds, collection limit, CRUD, duplicate suffixes, copied IDs and links, cross-dashboard link rejection, API errors, OpenAPI, and event serialization tests pass.
- Chromium integration passes home creation, routed Zen and Editor history, Focus routes, all existing widget scenarios, dashboard rename, duplicate, independent IDs and compositions, tab isolation, switcher synchronization, deletion, responsive home previews, empty state, restart persistence, and initial-widget precedence.
- Wide, narrow, and empty dashboard-home screenshots were reviewed.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
