# Add linked Projects widgets

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, projects, git, links, focus, tatr

## Goal

Add a local read-only Projects widget family with separate List and Project variants, typed project selection, Tatr filtering, and a rich singular Project Focus presentation.

## Accepted design

### Variants and composition

- Add one packaged `Projects` widget with `list` and `project` variants. Both are 3x3.
- List displays all discovered projects with project name, branch when available, compact clean/dirty state, scrolling, and selected-row highlighting. List does not support Focus.
- Project requires a linked List selection. Its tile shows the selected project name, branch, clean/dirty state, ahead/behind state, open and in-progress Tatr task counts, latest commit age, and up to three changed relative paths.
- Project supports the platform Focus presentation. Without a selection it shows `Select a project`.

### Typed links

- List output ID is `selected_project`, name is `Selected project`, and type is `scufris.project-selection/v1`.
- Project input ID is `project`, name is `Project list`, uses the same type, and is required.
- Tatr Full input ID is `project`, name is `Project filter`, uses the same type, and is optional.
- Selection payload is `{ project_id: string, project: string } | null`. `project_id` is an opaque stable identifier; `project` is the display name and initial Tatr matching key.
- One List output can feed Project and Tatr Full. Wiring is durable and server-owned; payloads are page-local, retained by each page link bus, and reset on reload.
- Selecting the active project again publishes `null`. Unlinking or deleting a source also clears target state.
- Tatr applies backend root/query first, then linked project, then local status/tag filters, then local sorting. Duplicate project names initially match all Tatr projects with that name.
- A project change that excludes the selected task clears Tatr selection and publishes `null`, so linked Artifact returns to `Select a task`.

### Link editor

- Replace Tatr-specific dashboard link labels with manifest-defined input/output names.
- Creation mode shows optional Tatr Project filter wiring with `Not linked` as default. Project list wiring is required.
- Editor badges show the input name and current source. Optional inputs can be unlinked.
- Tatr Zen mode shows only an informational active-project chip. It does not add a second project selector.

### Discovery and identity

- Add a multiline `roots` text option. Default lines are `~/personal`, `~/personal/_tests`, `~/work`, and `~/third-party`.
- Inspect immediate child directories of each root, matching the tmux sessionizer model.
- Include Git, Tatr, and ordinary directories. Ignore missing roots. Exclude hidden and symlinked children.
- Canonicalize and deduplicate directories, sort by project name then opaque ID, and cap discovery at 200 projects.
- Accept absolute and `~/...` roots. Reject other relative roots.
- Derive deterministic opaque project IDs from canonical server paths. Never expose absolute paths, remote URLs, author identity, or credentials.

### Git and task inspection

- Use fixed read-only `git` subprocess argument arrays without a shell or browser-controlled arguments.
- Disable terminal prompts, optional locks, external diffs, and text conversion. Do not fetch, invoke write operations, or access remotes.
- Apply two-second process timeouts, output bounds, concurrency bounds, and sanitized errors without absolute paths.
- Inspect branch, local upstream ahead/behind, working-tree status, staged/unstaged state, line counts, local branches, and latest local commit age/summary.
- Parse local Tatr task metadata natively. Never execute `tatr`.

### Focus

- Focus opens the one project selected by the linked List. Project selection remains owned by List; Focus does not add a competing project selector.
- Initial sections are Overview, Changes, and Branches.
- Overview includes project capabilities, Git state, task counts, latest local commit, and change totals.
- Changes includes relative paths, staged/unstaged state, status, line counts, search, and status filters. Full patch content is deferred because patches can expose credentials.
- Branches includes local names, current branch, local upstream, ahead/behind, latest commit age/summary, and search.
- Defer artifact previews, task browsing, commit history, tmux, agents, chat, arbitrary file browsing, and Git write operations.

### Worktrees

- Treat Git worktrees as alternate checkouts of one project, not separate project rows.
- Keep one List row per repository. If it has multiple worktrees, show a worktree selector and replace that row's Git and Tatr summary with the chosen checkout.
- Call the repository's main checkout `Primary`; do not assume its branch is named `main` or `master`. Label linked worktrees by branch, or `Detached @ <short commit>` when detached.
- Extend project selections to `{ project_id, project, worktree_id, worktree } | null`. Both IDs are opaque. Never expose checkout paths.
- Keep worktree choices page-local and independent between tabs. Reload resets every row to Primary. Changing the worktree of an actively selected project republishes its selection.
- The singular Project tile and Focus inspect the exact selected worktree.
- Propagate project and worktree identity through Tatr task selections. Tatr loads tasks and Artifact resolves files from the selected checkout, including worktrees outside the configured root when they are reported by a repository inside that root.
- Changing worktrees clears a selected task or artifact that is unavailable in the new checkout.
- Group repositories by canonical Git common directory and deduplicate linked worktrees that also appear beneath configured roots.
- Discover worktrees with bounded `git worktree list --porcelain -z`. Cap each repository at 16 worktrees, exclude missing and prunable entries, retain readable locked worktrees without exposing lock reasons, and preserve all existing fixed-command Git safety controls.

### Refresh

- Discover projects every 60 seconds, refresh List Git summaries every 15 seconds, selected Project tile every 5 seconds, and focused details every 3 seconds.
- Add manual Focus Refresh, suppress unchanged updates, and retain the last valid result after transient Git errors.

## Verification plan

- Cover multiline option packaging and generated editor controls.
- Cover typed cross-widget wiring, generic labels, optional unlinking, late replay, source deletion clearing, page locality, and project-to-Tatr filtering.
- Cover discovery roots, missing roots, hidden and symlink exclusions, deduplication, deterministic limits, opaque identity, fixed Git behavior, output/time bounds, Tatr counts, and payload privacy.
- Cover List and Project 3x3 rendering, selection and clearing, worktree discovery, grouping, selection, replacement summaries, Tatr and Artifact propagation, Focus lifecycle, Overview, Changes, Branches, search/filter controls, reload reset, mobile layout, and cross-tab isolation.
- Review wide and narrow tile and Focus screenshots.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before final commit.

## Implementation notes

- Added generic multiline text options through source manifests, packaged manifests, runtime validation, public descriptors, and generated editor textareas.
- Generalized editor link badges and dialogs to manifest port names. Optional inputs can now be unlinked, and relinking, unlinking, snapshot replacement, or source deletion clears target subscribers with `null` before any replay.
- Added packaged Projects List and Project 3x3 variants. List publishes retained page-local opaque project selections; Project resolves them server-side and is the only Focus-capable variant.
- Added immediate-child discovery across multiline roots with missing-root tolerance, hidden and symlink exclusion, canonical deduplication, deterministic ordering, a 200-project cap, and path-derived opaque IDs.
- Added bounded concurrent list inspection and fixed local Git commands with no shell, prompts, optional locks, fsmonitor, external diffs, text conversion, remote access, or write operations.
- Added branch, ahead/behind, latest commit, staged/unstaged changes, line statistics, local branches, and bounded native Tatr task counts without executing `tatr`.
- Added Project Focus Overview, Changes, and Branches with responsive layouts, search, change filters, and manual refresh. Project selection remains owned by List; Focus does not add a competing selector.
- Added optional Tatr project input, informational project chip, documented filter precedence, selected-task invalidation, and Artifact clearing through nullable task selections.
- Kept absolute roots, Git remote URLs, author identity, credentials, and patch contents out of browser payloads.
- Added bounded Git worktree discovery, repository grouping by common directory, opaque checkout identities, and one-row page-local worktree replacement in Projects List.
- Extended project and task selections with worktree identity. Singular Project, Tatr Full, task details, and Artifact now resolve and read the exact selected checkout without sending its path to the browser.
- Added page-scoped backend views to Projects List and Tatr Full so worktree and project choices remain independent across tabs and reset to Primary on reload. Backend view maps are capped to bound abandoned reload state.

## Bugs and fixes

- List suppressed an unchanged snapshot after browser reload because its backend retained the previous payload. Explicit frontend refresh now clears suppression and forces discovery.
- The old editor used hard-coded `Selected task` and `Linked task list` text. Manifest names now drive source and target labels for all widget types.
- Relinking an input to a source that had not published could retain the old source value. The page bus now clears changed wiring before replaying the new source.
- A source project filter could hide Tatr's selected task while leaving its linked Artifact stale. Tatr now publishes `null` when the selected task leaves the visible project scope, and Artifact returns to `Select a task`.
- The singular Project Focus design initially retained a project sidebar from the earlier combined-widget draft. The accepted two-widget composition keeps all project selection in List and Focus on one linked project.
- Tatr previously filtered the full backend snapshot only in the browser, which could not read tasks changed in an external linked worktree. Page-scoped Full views now resolve opaque selections server-side and load that checkout directly.
- Retained link delivery can occur before a Tatr Full view's open command. Full view creation is now idempotent, so either command order preserves the linked selection.
- Tatr's task cache originally keyed only by artifact path and timestamps, so changing from an unlinked Primary identity to a linked repository identity could replay stale opaque IDs. Cache reuse now also requires matching project and worktree identity.

## Verification results

- Projects backend tests and Clippy with warnings denied pass.
- Production Projects, dashboard, and Tatr builds and widget preparation pass.
- Chromium integration passes multiline creation, required and optional wiring, generic labels, List selection and clearing, worktree discovery and selection, singular tile replacement, worktree-specific Tatr and Artifact reads, cross-tab worktree locality, Primary reload reset, task invalidation, optional unlink/relink, source deletion clearing, Focus lifecycle, Overview, Changes, Branches, search, mobile and desktop rendering, and payload path privacy.
- Wide and narrow List, Project tile, Overview, and Changes screenshots were reviewed.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
