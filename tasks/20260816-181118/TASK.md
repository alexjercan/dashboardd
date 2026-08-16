# Rename Scufris dashboard to dashboardd

## Status

Complete.

## Accepted design

- Rename this product and repository to `dashboardd`.
- Reserve `scufris` for the separate orchestrator product.
- Replace all active product identities: npm scope, CSS properties, browser labels, protocol port types, runtime paths, cache paths, and test prefixes.
- Keep `DASHBOARDD_*` environment variables and existing Rust crate names.
- Rename the sample project fixture from `scufris` to `sample`.
- Preserve older `tasks/*` records as historical artifacts.
- Do not add compatibility reads or migrations for old runtime paths.
- Move this machine's current state and cache once, outside application behavior.
- Rename the repository directory to `/home/alex/personal/dashboardd` after checks.

## Tradeoffs

- Existing installations must move their files manually or start with fresh state.
- Widget package names, CSS properties, and linked-port type names break immediately.
- Historical records retain the former name and remain searchable.

## Implementation

- Rebranded active source, manifests, package identities, browser labels, CSS properties, port types, runtime paths, tests, and documentation.
- Renamed the project fixture to `sample`.
- Regenerated npm workspace metadata and refreshed workspace links.
- Moved local configuration, dashboard state, and Claude usage cache to `dashboardd` directories.
- Left prior task records unchanged.
- Updated fuzzy-search inputs that still encoded letters from the former fixture name. The first full integration runs exposed both stale assumptions.

## Verification

- `cargo fmt --all -- --check`
- `npm run format:check`
- `git diff --check`
- `cargo metadata --no-deps --format-version 1`
- `npm ls --workspaces --depth=0`
- Parsed all tracked package manifests as JSON.
- Confirmed no former product-name references outside `tasks/`.
- `nix develop -c npm test`
  - Builds the Rust workspace and all frontend workspaces.
  - Prepares all widget bundles.
  - Runs the complete Chromium integration scenarios.
