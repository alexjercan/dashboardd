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
