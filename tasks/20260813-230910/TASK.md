# Add dashboard widget dragging

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, editing, layout, dragging, accessibility

## Goal

Move widget instances between canonical dashboard slots in edit mode with pointer and keyboard input while keeping dashboardd authoritative.

## Accepted design

### Pointer interaction

- Use Pointer Events for mouse, touch, and pen.
- Use a compact six-dot drag handle centered at the top of each card in edit mode.
- Use the same handle interaction on desktop and mobile.
- Keep the Remove control separate and interactive.
- Disable widget-content interaction and text selection while editing, but preserve normal page scrolling when touch begins on the card.
- Apply `touch-action: none` only to the drag handle.
- Start dragging after a small movement threshold to avoid accidental drags.
- Capture the pointer during an active drag.
- Make the source card translucent while dragging.
- Highlight valid empty targets with the accent color and occupied targets as invalid.
- Escape cancels an active drag.

### Move behavior

- Move only to empty canonical slots.
- Do not swap widgets, push widgets, or reflow the grid.
- Dropping outside a valid target cancels.
- Keep the original authoritative layout while previewing.
- Send one `PATCH /api/v1/instances/{id}` after a valid drop.
- Apply the returned authoritative instance immediately.
- Restore the original position and show an API error if the server rejects the move.
- Synchronize successful changes to other pages through existing SSE events.

### Keyboard interaction

- Make cards focusable in edit mode.
- Arrow keys move one canonical cell.
- Reject out-of-bounds and occupied destinations without moving.
- Announce successful moves and errors through a polite live region.
- Normal mode removes card keyboard movement and preserves widget interactions.

### Scope

- Include pointer dragging, keyboard movement, target feedback, one-PATCH moves, rollback, cross-page synchronization, and desktop/mobile browser coverage.
- Exclude swapping, automatic reflow, resizing, and durable persistence.

## Verification

- Browser integration covers pointer move, source and target feedback, cancellation, occupied-target rejection, keyboard move, persistence after refresh, cross-page synchronization, mobile touch-compatible pointer behavior, and backend collision enforcement.
- Run focused formatting and production frontend build during implementation.
- Run the browser integration before playtest review.

## Implementation notes

- Added edit-mode drag handles with Pointer Events, an 8 px activation threshold, pointer capture, source opacity, and valid target highlighting.
- Kept touch scrolling on widget content by limiting `touch-action: none` to the drag handle.
- Disabled widget Shadow DOM interaction during edit mode to avoid accidental controls and text selection.
- Added arrow-key movement, unavailable-target feedback, and polite live-region announcements.
- Kept move previews local and send one authoritative PATCH only after a valid drop.
- Successful pointer and keyboard moves synchronize to other pages through existing SSE instance updates.

## Verification results

- Root frontend formatting and all production Webpack builds pass.
- Real Chromium integration passes handle dragging, target feedback, keyboard movement, occupied-target rejection, and cross-page synchronization alongside existing composition scenarios.
- Mobile playtest confirmed handle dragging and normal card-origin page scrolling feel acceptable.
