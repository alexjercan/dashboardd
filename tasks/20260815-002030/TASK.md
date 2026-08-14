# Add Projects List navigation controls

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, projects, frontend, search, filters

## Goal

Make Projects List easier to navigate without changing repository state or backend discovery.

## Accepted design

- Add a compact toolbar below the List header with project-name search, a Name or Recent sort selector, and a Filters menu.
- Search only project display names. Matching is case-insensitive fuzzy ordered-character matching, never regular expressions.
- Split search text on whitespace. Every term must fuzzy-match the name. Contiguous and word-boundary matches rank higher.
- While searching, fuzzy relevance is primary and the selected sort breaks equal scores.
- Name sorts ascending and remains the default. Recent sorts the selected worktree's latest local commit first; projects without commits sort last. Ties use project name then opaque project ID.
- Filters are Dirty and Active tasks only. Dirty means the selected worktree has changes. Active tasks means it has at least one OPEN or IN_PROGRESS task. Enabled filters use AND semantics.
- Search, sort, and filters are page-local and reset to empty search, Name, and no filters on reload.
- Filtering never clears project selection. If the selected project is hidden, show `Selected: <project>` with a Clear action that publishes null.
- Worktree choices survive search, sorting, and filtering. Changing a worktree can change Recent ordering or filter inclusion.
- Show `<visible> of <total> projects` while filtered and `No matching projects` for empty results. Preserve `No projects` for an empty backend snapshot.
- Keep Pinned Repos as a separate future widget concept. Do not add pins to Projects List.

## Verification plan

- Cover case-insensitive fuzzy matching, whitespace terms, literal regex punctuation, relevance, Name and Recent sorting, both filters and AND semantics.
- Cover retained hidden selection, Clear propagation, worktree controls, page-local reset, and empty states.
- Review the responsive 3x3 List with controls on narrow and wide dashboards.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before commit.

## Implementation notes

- Added a compact always-visible search, sort, and filter toolbar without reducing the 3x3 List variant or changing backend payloads.
- Added literal case-insensitive fuzzy matching over project display names. Whitespace-separated terms are all required; ordered characters, contiguous runs, and name boundaries determine relevance without compiling user input as a regular expression.
- Added Name and Recent sorting. Fuzzy relevance takes precedence while searching; deterministic selected-sort comparison resolves equal scores.
- Added Dirty and Active tasks filters with AND semantics against the selected worktree summary.
- Retained selected projects when navigation controls hide their rows. A visible `Selected` indicator owns explicit clearing, so search does not unexpectedly clear linked Project, Tatr, or Artifact state.
- Kept all navigation state in the frontend mount. Reload and separate tabs start with Name sorting and no search or filters.
- Kept Pinned Repos outside this scope as a separate future widget concept.

## Bugs and fixes

- The browser Git fixture originally assumed every project directory already existed because all prior fixtures had tasks. The new idle project exposed that assumption; fixture setup now creates each repository directory before `git init` and reports process-spawn errors directly.

## Verification results

- Production Projects build and repository formatting checks pass.
- Chromium integration passes Name and Recent ordering, case-insensitive multi-term fuzzy matching, fuzzy relevance, literal regex punctuation, Dirty and Active tasks filtering, AND semantics, hidden-selection retention and clearing, and reload reset.
- Narrow filtered-selection and wide default List screenshots were reviewed.
- Workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
