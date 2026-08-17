# Quick start

## Requirements

- Nix with flakes enabled.
- Chromium for browser integration tests. The Nix shell provides it.

## Run packaged

```bash
nix run github:alexjercan/dashboardd#dashboardd
```

The package supplies the dashboard frontend and built-in widgets. Open the URL printed by dashboardd.

## Run from source

```bash
git clone https://github.com/alexjercan/dashboardd.git
cd dashboardd
nix develop
npm install
npm run build
cargo xtask widget prepare --all
DASHBOARDD_WIDGET_PATH=.build/widgets cargo run -p dashboardd
```

Open the URL printed by dashboardd. `/` is the dashboard home. The logged `/docs` path is the OpenAPI interface.

## Local files

dashboardd reads configuration from the first available path:

1. `DASHBOARDD_CONFIG_FILE`
2. `$XDG_CONFIG_HOME/dashboardd/config.toml`
3. `$HOME/.config/dashboardd/config.toml`

Dashboard composition is stored in:

```text
$XDG_STATE_HOME/dashboardd/dashboard.json
```

The fallback is `$HOME/.local/state/dashboardd/dashboard.json`. `DASHBOARDD_STATE_FILE` overrides both locations.

## Next steps

- Read [Navigation](user-guide/navigation.md) for keyboard operation.
- Read [Configuration](user-guide/configuration.md) for themes and initial widgets.
- Read [Widget authoring](widget-authoring/index.md) to understand the extension model.
