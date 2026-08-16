# dashboardd

Local-first dashboard for monitoring and controlling a computer.

## Development

Requires the Nix development shell. The project uses one npm workspace for the
dashboard, widget SDK, and widget frontends.

```bash
nix develop
npm install
npm run build
cargo xtask widget prepare --all
cargo run -p dashboardd
```

`cargo xtask widget prepare` builds source manifests from `widgets/*/widget.toml`
into runtime bundles under `.build/widgets`. Development bundles use artifact
symlinks. Use `--copy --release` to make a standalone packaging bundle.

Widget manifests can declare Boolean, text, bounded integer, and static select
options. dashboardd validates submitted values, persists effective values, and
provides active values to the backend initialization message and frontend
`WidgetContext.options`. Option values are public instance configuration. Do
not use them for credentials or other secrets.

Variants can declare typed input and output ports. Dashboardd validates and
persists links between compatible placed instances. Frontends use
`WidgetContext.links.publish()` and `subscribe()` for page-local linked view
state. Link payloads reset on reload and remain independent between tabs.

Packaged frontends can use `WidgetContext.sharedState` for bounded package-wide
JSON state. `get()` reads the current value, `subscribe()` receives synchronized
updates, and `mutate()` retries revision conflicts. Dashboardd persists shared
state in `dashboard.json` before publishing updates. Shared state is public
widget data and must not contain credentials or filesystem paths.

Useful commands:

```bash
npm run build -w @dashboardd/cpu-widget
npm run watch -w @dashboardd/cpu-widget
npm run watch -w @dashboardd/memory-widget
npm run watch -w @dashboardd/disk-widget
npm run watch -w @dashboardd/network-widget
DASHBOARDD_WIDGETS_DIR=.build/widgets cargo run -p dashboardd
DASHBOARDD_STATE_FILE=/tmp/dashboardd-dashboard.json cargo run -p dashboardd
RUST_LOG=dashboardd=debug,tower_http=debug cargo run -p dashboardd
npm test
```

`npm test` builds the application and runs the real Chromium HTTP/SSE flow. Set
`CHROMIUM_PATH` if Chromium is not on a standard system path. Failure logs and
screenshots are in `tests/artifacts`.

Set `RUST_LOG=dashboardd=debug,tower_http=debug` for backend lifecycle,
telemetry, widget discovery, and HTTP request logs. The browser console also
reports connection, reconciliation, event, and widget mount activity.

Open `/` for the dashboard home. Each dashboard card provides a metadata-only
layout preview plus Open, Edit, Rename, Duplicate, and Delete actions. Create an
empty dashboard from the home or the dashboard switcher. Dashboard routes are
`/d/<dashboard-id>` for Zen and `/d/<dashboard-id>/edit` for the editor.
Variants that opt in show a `Focus` control in Zen mode. Focus uses
`/d/<dashboard-id>/focus/<instance-id>`, preserves the mounted frontend, and
fills the viewport. Desktop Zen and Editor share a visible Vim-style cell
cursor. Use `hjkl` to move through empty cells and skip complete occupied widgets, `gg` for the first cell, `i` or Enter to interact
with the widget under it, `f` for Focus, `e` for Editor, `d` for dashboard
completion, `gh` for home, `:` for commands, and `?` for help. Widget mode
passes normal keys to filters and other controls; Escape returns to Dashboard
mode. In Editor, `a` adds at an empty cursor cell, `x` requests confirmed
removal of the widget under it, `v` stages a ghost move or swap for Enter to
commit, and `z` returns to Zen. The Add Widget dialog supports `jk` catalog and
variant navigation, `l` or Enter to configure, `h` to return, and `a` to add;
option controls retain normal input. Dashboard home supports card navigation,
open, edit, create, commands, and help keys. Focus starts in
Widget mode, so Escape first leaves widget
interaction and a second Escape closes Focus. The close button and browser Back
also close Focus. The editor shows server-owned backend health for each widget. Health diagnostics
include liveness, the last update and error, and a confirmed manual restart.
Dashboardd probes backends every 10 seconds and marks them stale after 30 seconds
without protocol activity. Zen mode does not show health controls. The fixed Zen
controls keep connection status and Edit available without scrolling. Open the
Swagger API documentation at the logged `/docs` URL.

The Disk widget reports root-filesystem capacity and I/O without exposing mount
paths or device names. The Network widget aggregates active non-loopback
interfaces without exposing interface names, addresses, or MAC addresses. Both
refresh once per second and use IEC units.

The Projects widget provides 3x2 Project Pulse and Project Brief variants.
Pulse scans immediate children of configured local roots, ranks pinned and
attention-worthy projects, and publishes page-local project selection. Its
Manage dialog controls up to three durable ordered pins and page-local Git
worktree selection. Brief shows branch, working-tree state, task activity, and
a project-document excerpt. Its Focus presentation securely renders bounded
root and `docs/` Markdown or text documents and provides changed-file and local
branch research views. Git inspection uses fixed bounded local commands without
shell, remote, or write operations. Documents reject symlinks, hidden paths,
oversized files, active HTML, and embedded images. Absolute paths, remote URLs,
and author identities remain outside browser payloads. Linked Tasks and Brief
widgets follow the selected worktree.

The 3x3 Tatr Tasks widget reads every `TASK.md` record directly without
executing `tatr`. It defaults to recursive discovery under `~/personal`, sorts
by priority and hides closed tasks by default. Normal mode uses readable
two-line task summaries. Focus adds the page-local Hide closed control, search,
sort, complete IDs, tags, and metadata. The linked 3x3 Task Artifact variant defaults to `TASK.md`
and can securely select task-local Markdown, sanitized HTML, UTF-8 text, and
raster images from its normal-mode identity menu. Absolute paths, symlinks,
active HTML, embedded local assets, and unsupported binaries remain
unavailable. Its Focus presentation provides a larger document and image
surface while retaining the selected artifact.

Dashboard compositions persist in `$XDG_STATE_HOME/dashboardd/dashboard.json`, or
`$HOME/.local/state/dashboardd/dashboard.json` when `XDG_STATE_HOME` is unset.
`DASHBOARDD_STATE_FILE` overrides both paths. Each dashboard owns independent
instances, placement, options, links, and a canonical 3 to 24 column canvas.
Desktop dashboards fill the viewport and derive rows from their aspect ratio and
occupied content. Narrow screens project the canonical layout into a scrolling
three-column view. All dashboards remain running for immediate switching and
use globally unique instance IDs. Package shared state remains global. State
schemas are prototype-only and are not migrated; an old or invalid state file
stops startup.

## User configuration

Dashboardd reads configuration from `DASHBOARDD_CONFIG_FILE`, then
`$XDG_CONFIG_HOME/dashboardd/config.toml`, then `$HOME/.config/dashboardd/config.toml`.
The file is optional and dashboardd never writes it.

Theme values are optional six-digit hexadecimal colors. Valid changes apply to
open dashboards automatically. An invalid startup file stops dashboardd. An
invalid live change preserves the last valid theme and shows an error.

```toml
[theme]
canvas = "#181818"
surface = "#282828"
accent = "#ffdd33"
text = "#e4e4ef"

[theme.fonts]
sans = "Iosevka"
mono = "Iosevka"
```

Font families use system-installed fonts and retain built-in system fallbacks.
The default `Iosevka` family matches the regular font configured for Kitty.

Initial widgets apply and are validated only when `dashboard.json` does not
exist. Positions are one-based. The normalized composition is then persisted
and manual dashboard edits remain authoritative.

```toml
[[dashboard.initial_widgets]]
widget = "cpu"
variant = "full"
position = [1, 1]

[dashboard.initial_widgets.options]
show_core_temperatures = true
history_points = 40
```
