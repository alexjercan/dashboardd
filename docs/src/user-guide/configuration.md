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

## Initial widgets

Initial widgets apply only when `dashboard.json` does not exist. Positions are one-based. The normalized composition is then persisted, and edits become authoritative.

```toml
[[dashboard.initial_widgets]]
widget = "cpu"
variant = "full"
position = [1, 1]

[dashboard.initial_widgets.options]
show_core_temperatures = true
history_points = 40
```

Widget options are public instance configuration. Do not place credentials, tokens, or sensitive paths in options.

## Environment variables

- `DASHBOARDD_CONFIG_FILE` - configuration file override.
- `DASHBOARDD_STATE_FILE` - state file override.
- `DASHBOARDD_WIDGET_PATH` - platform-separated installed widget roots. An explicit value replaces the packaged default. Empty means no widgets. Missing roots, empty path entries, invalid bundles, and duplicate widget IDs stop startup.
- `DASHBOARDD_WEB_DIR` - dashboard frontend asset directory. Defaults to `web/dist` for source development.
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
