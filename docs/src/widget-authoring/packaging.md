# Packaging and checks

`dashboardd-widget` converts built widget artifacts into an installed runtime bundle. It does not run a compiler or build system.

Install the tool from the dashboardd flake:

```bash
nix build github:alexjercan/dashboardd#dashboardd-widget
./result/bin/dashboardd-widget --help
```

## Source manifest

Source manifest schema version 2 is the input contract. The machine-readable schema is [`schemas/widget-source-v2.schema.json`](https://github.com/alexjercan/dashboardd/blob/master/schemas/widget-source-v2.schema.json).

Create `widget.toml` in the widget project:

```toml
schema_version = 2
id = "today"
name = "Today"
description = "Daily tasks, habits, and health"
backend = "dist/bin/today-dashboardd-widget"

[[variants]]
id = "summary"
name = "Summary"
width = 3
height = 2
frontend = "dist/frontend/summary.js"
focus = false
```

Backend and frontend values are paths to already-built artifacts. Paths are relative to the directory containing `widget.toml`. Absolute paths, empty paths, `.`, and `..` are rejected.

Options, inputs, and outputs use the same fields as the [runtime manifest](runtime-bundle.md). Source schema version 2 is a breaking replacement for the repository-specific schema version 1. Cargo package names, npm workspace names, and source entry points are not part of the public packaging contract.

## Pack

Build the project with its native tools, then pack it:

```bash
dashboardd-widget pack widget.toml --output dist/today
```

The output directory name must equal the widget ID. The command refuses an existing output directory. A successful pack writes:

```text
dist/today/
  widget.json
  bin/today
  frontend/summary.js
```

Artifact names inside the bundle are stable and independent of source artifact names. The backend receives executable permissions. Manifests and frontends receive non-executable permissions.

## Check

Validate an existing runtime bundle:

```bash
dashboardd-widget check dist/today
```

The check is static. It:

- Parses runtime manifest schema version 2.
- Rejects unknown fields and invalid metadata.
- Validates option defaults and link variant references.
- Rejects path traversal.
- Requires the bundle directory name to equal the widget ID.
- Requires readable declared artifacts and an executable backend.

The check never starts the backend. Backend lifecycle behavior is tested separately against the [backend protocol](backend-protocol.md).

## Nix

A widget derivation can build artifacts and call the packer during installation. Install the resulting directory under:

```text
$out/share/dashboardd/widgets/<widget-id>/
```

The packer does not rewrite runtime closures. Use a Nix-generated executable wrapper when a backend needs Python modules, shared libraries, or other store paths.
