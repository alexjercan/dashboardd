# Development

Use the Nix development shell:

```bash
nix develop
npm install
```

## Checks

```bash
cargo fmt --all -- --check
cargo test --workspace
npm run format:check
npm run docs:build
npm test
nix flake check
```

`npm test` builds the complete Rust workspace and frontend workspaces, prepares every bundled widget, and runs real Chromium HTTP and SSE scenarios. Failure logs and screenshots are written under `tests/artifacts/`.

## Common commands

```bash
npm run build
cargo xtask widget prepare --all
DASHBOARDD_WIDGETS_DIR=.build/widgets cargo run -p dashboardd
DASHBOARDD_STATE_FILE=/tmp/dashboard.json cargo run -p dashboardd
RUST_LOG=dashboardd=debug,tower_http=debug cargo run -p dashboardd
```

Build one frontend workspace with:

```bash
npm run build -w @dashboardd/cpu-widget
```

## Documentation

```bash
npm run docs:build
npm run docs:serve
```

The documentation build installs mdbook-mermaid assets locally. Generated Mermaid JavaScript and `docs/book/` are ignored.

GitHub Actions builds the same mdBook output and publishes `master` to GitHub Pages.
