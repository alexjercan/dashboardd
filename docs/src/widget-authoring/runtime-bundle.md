# Runtime bundle

Runtime manifest schema version 3 is the installed widget discovery contract. The machine-readable schema is [`schemas/widget-runtime-v3.schema.json`](https://github.com/alexjercan/dashboardd/blob/master/schemas/widget-runtime-v3.schema.json). [`dashboardd-widget pack`](packaging.md) generates this manifest from a source `widget.toml`.

## Layout

```text
<widget-root>/
  <widget-id>/
    widget.json
    bin/<backend>
    frontend/<variant>.js
```

`DASHBOARDD_WIDGET_PATH` selects platform-separated widget roots. dashboardd reads roots in configured order, sorts bundles inside each root, and sorts the final catalog by widget ID. Missing roots, invalid bundles, and duplicate widget IDs stop startup. Search path order never overrides a duplicate.

Manifest paths must be relative normal paths. Absolute paths, `..`, `.`, roots, and platform prefixes are rejected. Declared files must be readable, and the backend must be executable. Symlinked files are accepted, which permits immutable Nix store composition. The bundle directory name must equal the manifest widget ID.

## Example

```json
{
  "schema_version": 3,
  "id": "today",
  "name": "Today",
  "description": "Daily tasks, habits, and health",
  "backend": "bin/today-dashboardd-widget",
  "variants": [
    {
      "id": "summary",
      "name": "Summary",
      "width": 3,
      "height": 2,
      "frontend": "frontend/summary.js",
      "launch_frontend": "frontend/summary-launch.js",
      "focus": false
    }
  ],
  "options": [],
  "inputs": [],
  "outputs": []
}
```

## Identifiers

Widget and variant IDs use lowercase ASCII letters, digits, and internal hyphens. Option and port IDs use lowercase ASCII letters, digits, and internal underscores. IDs are stable persistence keys.

## Variants

Each variant declares:

- A unique ID and non-empty display name.
- Positive grid width and height.
- One self-contained frontend ES module.
- Whether the variant supports Focus.

A frontend bundle must not depend on unserved relative chunks.

## Options

Supported option types are:

- `boolean`
- `text`, with optional `multiline`
- `integer`, with `minimum`, `maximum`, and positive `step`
- `select`, with one or more unique choices

Defaults must satisfy their type and constraints. `variants` limits an option to named variants. An empty list applies to every variant.

Options are public configuration. Never use options for secrets.

## Input and output ports

Inputs and outputs declare a unique ID, display name, semantic type, applicable variants, and whether an input is required. A host binds each input to one direct typed value or compatible dynamic output. Type strings must match exactly. dashboardd leaves input and output JSON values opaque.
