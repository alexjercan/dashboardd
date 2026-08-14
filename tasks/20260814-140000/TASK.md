# Add the Tatr Tasks widget

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, tatr, tasks, responsive

## Goal

Add a read-only 6x3 dashboard widget that parses Tatr projects directly and presents tasks across one project or a recursive project tree.

## Accepted design

### Identity and dimensions

- Name: `Tatr Tasks`.
- Widget ID: `tatr-tasks`.
- One `Full` variant.
- Canonical dimensions: 6 columns by 3 rows.
- Use one responsive frontend. Do not add a separate mobile variant before playtesting.

### Backend

- Implement Tatr-compatible project discovery, task parsing, filtering, and sorting in Rust.
- Never execute the `tatr` binary.
- Read metadata only: project, title, status, tags, priority, and task ID.
- Do not include task bodies or absolute filesystem paths in task snapshot payloads. Effective instance options retain the platform's existing API behavior.
- Poll filesystem metadata every 2 seconds and emit only changed snapshots.
- Invalid data emits an error while the frontend retains the last valid snapshot.

### Options

- Add a declarative text option type to the widget platform.
- `root`: text, default `~/personal`; accept absolute paths and `~/...`, with server-side tilde expansion.
- `recursive`: Boolean, default `true`.
- `filter`: text, default `:status in [OPEN, IN_PROGRESS]`; use Tatr query syntax.
- `sort`: static select with `created`, `priority`, and `title`; default `priority`.
- Any absolute root is permitted. No allowlist.
- Defer generated project multi-select filtering.

### Desktop frontend

- Columns: Status, Project, Task ID, Title, Tags, Priority.
- Show the complete Task ID in muted monospace text without click behavior.
- Quiet status badges: Open neutral, In Progress accent, Closed muted.
- Click sortable headers to change transient sorting.
- Click status badges or tags to toggle transient filters.
- Show active filters and a clear action.
- Keep the task list internally scrollable within fixed widget dimensions.

### Narrow frontend

- No horizontal scrolling.
- Use compact two-line task rows.
- Put status before the title and priority at the line end.
- Put project, the full Task ID, and tags on the second line.
- Task ID takes priority over tags. Truncate long titles and clip excess tags.
- Provide a compact sort selector.
- Target about seven visible desktop rows and five visible narrow rows.

### State behavior

- Manifest options define persisted backend scope and initial filtering/sorting.
- Header sorting and status/tag filtering are frontend-local and reset on reload.
- Invalid refreshes preserve the last valid visible task snapshot.
- The frontend requests a forced snapshot when mounted so browser reload does not wait for a filesystem change.

## Verification

- Parser fixtures cover valid records, strict invalid records, recursive discovery, filters, sorting, tilde expansion, and snapshot path non-disclosure.
- Browser integration covers adding the widget, desktop table behavior, narrow responsive behavior, local filters/sorting, and snapshot privacy.

## Implementation notes

- Added the platform `text` option type from source manifest preparation through runtime validation and generated controls.
- Added the packaged `tatr-tasks` backend and responsive frontend.
- The backend implements strict task metadata parsing, recursive project discovery, Tatr query parsing and evaluation, tilde expansion, metadata-based parse caching, deterministic sorting, and changed-result suppression.
- Snapshot payloads contain task ID, relative project name, title, status, tags, and priority. Bodies and absolute roots stay out of snapshots.
- The frontend uses a desktop table and container-query narrow rows in the same Full variant. Both layouts show the complete Task ID.
- Status and tag buttons apply local filters. Title and Priority headers and the narrow selector apply local sorting.
- Invalid scans retain the previous frontend snapshot because the backend emits an error without replacing it.
- Fixed browser reload waiting forever: mount now sends a refresh command and the backend force-emits its current snapshot even when filesystem content is unchanged.

## Verification results

- Tatr backend parser, filter, discovery, sort, tilde, and snapshot privacy tests pass.
- Dashboardd text-option tests and Clippy with warnings denied pass.
- Source manifest preparation and all production frontend builds pass.
- Chromium integration passes widget discovery, text configuration, 6x3 placement, full Task IDs, task rendering, status and tag filters, desktop sorting, narrow projection, unchanged-snapshot reload recovery, frontend serving, removal, and existing dashboard scenarios.
- Wide and 420 px screenshots were reviewed. The 6x3 widget remains 350 px tall, uses the full narrow projection, has no horizontal scrolling, and shows compact two-line rows.
- Full workspace tests, workspace Clippy with warnings denied, all production frontend builds, and Nix flake checks pass.

## Playtest notes

- The fixture view is intentionally sparse. A real `~/personal` scope should validate internal scrolling, project-label density, and tag clipping with a large task set.
- Effective instance options are public by existing platform design, so the configured root appears in instance APIs. Task snapshots and rendered task content omit it.
