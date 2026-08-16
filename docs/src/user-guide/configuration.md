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
- `DASHBOARDD_WIDGETS_DIR` - installed widget root.
- `DASHBOARDD_PORT` - listen port.
- `RUST_LOG` - Rust tracing filter.
