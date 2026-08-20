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
npm run test:sdk
npm test
nix flake check
```

`npm test` builds the complete Rust workspace and frontend workspaces, prepares every bundled widget, and runs real Chromium HTTP and SSE scenarios. Failure logs and screenshots are written under `tests/artifacts/`.

## Rust workspace map

- `dashboardd-runtime` - reusable widget runtime, instance lifecycle, state, events, health, and HTTP router.
- `dashboardd-server` - default HTTP host. Installs the `dashboardd` binary.
- `dashboardd-desktop` - Tauri tray service and native window host.
- `dashboardd-desktop-control` - desktop control protocol library and `dashboardctl` binary.
- `dashboardd-widget-protocol` - JSON-line contract shared by the runtime and widget backends.
- `dashboardd-widget-bundle` - widget bundle packing and validation library. Installs the `dashboardd-widget` binary.

`dashboardd-server` and `dashboardd-desktop` host `dashboardd-runtime`. Widget backends depend only on `dashboardd-widget-protocol`. The Tauri host and `dashboardctl` share only `dashboardd-desktop-control`.

## Common commands

```bash
npm run build
cargo xtask widget prepare --all
DASHBOARDD_WIDGET_PATH=.build/widgets cargo run -p dashboardd-server --bin dashboardd
DASHBOARDD_STATE_FILE=/tmp/runtime.json cargo run -p dashboardd-server --bin dashboardd
RUST_LOG=dashboardd=debug,tower_http=debug cargo run -p dashboardd-server --bin dashboardd
```

`xtask` builds each repository backend and frontend, stages the backend artifact, and calls the shared `dashboardd-widget` packer. It contains the repository-specific Cargo and npm orchestration. Test the generated bundle with:

```bash
cargo run -p dashboardd-widget-bundle --bin dashboardd-widget -- check .build/widgets/cpu
```

Build one frontend workspace with:

```bash
npm run build -w @dashboardd/cpu-widget
```

## Nix packages

```bash
nix build .#dashboardd
nix build .#bundled-widgets
nix build .#dashboardd-widget-bundle
```

`dashboardd` is the complete runnable package. `dashboardd-unwrapped` contains only the Rust server. `bundled-widgets` contains the built-in runtime bundles for explicit search-path composition.

## Widget SDK

```bash
npm run build --workspace @dashboardd/widget-sdk
npm run test:sdk
nix build .#widget-sdk
```

The SDK test packs the npm artifact, installs it into a temporary project outside the workspace, compiles an external TypeScript widget, verifies runtime and CSS exports, and rejects leaked source files.

## Documentation

```bash
npm run docs:build
npm run docs:serve
```

The documentation build installs mdbook-mermaid assets locally. Generated Mermaid JavaScript and `docs/book/` are ignored.

GitHub Actions builds the same mdBook output and publishes `master` to GitHub Pages.
