# Configuration

dashboardd never writes its optional TOML configuration file. Invalid startup configuration stops dashboardd. An invalid live theme update preserves the last valid theme and reports the error.

## Theme

Colors use six-digit hexadecimal values. Font families must be installed on the system.

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

Unspecified values retain built-in defaults.

## Dashboard composition

Each browser stores its Dashboard documents, placements, and links in local storage. The runtime starts with no instances and recreates a browser's instances when that browser reconnects. Separate browser profiles can keep different Dashboard compositions against one runtime.

Widget options and Dashboard documents are public browser data. Do not place credentials, tokens, or sensitive paths in them.

## Environment variables

- `DASHBOARDD_CONFIG_FILE` - configuration file override.
- `DASHBOARDD_STATE_FILE` - browser server package-wide widget state file override. Runtime instances and Dashboard composition are not stored in this file.
- `DASHBOARDD_DESKTOP_STATE_FILE` - desktop runtime package-wide widget state file override. Defaults to `$XDG_STATE_HOME/dashboardd-desktop/runtime.json` or `$HOME/.local/state/dashboardd-desktop/runtime.json`.
- `DASHBOARDD_WIDGET_PATH` - platform-separated installed widget roots. An explicit value replaces the packaged default. Empty means no widgets. Missing roots, empty path entries, invalid bundles, and duplicate widget IDs stop startup.
- `DASHBOARDD_WEB_DIR` - dashboard frontend asset directory. Defaults to `crates/dashboardd-server/frontend/dist` for source development.
- `DASHBOARDD_PORT` - listen port.
- `RUST_LOG` - Rust tracing filter.

Nix can compose widget packages without copying them:

```nix
environment.variables.DASHBOARDD_WIDGET_PATH =
  lib.makeSearchPath "share/dashboardd/widgets" [
    inputs.dashboardd.packages.${pkgs.system}.bundled-widgets
    inputs.today.packages.${pkgs.system}.dashboardd-widget
  ];
```

Search path order does not provide overrides. Every widget ID must be unique.
