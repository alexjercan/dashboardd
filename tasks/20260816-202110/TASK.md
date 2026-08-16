# Redesign dashboard widgets for readable glance views

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: dashboard, composition, navigation, persistence

## Status

Complete.

## Accepted design

- Use 14 px minimum for primary widget content, 12 px for secondary content, 16-18 px headings, and 11 px only for tertiary graph metadata.
- Replace Projects `list`, `pinned`, and `project` variants with breaking `pulse` and `brief` variants.
- Project Pulse is 3x2, retains durable pins, ranks attention-worthy projects, and selects linked project context.
- Project Brief is 3x2. Normal mode shows project state and useful context. Focus shows safe project documents, changes, and branches.
- Keep Tatr variant IDs `full` and `details`. Tasks becomes 3x3 and Focus-enabled. Task Artifact remains 3x3 and Focus-enabled.
- Load all Tatr tasks. Show a visible `Hide closed` toggle, disabled by default.
- Keep Task Artifact separate from Tasks Focus.
- Add provider names to Claude and Codex 1x1 widgets.
- Reduce RAM Full to 3x2, remove duplicate usage presentation, and improve graph and metric use.
- Keep CPU variants and information. Improve typography and spacing only.
- Add no compatibility layer for removed project variants. Update this machine's composition once.

## UX invariant

Normal mode answers the widget's primary question. Focus adds research detail and does not gate the primary answer.

## Implementation

- Replaced the three Projects variants and their dead frontend sources with Project Pulse and Project Brief.
- Added attention ranking, durable pin management, and page-local worktree selection to Pulse.
- Added bounded project-document discovery, sanitized Markdown rendering, document selection, changed files, and branches to Brief Focus.
- Redesigned Tasks as readable two-line rows. Added all-task loading, visible Hide closed control, and Focus-only search, sort, IDs, and tags.
- Increased Task Artifact, CPU, RAM, and usage-widget typography.
- Added provider labels to Claude and Codex minimal variants.
- Reduced RAM Full to 3x2 and replaced duplicate bars with a larger graph and direct metrics.
- Updated this machine's saved composition to the new variants and all-task filter.
- Updated integration scenarios and product documentation.

## Security

- Project documents are limited to bounded root documents and Markdown or text files under `docs/`.
- Rejects symlinks, hidden path components, traversal, oversized files, and invalid UTF-8.
- Sanitizes Markdown, removes active HTML and images, isolates external links, and disables unresolved local links.
- Browser payloads retain opaque project identities and relative display paths only.

## Playtest follow-up

- Project navigation was intuitive in normal use.
- Project scroll thumbs were too narrow for reliable pointer control.
- Increased vertical and horizontal project scrollbar hit areas to 12 px with a 36 px minimum thumb.

## Bugs found and fixed

- Shared-state pin mutations required observable update boundaries before a second mutation.
- Project filter chips lost their stable CSS/test identity during the task-list rewrite.
- Advanced task Focus filters initially remained active after returning to the normal tile.
- TypeScript did not include DOM iterable support; document link traversal now uses `Array.from`.
- The project-document test created files after its Git baseline and unintentionally changed the expected working tree.

## Verification

- `nix develop -c cargo test -p projects -p tatr-tasks`
- `npm run format:check`
- `nix develop -c npm test`
  - Builds the complete Rust workspace and every frontend workspace.
  - Prepares all widget bundles.
  - Runs the complete Chromium integration scenarios.
