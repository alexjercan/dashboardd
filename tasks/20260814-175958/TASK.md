# Add Tatr task artifact viewing

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, tatr, artifact, viewer

## Goal

Upgrade the linked Tatr Details variant into a secure task artifact viewer with normal-mode file selection.

## Accepted design

- Keep persisted variant ID `details`; change its visible variant name to `Artifact`.
- Default every newly selected task to `TASK.md`.
- Show identity as `<project> // <task_id>/<artifact>`.
- Make the identity an interactive selector in Zen mode, matching existing Tatr local filter controls. Editor mode remains composition-only and disables widget content interaction. Clicking the identity opens a bounded, scrollable artifact menu without relying on Popover or `showPicker()` APIs.
- List supported regular files recursively in deterministic relative-path order, with at most 200 entries.
- Exclude hidden files, hidden directories, symlinks, absolute paths, parent traversal, and anything outside the selected task directory.
- Supported Markdown extensions are `.md` and `.markdown`.
- Supported sanitized HTML extensions are `.html` and `.htm`.
- Supported raster images are `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp`.
- Other regular files are available only when they contain valid UTF-8 text. Unknown binary files, SVG, PDF, video, and archives are not shown.
- Text, Markdown, and HTML are limited to 256 KiB. Raster images are limited to 2 MiB.
- Markdown keeps the current sanitized renderer. HTML strips scripts, forms, handlers, iframes, styles, remote assets, and other active content. Text always renders literally. Images use validated backend bytes and never local file URLs.
- External HTTP(S) links open safely. Relative links between listed supported text artifacts navigate inside the selected task. Embedded local images remain deferred.
- Selecting an artifact sends a `select_artifact` widget command with page-local view ID, project, task ID, and relative artifact path. Never execute `tatr` or shell commands.
- Details backend state remains isolated per page. Poll the selected artifact and artifact listing, suppress unchanged output, and preserve the last valid frontend artifact on refresh errors.
- Keep the selector available after load errors so another artifact can be chosen.
- Never expose the configured root or another absolute filesystem path.

## Later Projects design

- Projects will publish `scufris.project-selection/v1` and can page-locally filter Tatr Full to one project.
- Project rows can show compact accessible agent-type badges such as `pi 2`, `Codex 1`, and `Claude 1`, with no remote image or font assets.

## Verification plan

- Backend tests cover recursive listing, deterministic limits, hidden and symlink exclusion, containment, formats, size limits, UTF-8 fallback, image encoding, task reset, and artifact command validation.
- Browser integration covers default TASK.md, identity formatting, normal-mode menu interaction, Markdown, text, sanitized HTML, image display, relative navigation, mobile layout, reload reset, cross-tab isolation, and path privacy.
- Review wide and narrow screenshots for each useful content type.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before commit.

## Implementation notes

- Upgraded the visible Details variant name to Artifact while retaining persisted variant ID `details`.
- Added per-view artifact selection with `TASK.md` reset on every linked task selection and a validated `select_artifact` command.
- Added deterministic recursive artifact discovery with a 200-entry cap, hidden and symlink exclusion, regular-file checks, canonical task containment, normal relative path validation, and no absolute path payloads.
- Added 256 KiB UTF-8 text limits and 2 MiB raster image limits. Raster formats require matching file signatures before they enter the artifact list.
- Added Markdown, sanitized HTML, literal UTF-8 text, and base64 raster image payloads. SVG and common document, archive, and video formats are explicitly excluded.
- Added `project // task/artifact` identity rendering and a broadly compatible native Details-based menu that works with normal Tatr controls in Zen mode. Editor mode remains composition-only.
- Added safe external links and relative navigation between listed artifacts. Embedded local assets remain blocked.
- Kept backend updates page-correlated, polled, and change-suppressed. Failed refreshes retain the last valid artifact and menu in the frontend.

## Bugs and fixes

- The accepted draft initially said artifact selection would also work in editor mode, conflicting with the existing rule that disables all widget content while editing. Aligned it with current Tatr filter behavior after explicit approval: interactive in Zen, composition-only in editor.
- A selected artifact response can race an older polled response. The frontend tracks the requested artifact and ignores mismatched per-view snapshots.
- Image extension checks alone would label arbitrary bytes as images. Added PNG, JPEG, GIF, and WebP signature checks before listing.
- Generic shell selectors also matched semantic elements inside sanitized HTML. An artifact `<header>` received the shell stacking context and rendered above the open menu. Added shell-specific classes and stripped artifact `class`, `id`, and `style` attributes to isolate untrusted document presentation.

## Verification results

- Tatr backend tests and Clippy with warnings denied pass.
- Production frontend build and widget preparation pass.
- Chromium integration passes default TASK.md, identity formatting, menu selection, hidden-file exclusion, text, sanitized HTML, relative links, raster images, mobile rendering, cross-tab isolation, reload reset, and existing scenarios.
- Markdown, open-menu, image, wide, and 420 px screenshots were reviewed.
- Full workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
