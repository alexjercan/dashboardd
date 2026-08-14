# Add user configuration, themes, and dashboard bootstrap

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: configuration, theme, dashboard, persistence, sse

## Goal

Allow users to configure the public dashboard theme and one-time initial widget composition through a read-only TOML file.

## Accepted design

### Configuration file

- Resolve the file in this order:
  1. `DASHBOARDD_CONFIG_FILE`
  2. `$XDG_CONFIG_HOME/scufris/config.toml`
  3. `$HOME/.config/scufris/config.toml`
  4. Built-in defaults when the resolved file is absent.
- `config.toml` is user-authored and dashboardd never writes it.
- Reject unknown fields and invalid values.
- Invalid theme or file structure stops startup.
- Validate initial widget references and placement only when bootstrap is needed.

### Theme

- `[theme]` supports optional six-digit hexadecimal values for every existing semantic Scufris color token.
- Missing values use built-in colors.
- Expose the effective public theme through the dashboard API.
- Apply the effective theme before mounting widget frontends.
- Watch the selected configuration path, including atomic editor replacement.
- Debounce file events and reload the complete configuration.
- A valid live update publishes the effective theme through SSE and updates open tabs without remounting widgets.
- An invalid live update keeps the last valid theme, logs the failure, and shows a dashboard configuration error.
- A later valid update clears that configuration error.
- Deleting the file applies the built-in theme. Recreating it applies its theme.
- Restarting dashboardd always loads the latest valid file.

### Initial widgets

- `[[dashboard.initial_widgets]]` declares widget, variant, one-based `[column, row]` position, and optional option values.
- Validate widget IDs, variants, options, bounds, and collisions atomically.
- Apply initial widgets only when `dashboard.json` does not exist.
- Persist the normalized initial composition before starting widget backends.
- Once state exists, including an empty state, `dashboard.json` is authoritative.
- Hot reload never validates, reapplies, or reconciles initial widget semantics.
- Deleting `dashboard.json` explicitly permits bootstrap on the next startup.

### Ownership

- `config.toml` owns public appearance and startup defaults.
- `dashboard.json` owns mutable composition after bootstrap.
- Manual dashboard edits never rewrite `config.toml`.

## Verification

- Unit tests cover path precedence, defaults, strict parsing, color validation, and initial widget parsing.
- Backend tests cover atomic bootstrap validation, normalization, persistence, and state precedence.
- Browser integration covers startup theme application, live valid updates, visible invalid-update errors, recovery, inherited widget colors, and one-time composition bootstrap.

## Implementation notes

- Added strict optional TOML loading with documented environment, XDG, and home precedence.
- Added effective semantic theme state, a public theme resource, and SSE theme and configuration-error events.
- Added a debounced filesystem watcher that handles direct writes, atomic replacements, deletion, and recreation.
- Live parse or validation failures retain the last valid theme. A later valid reload publishes theme state again so open tabs clear the configuration error.
- Added one-based initial widget parsing and complete widget, variant, option, bounds, and collision validation.
- Initial composition is normalized and persisted before backend startup only when no state file exists.
- Added frontend theme parsing and root CSS variable updates. Existing widget Shadow DOM inherits changes without remounting.

## Verification results

- Workspace Rust tests pass.
- Clippy passes for all workspace targets with warnings denied.
- Prettier checks and all production frontend builds pass.
- Real Chromium integration passes initial themes, live updates, invalid-update retention and errors, recovery, inherited widget colors, bootstrap normalization, and state precedence.
- Nix flake checks pass.
