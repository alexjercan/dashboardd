# AGENTS.md

Global `~/AGENTS.md` applies.

## Project

- Local-first dashboard for monitoring and controlling one computer.
- Rust 2024 implements the runtime, servers, desktop host, protocols, widget
  backends, and packaging tools.
- TypeScript implements browser frontends and the widget SDK.
- Dashboard state, telemetry, and widget data remain local.

## Agent workflow

- Work directly on `master` unless the user requests an isolated worktree.
- Use tatr for tracked work. Create a task only when the user requests one.
- Use one task for one user request and its follow-up work. Create dependent
  tasks only when the user requests decomposition.
- Store task records and task-specific evidence under `tasks/`.
- Treat `README.md` as the user overview and `docs/src/` as durable
  documentation.
- Use local source, schemas, and fixtures before network research.

## Conventions

- Keep transport-free widget discovery, lifecycle, state, events, health, and
  direct operations in `dashboardd-runtime`.
- Keep HTTP APIs and browser assets in `dashboardd-server`.
- Keep Tauri hosting in `dashboardd-desktop` and its shared control protocol in
  `dashboardd-desktop-control`.
- Keep the JSON-line backend contract in `dashboardd-widget-protocol`.
- Keep widget packing and validation in `dashboardd-widget-bundle`.
- Widget backends depend only on the widget protocol. Repository-specific Cargo
  and npm orchestration belongs in `xtask`.
- Keep widget processes isolated and frontend contracts versioned through the
  schemas and SDK.
- Prefer clean breaking changes while state and extension contracts remain
  pre-release.
- Forbid unsafe Rust. Keep workspace Clippy warnings clean.
- Format Rust with rustfmt and frontend, schema, documentation, and workflow
  files with Prettier.
- Edit `docs/src/`, not generated `docs/book/` output.

## Verification

Run only checks relevant to the change:

```bash
cargo fmt --all -- --check
cargo test --workspace
npm run format:check
npm run docs:build
npm run test:sdk
npm test
nix flake check
```

`npm test` exercises the complete workspace, bundled widgets, and real Chromium
HTTP and SSE scenarios. Inspect failures and screenshots under
`tests/artifacts/`.
