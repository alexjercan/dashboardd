# Widget variants

## Accepted design

- Dashboard uses nine canonical columns.
- One grid unit is 110 px with a 10 px gap.
- Edit mode shows at least nine columns by six rows.
- Full CPU and Memory variants are 3x3 and retain the existing detailed visuals.
- Compact CPU and Memory variants are 1x1.
- Mobile projects the canonical grid to three visual columns, so 3x3 variants use the full width.

Source manifests use ordered variant tables:

```toml
schema_version = 1
id = "cpu"
name = "CPU"

[backend]
package = "cpu"

[frontend]
workspace = "@scufris/cpu-widget"

[[frontend.variants]]
id = "full"
name = "Full"
size = [3, 3]
entry = "src/full.ts"

[[frontend.variants]]
id = "compact"
name = "Compact"
size = [1, 1]
entry = "src/compact.ts"
```

- Variant IDs are stable and explicit in instance resources and create requests.
- Runtime manifests use schema version 2 and do not support schema version 1.
- Dashboardd owns variant dimensions.
- Create requests contain `widget_id`, `variant_id`, and an anchor `position`.
- Move requests contain only an anchor `position`.
- Swaps exchange anchors and preserve each variant's dimensions.
- Widget descriptors expose each variant's ID, name, size, and frontend URL.
- The Add Widget dialog lists each variant directly under its widget name.
- Each variant builds as a separate frontend module.
- Widget frontend context includes `variantId`.

Compact CPU shows usage percentage, package temperature, and one-minute load. Compact Memory shows RAM percentage, used and total memory, and a severity bar. Compact variants omit graphs and detailed rows.

## Durable composition

Dashboard composition is stored in `dashboard.json`. Path precedence:

1. `DASHBOARDD_STATE_FILE`.
2. `$XDG_STATE_HOME/scufris/dashboard.json`.
3. `$HOME/.local/state/scufris/dashboard.json`.

The versioned file stores stable instance IDs, widget and variant IDs, and anchor positions. Dimensions are derived from installed variants during restoration. A missing file starts an empty dashboard. Invalid state, unknown definitions, duplicate IDs, collisions, or invalid positions fail startup without partial restoration.

Mutations are transactional relative to durable composition:

1. Lock composition and validate the proposed complete state.
2. Write a unique temporary file in the state directory.
3. Sync the temporary file, rename it over `dashboard.json`, and sync the directory on Unix.
4. Apply the in-memory mutation.
5. Emit SSE events and perform backend lifecycle work.

A save failure leaves memory and backend lifecycle unchanged, emits no event, and returns a generic `persistence_failed` API error while logging the filesystem detail. Create ID sequences may skip after failed writes. Remove stops its backend after the durable commit. Startup starts backends only after the complete saved composition validates.
