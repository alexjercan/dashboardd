# Scufris

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

Widget manifests can declare Boolean, bounded integer, and static select
options. dashboardd validates submitted values, persists effective values, and
provides active values to the backend initialization message and frontend
`WidgetContext.options`. Option values are public instance configuration. Do
not use them for credentials or other secrets.

Useful commands:

```bash
npm run build -w @scufris/cpu-widget
npm run watch -w @scufris/cpu-widget
npm run watch -w @scufris/memory-widget
DASHBOARDD_WIDGETS_DIR=.build/widgets cargo run -p dashboardd
DASHBOARDD_STATE_FILE=/tmp/scufris-dashboard.json cargo run -p dashboardd
RUST_LOG=dashboardd=debug,tower_http=debug cargo run -p dashboardd
npm test
```

`npm test` builds the application and runs the real Chromium HTTP/SSE flow. Set
`CHROMIUM_PATH` if Chromium is not on a standard system path. Failure logs and
screenshots are in `tests/artifacts`.

Set `RUST_LOG=dashboardd=debug,tower_http=debug` for backend lifecycle,
telemetry, widget discovery, and HTTP request logs. The browser console also
reports connection, reconciliation, event, and widget mount activity.

Open the Swagger API documentation at the logged `/docs` URL.

Dashboard composition persists in `$XDG_STATE_HOME/scufris/dashboard.json`, or
`$HOME/.local/state/scufris/dashboard.json` when `XDG_STATE_HOME` is unset.
`DASHBOARDD_STATE_FILE` overrides both paths. An invalid saved composition stops
startup instead of discarding state.
