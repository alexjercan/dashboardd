# dashboardd

Local-first dashboard for monitoring and controlling one computer.

dashboardd combines machine telemetry, AI usage, project attention, and tasks in a keyboard-driven interface. Widgets run as separate backend processes and render isolated browser frontends. Data and dashboard state remain local.

## Quick start

Requires Nix with flakes enabled.

```bash
git clone https://github.com/alexjercan/dashboardd.git
cd dashboardd
nix develop
npm install
npm run build
cargo xtask widget prepare --all
DASHBOARDD_WIDGETS_DIR=.build/widgets cargo run -p dashboardd
```

Open the URL printed by dashboardd.

## What is included

- Multiple responsive dashboards with Zen, Editor, and Focus views.
- Vim-style keyboard navigation.
- CPU, RAM, disk, network, Claude, and Codex telemetry.
- Linked Project Pulse, Project Brief, Tatr Tasks, and Task Artifact widgets.
- Versioned JSON process protocol and TypeScript frontend SDK for widgets.
- Local TOML configuration and JSON dashboard state.

## Documentation

Read the [dashboardd documentation](https://alexjercan.github.io/dashboardd/) for configuration, navigation, development, and widget authoring.

The project is in active prototype development. State and extension contracts can use clean breaking changes before their first public release.

## Development checks

```bash
cargo test --workspace
npm run format:check
npm run docs:build
npm test
nix flake check
```

## License

MIT
