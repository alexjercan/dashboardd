# Add Vim dashboard keybindings

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, keyboard, vim, accessibility

## Goal

Add Vim-style keyboard operation to Zen and Editor without interfering with widget filters, text entry, or native-shell shortcuts.

## Accepted design

- Add explicit Dashboard and Widget keyboard modes in Zen.
- Dashboard mode owns unmodified dashboard commands. Widget mode gives keyboard input to the selected widget.
- Use one visible canonical-cell cursor in desktop Zen and Editor. `h`, `j`, `k`, and `l` move it one cell without wrapping. Do not provide dashboard keyboard handling on projected mobile layouts.
- `g g` moves the cursor to canonical cell `0,0`. Do not add previous/next widget bindings.
- A widget is under the cursor when any part of its canonical layout occupies that cell.
- Make normal and Move cursor navigation widget-aware. Empty space moves one cell. A directional key while the normal cursor occupies a widget jumps to the first cell beyond that widget. A directional key while the Move ghost overlaps destination widgets jumps the complete ghost beyond those widgets. Keep clamping and no wrapping.
- In Zen, use `i` or Enter to enter the widget under the cursor, `f` to open it in Focus, `e` to open Editor, `d` to open the command palette prefilled with `dashboard `, `g h` to open dashboard home, `:` to open an empty command palette, and `?` to open keybinding help.
- Do not add dashboard-level search.
- In Widget mode, widgets receive normal text, navigation, and activation keys. `Esc` returns to Dashboard mode.
- Clicking inside a Zen widget enters Widget mode. Clicking the canvas returns to Dashboard mode. Focus starts in Widget mode.
- Editor remains non-interactive. Use `h`, `j`, `k`, and `l` to move the cell cursor, `g g` to move it to `0,0`, `a` to add at the cursor when empty, `x` to request confirmed removal of the widget under it, `z` or `Esc` to return to Zen, `d` for dashboard completion, `g h` for home, `:` for commands, and `?` for help.
- Pointer dragging remains the primary widget movement control. Keep existing focused-handle arrow movement for accessibility.
- Preserve cursor coordinates between Zen and Editor. Initialize them from a pointer-selected widget's top-left cell or `0,0`.
- Keep destructive confirmation and all server-owned placement validation.
- In Zen Dashboard mode, render an empty-cell cursor as a 1 px dashed accent border at about 35% opacity. When occupied, hide that cell border and outline the complete widget with a 2 px accent border and small tint. Widget mode hides both.
- In Editor, empty space uses a one-cell cursor. Over an occupied cell, expand the visible cursor to the complete widget bounds from its top-left and apply the same dashed inset and dimmed treatment used for the Move source.
- Add staged Editor Move mode with `v`: require a widget under the cursor, snap the cursor to its top-left cell, show a widget-sized ghost, move the ghost with `h`, `j`, `k`, and `l`, commit one server-owned move or swap with Enter, and cancel with Escape or `v`. Show `MOVE` in mode hints.
- Add Vim operation to Add Widget. In the catalog, `j`/`k` navigate widgets, `gg`/`G` select boundaries, `l` or Enter configures, Escape closes, and `?` shows contextual help. In configuration, `j`/`k` navigate variants, `h` returns, `a` confirms when valid, Tab navigation remains native, Escape closes, and `?` shows contextual help. Do not intercept option or link controls.
- Escape precedence is transient menu, dialog, Move mode, Widget mode, selection or route action as applicable.
- Inspect `event.composedPath()` and active keyboard mode so Shadow DOM inputs, textareas, selects, contenteditable elements, and dialogs keep expected browser behavior.
- Show a small fading mode and key-hint overlay in Zen.
- Add application-owned command completion. Filter candidates while typing, use Up/Down to highlight, Tab to complete, Enter to execute, Escape to close, and retain bounded page-session command history. Do not add `Ctrl+P` or `Ctrl+N` bindings.
- Add dashboard-home keyboard operation: `h`, `j`, `k`, and `l` select cards spatially; `g g` and `G` select first and last; Enter opens Zen; `e` opens Editor; `a` creates a dashboard; `:` opens commands; `?` opens help; and Escape clears selection. Keep rename, duplicate, and delete in Manage only.
- Route keyboard events, visible controls, command-palette actions, and future Tauri events through one frontend dashboard-command dispatcher.
- Keep OS-global shortcuts separate and modifier-based. Future Tauri support can dispatch the same commands without creating a second in-window keybinding implementation.

## Initial command palette

- `:edit` opens Editor.
- `:zen` opens Zen.
- `:focus` focuses the selected widget.
- `:dashboard <name>` opens a dashboard by exact name.
- `:home` opens dashboard home.
- `:help` opens keybinding help.
- Command completion includes commands, dashboard names, and route-appropriate forms.
- Do not add search or theme mutation in this task.

## Verification

- Test Zen and Editor grid cursor movement, widget-aware skipping, cursor preservation, Widget mode entry and exit, Focus, Editor add and confirmed removal, dashboard switching, command completion, command history, and help.
- Test dashboard-home navigation, open, edit, create, commands, and help.
- Test Zen empty and occupied cursor appearance, Editor occupied highlighting, staged move and swap preview/commit/cancel, and Add Widget catalog/configuration bindings including option-input isolation.
- Test that text filters can type every dashboard command key without navigation or route changes.
- Test Shadow DOM composed event paths and click-based Widget mode entry.
- Test narrow and wide layouts, dialogs, SSE rerenders, and route changes.
- Run production frontend build and Chromium integration for implementation batches.
- Run workspace tests, Clippy with warnings denied, formatting, widget preparation, and Nix flake checks before finalization.

## Native-shell direction

- Build a later Tauri shell around the existing web frontend and Rust server.
- Use the shared dashboard-command dispatcher for Tauri tray and native shortcut events.
- Restrict system-wide shortcuts to configurable modifier combinations such as `Ctrl+Alt+D`, `Ctrl+Alt+E`, and `Ctrl+Alt+F`.
- Treat sidecar ownership, loopback authentication, autostart, tray behavior, and OS-specific wallpaper windows as a separate design and implementation task.

## Implementation notes

- Added one dashboard-command dispatcher for Zen, Focus, Editor, help, palette, and future native-shell event adapters.
- Added a route-independent canonical cell cursor shared by desktop Zen and Editor. It clamps without wrapping, targets any widget occupying its cell, and is disabled with other dashboard key handling on mobile projection.
- Added Dashboard and Widget modes. Widget mode leaves ordinary widget keyboard input untouched and uses capture-phase Escape only to return to Dashboard mode.
- Added composed-path input guards and click/focus mode transitions so widget filters and controls retain browser behavior.
- Added cursor styling, fading mode hints, route-specific keyboard help, and a reusable command-palette component.
- Added token-prefix command completion, Up/Down highlighting, Tab completion, execution, errors, and bounded page-session history without Ctrl-based bindings.
- Added `edit`, `zen`, `focus`, `home`, `dashboard <name>`, `new`, and `help` commands. Search and theme mutation remain excluded.
- Added Editor cursor add and confirmed remove actions without changing server placement authority. Pointer dragging remains primary movement and focused drag handles retain arrow movement.
- Added dashboard-home card navigation, first/last selection, open, edit, create, command, and help bindings while keeping management operations in the existing menu.
- Added `d` dashboard completion, `gh` home routing, and transient `details` menu precedence before mode and route Escape actions.
- Reduced the empty Zen cursor to a low-opacity dashed cell and replaced the occupied-cell marker with a whole-widget outline and tint. Editor expands the visible occupied cursor to the widget's complete canonical bounds and uses the same dashed, dimmed treatment as the Move source.
- Added staged `v` Move mode with a widget-sized ghost, source marker, clamped movement, single commit, server-owned move or swap, and reversible cancellation.
- Made both cursor modes widget-aware: directional movement skips the complete occupied widget or overlapping destination region while empty space retains one-cell movement.
- Added contextual Add Widget help and Vim catalog/configuration navigation while preserving native option and link input handling.

## Bugs and fixes

- Focus previously closed on the first Escape. Focus now starts in Widget mode: the first Escape returns to Dashboard mode and the second closes Focus.
- Home dashboard refresh events could detach a Manage action after a direct rename refresh. Successful dashboard loads now cancel their pending redundant refresh.
- Restoring focus after closing help or command dialogs initially reset the Zen cursor to the previously focused widget. Frame focus now changes cursor position only for Editor controls or actual widget-content entry.
- A closed command dialog could retain input focus and suppress subsequent dashboard commands. Editable-path guards now ignore controls inside closed dialogs.
- Focused drag-handle movement overwrote its movement announcement with a cursor announcement. Passive pointer and focus cursor updates no longer announce.
- Closing Add Widget restored focus to an old widget frame and moved the cursor away from the added widget. Bare frame focus restoration no longer changes cursor position; actual Editor controls and widget content still do.

## Verification results

- Production frontend build passes.
- Chromium integration passes Zen and Editor cursor movement, occupied-widget cursor expansion, widget-aware normal and ghost skipping, clamping and preservation, Widget mode isolation, command completion, dashboard selection, home bindings, staged move cancellation and swaps, Add Widget menu navigation and option isolation, keyboard add/remove actions, accessible drag-handle movement, Focus Escape precedence, desktop text-filter typing, mobile key exclusion, dashboard lifecycle, and all existing scenarios.
- Reviewed wide Zen, wide Editor, wide Move mode, wide home, and narrow Projects screenshots with cursor, source, destination, and mode hints.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
