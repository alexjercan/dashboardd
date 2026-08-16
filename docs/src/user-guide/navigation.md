# Navigation

dashboardd uses modal Vim-style navigation. The footer shows the active mode.

## Dashboard mode

- `h`, `j`, `k`, `l` - move the cell cursor.
- `gg` - move to the first cell.
- `i` or `Enter` - interact with the widget under the cursor.
- `f` - focus the widget under the cursor when supported.
- `e` - open the editor.
- `d` - open dashboard completion.
- `gh` - return home.
- `:` - open commands.
- `?` - open help.

Widget mode passes normal keys to widget controls. `Escape` returns to Dashboard mode.

## Editor mode

- `a` - add a widget at an empty cursor cell.
- `x` - request confirmed removal.
- `v` - stage a move or swap.
- `Enter` - commit the staged move or swap.
- `z` - return to Zen.

The Add Widget dialog supports `j` and `k` navigation. Use `l` or `Enter` to configure, `h` to return, and `a` to add.

## Focus

Focus starts in Widget mode. The first `Escape` leaves widget interaction. The second closes Focus. The close button and browser Back also close Focus.

## Health

The editor shows server-owned backend health. Diagnostics include liveness, the last update, the last error, and manual restart. dashboardd probes backends every 10 seconds and marks them stale after 30 seconds without protocol activity.
