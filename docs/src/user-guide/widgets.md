# Bundled widgets

## Projects

Project Pulse is an attention-ranked 3x2 project list. It scans immediate children of configured roots, retains up to three durable pins, selects Git worktrees, and publishes page-local project selection.

Project Brief is a linked 3x2 summary of branch state, working-tree changes, task activity, and a safe document excerpt. Focus provides bounded project documents, changed files, and local branches.

Project documents reject symlinks, hidden paths, traversal, oversized files, active HTML, and embedded images. Browser payloads contain opaque project identities and relative display paths, not configured roots.

## Tatr Tasks

Tasks is a 3x3 list that reads `TASK.md` records directly. It loads every status, hides closed tasks by default, and sorts by priority. Focus adds the closed-task control, search, sort, IDs, tags, and metadata.

Task Artifact is a linked 3x3 viewer for task-local Markdown, sanitized HTML, UTF-8 text, and raster images. It rejects absolute paths, symlinks, active HTML, embedded local assets, and unsupported binaries.

## Machine telemetry

- CPU reports aggregate and per-core load with temperature data when available.
- RAM reports memory and optional swap pressure.
- Disk reports root-filesystem capacity and I/O without exposing mount or device names.
- Network aggregates active non-loopback traffic without exposing interface names or addresses.

## AI usage

Claude Usage reads Claude Code OAuth credentials from `$CLAUDE_CONFIG_DIR/.credentials.json` or `$HOME/.claude/.credentials.json`. It requests the provider usage resource and shares a five-minute cache through `$XDG_CACHE_HOME/dashboardd`. Credentials and raw responses never reach the frontend or logs. Temporary errors retain the last value and mark data stale after 15 minutes.

Codex Usage starts the official Codex app server, refreshes authentication, and reads `account/rateLimits/read`. It reports the primary weekly limit and ignores model-specific limits. Tokens, account identifiers, and raw responses never reach the frontend or logs. It polls every five minutes and marks data stale after 15 minutes.

Detailed variants provide manual refresh. Minimal variants show the provider and important remaining percentage without controls.

## Links and shared state

Typed links connect compatible widget placements in a browser-local Dashboard. Link payloads are page-local and reset on reload.

Package-wide shared state is bounded JSON persisted in `runtime.json`. It is public widget data and must not contain credentials or filesystem paths.
