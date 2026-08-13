# Add atomic widget swapping

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, editing, layout, dragging, backend

## Goal

Allow two occupied dashboard widgets to exchange positions atomically through pointer dragging or keyboard movement.

## Accepted design

### API

- Add `POST /api/v1/layout/swap`.
- Request fields: `source_instance_id` and `target_instance_id`.
- Response contains both updated instances in an `instances` array.
- Lock instance state once and use current authoritative layouts.
- Exchange only anchor `column` and `row`; preserve each instance width and height.
- Validate the complete resulting dashboard before committing.
- Commit both layouts or neither.
- Publish one `instance_updated` SSE event per changed instance after commit.
- Return 404 if either instance is absent.
- Return 409 if the resulting layout is invalid.

### Interaction

- Dropping on an empty slot keeps the existing move behavior.
- Dropping on an occupied card invokes the atomic swap API.
- Show an accent swap contour on the occupied target during drag.
- Dropping outside a valid target cancels.
- Server failure preserves both original positions and shows the error.
- Arrow movement into an empty slot moves.
- Arrow movement into an occupied slot swaps.
- Movement outside canonical bounds remains unavailable.
- Announce successful swaps as `<source> swapped with <target>`.
- Restore focus to the source card after success.

### Future sizes

- Preserve each widget's dimensions while exchanging anchors.
- Reject swaps that would exceed bounds or overlap any instance after the exchange.
- Do not resize, push, or reflow widgets.

## Verification

- Backend tests cover success, missing instances, and invalid resulting layouts.
- Browser integration covers pointer card-to-card swap, keyboard swap, focus, announcements, and cross-page synchronization.
- Run focused formatting, dashboardd tests, frontend build, and browser integration before playtest review.

## Implementation notes

- Added an atomic instance-manager swap that locks once, exchanges authoritative anchors, validates both resulting layouts against all other instances and each other, then commits both.
- Added the documented `POST /api/v1/layout/swap` resource and response schema.
- Added occupied-card target detection and accent swap highlighting to handle dragging.
- Arrow movement now swaps with an occupied neighboring widget and still rejects out-of-bounds movement.
- Successful swaps update both local resources immediately, restore source focus, announce the result, and synchronize through two SSE updates.

## Verification results

- Focused dashboardd tests pass, including missing-instance swap behavior and existing layout validation.
- Dashboard production build passes.
- Real Chromium integration passes keyboard and pointer swaps, target feedback, focus restoration, and cross-page synchronization alongside existing movement and composition scenarios.
