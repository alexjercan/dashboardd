# Add Zen and routed edit modes

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, zen, editing, routing, frontend

## Goal

Make the primary dashboard a quiet widget-only Zen view while keeping editing permanently available through a dedicated route.

## Accepted design

### Routes

- `/` is Zen mode.
- `/edit` is the dashboard editor.
- `/edit/` redirects to `/edit`.
- Serve the same SPA entry point for `/` and `/edit`.
- Client transitions use real links plus History API.
- Browser Back, Forward, reload, bookmarks, and separate tabs preserve route-local mode.

### Zen mode

- Remove the visible Scufris Dashboard header.
- Retain a visually hidden page heading.
- Show only placed widgets and minimal fixed viewport controls.
- Put a 5 px status dot and 9 px connection label at bottom-left.
- Put a small Edit link at bottom-right.
- Do not fade or auto-hide controls.
- Reserve bottom space so controls do not cover widgets.

### Editor

- Show a compact sticky `Edit dashboard` header with Done linking to `/`.
- Keep existing slots, add/remove, dragging, swapping, keyboard movement, and persistence behavior.
- Entering `/edit` focuses the editor heading.
- Returning to `/` focuses Edit.
- Escape cancels active dragging but does not leave the editor.

### Empty dashboard

- `/` remains Zen mode when no widgets exist.
- Show a restrained `No widgets` empty state with an `Edit dashboard` link.
- Never force route-local edit mode because composition is empty.

## Verification

- Backend tests cover `/edit`, its SPA content, and `/edit/` redirect behavior.
- Browser integration covers Zen chrome, fixed controls, empty state, route transitions, focus, Back/Forward, reload, direct `/edit`, editor behavior, and cross-tab route independence.

## Implementation notes

- Added explicit `/edit` SPA serving and canonical `/edit/` redirection.
- Replaced local edit toggling with route-derived state and History API navigation through real links.
- Removed the visible header from `/` and added visually hidden page context.
- Added fixed minimal connection and Edit controls with reserved bottom space.
- Added the empty Zen state without forcing edit mode.
- Added a compact sticky editor header and route transition focus handling.
- Kept edit mode tab-local while composition updates continue to synchronize across tabs.

## Verification results

- Dashboardd route and redirect tests pass.
- Dashboardd Clippy passes with warnings denied.
- Prettier checks and all production frontend builds pass.
- Real Chromium integration passes empty Zen mode, fixed controls, transitions, focus, history navigation, direct editor loading, reload, route independence, composition editing, and persistence.
- Wide Zen and wide and narrow editor screenshots were reviewed.
- Workspace Rust tests and Nix flake checks pass.
