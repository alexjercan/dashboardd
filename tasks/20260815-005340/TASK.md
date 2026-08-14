# Add durable Pinned Projects

- STATUS: IN_PROGRESS
- PRIORITY: 100
- TAGS: widget, projects, pins, persistence, sdk

## Goal

Add a compact Projects Pinned variant with durable synchronized pin management and typed project selection.

## Accepted design

### Variant and composition

- Add `pinned`, named `Pinned`, as an independently addable 3x1 variant in the existing Projects package.
- Render at most three horizontal project blocks. Each shows project name, active task count, and latest local activity only.
- Clicking a block publishes its Primary checkout through `selected_project` using `scufris.project-selection/v1`.
- Pinned can replace Projects List as the one source linked to singular Project and optional Tatr project input. Pinned does not support Focus.
- Keep card rendering independent of row count so a future 3x2 six-pin variant can reuse the implementation.

### Pin management

- Projects List rows show an outline star when unpinned and a filled accent star when pinned. Stars remain synchronized and filled across reloads and tabs.
- Pinned has a compact Manage action. Empty blocks also open Manage.
- Manage uses a modal with literal case-insensitive fuzzy project-name search, pin and unpin controls, move-earlier and move-later controls, and explicit Done.
- Enforce a maximum of three pins. At the limit, unpinned stars are disabled with `Pinned project limit reached`; filled stars remain enabled for unpinning.
- New pins append. Persist explicit order. Missing projects remain as unavailable entries and can be unpinned.
- Use accessible labels `Pin <project>` and `Unpin <project>`.
- Pins identify repositories, not worktrees. Pin records contain only opaque `project_id` and safe `project` display name.

### Shared widget state

- Add package-wide `WidgetContext.sharedState`:
  - `get(): unknown`
  - `subscribe(handler): () => void`
  - `mutate(update): Promise<void>`
- Add `GET /api/v1/widget-state/{widget-id}` and `PUT /api/v1/widget-state/{widget-id}`.
- GET returns `{ widget_id, revision, value }`. PUT accepts `{ revision, value }` and returns the updated resource.
- Reject stale PUT revisions with HTTP 409. The browser shared-state bus retries mutations against the latest resource so concurrent tabs do not lose updates.
- Persist before runtime mutation and SSE emission. Cap serialized package state at 64 KiB. Default absent state to `{}`.
- Emit `widget_state_updated` SSE events and synchronize all mounted variants and tabs.
- Persist values in `dashboard.json` under top-level `widget_state`; revisions remain runtime-only.
- Retain shared state when no package instance is mounted or an instance is deleted.
- Keep `config.toml` read-only and do not add backend protocol messages.

### Projects state

```json
{
  "pins": [
    {
      "project_id": "project-...",
      "project": "nova-protocol"
    }
  ]
}
```

- Projects frontends strictly parse state, bound it to three unique records, and never accept paths.
- Projects List and Pinned use the same package-wide state.

## Verification plan

- Cover state-file migration and round-trip, persistence-before-event ordering, 64 KiB limits, stale revisions, unknown widgets, retained state without instances, API and OpenAPI resources, SSE parsing, reconnect reconciliation, SDK context isolation, mutation retry, and cross-tab updates.
- Cover manifest packaging, 3x1 layout, List stars, Manage search, limit behavior, ordering, unavailable pins, reload persistence, source links, Primary checkout publication, source deletion clearing, mobile rendering, and privacy.
- Review narrow and wide Pinned screenshots and the Manage modal.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before commits.

## Implementation notes

- Added package-wide bounded shared widget state to `dashboard.json`, with runtime revisions, GET and revision-checked PUT resources, persistence-before-mutation ordering, and `widget_state_updated` SSE delivery.
- Added `WidgetContext.sharedState` and a page bus that loads on subscription, reconciles after SSE reconnect, serializes same-page mutations, and retries cross-tab revision conflicts.
- Kept widget shared state out of backend process messages. Packaged frontends receive only their own package context, while dashboardd owns validation bounds, persistence, revisions, and events.
- Added the 3x1 Projects Pinned variant with three reusable card slots, Primary checkout selection output, active task counts, latest activity, unavailable placeholders, and page-local selected-card state.
- Added synchronized filled and outline stars to Projects List and Pinned Manage. State stores only bounded opaque project IDs and safe names.
- Added a modal Manage view with shared fuzzy name search, three-pin enforcement, accessible pin labels, explicit unpin, earlier/later ordering, and Done.
- Retained package state after deleting all Projects instances. A legacy schema-version-1 state file without `widget_state` loads with empty shared state.
- Kept card rendering independent of backend discovery and pin order so a future 3x2 variant can reuse the state and frontend model.

## Bugs and fixes

- Adding Pinned as another compatible source made browser tests that selected link sources by option index ambiguous. Tests now select the intended source by durable instance and port value.
- The first ordering assertion read cards before the asynchronous shared-state SSE update arrived. The test now waits for the moved card position before comparing the full order.
- Concurrent force reloads could return an older fetched state after the bus had already accepted a newer revision. Loads now return the highest revision retained by the bus.
- A selected pinned project that became unavailable could leave downstream links stale. Pinned now publishes null when discovery no longer resolves its selected project.

## Verification results

- Dashboard state, API, OpenAPI, event serialization, persistence ordering, stale revision, size bound, unknown widget, migration, and retained package-state tests pass.
- Production dashboard and Projects builds and formatting checks pass.
- Chromium integration passes 3x1 creation, concurrent cross-tab pin mutations, filled star synchronization, three-pin limits, Manage search, ordering, unpin and replacement, unavailable pins, reload persistence, package state without instances, List and Pinned source relinking, Primary checkout publication, source clearing, responsive rendering, and payload path privacy.
- Narrow Pinned, narrow Manage, and wide dashboard screenshots were reviewed.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
