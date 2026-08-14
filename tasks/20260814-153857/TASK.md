# Add widget health and diagnostics

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, health, diagnostics

## Goal

Make each widget backend's runtime health visible and recoverable without adding noise to Zen mode.

## Accepted design

- Dashboardd owns runtime health, liveness probes, diagnostics, and restart behavior.
- Public states are `starting`, `healthy`, `stale`, `degraded`, and `failed`.
- Dashboardd sends protocol `Ping` messages every 10 seconds. Backends answer with matching `Pong` messages.
- A backend becomes stale after 30 seconds without valid protocol activity. A backend that has not sent `Ready` also becomes stale after 30 seconds, even if it answers probes.
- Widget telemetry schedules remain backend implementation details. Health probes do not change CPU, RAM, Tatr, Claude, or Codex update intervals.
- A valid widget update recovers stale or degraded health to healthy. A matching Pong recovers stale health only after the backend has sent Ready and does not clear a reported degradation.
- Widget-reported errors mark the matching instance degraded. Fatal spawn, protocol, or unexpected-exit failures mark it failed with a generic public message; detailed process errors remain server logs only.
- Keep only the latest public error. Cap its code and message and never expose stderr, payloads, raw provider responses, credentials, or filesystem paths.
- Health is runtime-only and resets when dashboardd restarts.
- Public timestamps use RFC 3339 UTC.
- `restart_count` counts manual restarts and resets when dashboardd restarts.
- `GET /api/v1/instance-health` returns the complete health snapshot for initial loads and SSE reconciliation.
- `GET /api/v1/instances/{instance_id}/health` returns one health record.
- `POST /api/v1/instances/{instance_id}/restart` gracefully stops the backend with the existing 3-second limit, force-terminates after timeout, and starts it with the same instance ID, variant, options, composition, and links.
- Manual restart resets start and update times, retains the previous error for diagnosis, and does not add automatic restart policy.
- SSE `instance_health_updated` events carry authoritative runtime state.
- Instance-specific backend errors update health instead of opening the global dashboard error banner. Connection, configuration, and unscoped errors remain global.
- Health controls exist only in editor mode. Each widget gets a top-left status button, with a compact dot-only treatment for 1x1 widgets.
- The `Widget health` dialog shows status, start time, last update, last error, and restart count.
- Restart requires an explicit second confirmation action in the dialog.
- Zen mode has no health overlay.

## Verification plan

- Protocol tests cover Ping and Pong serialization and matching.
- Dashboard tests cover health transitions, stale timing, error retention and truncation, restart counters, and health API resources.
- Packaged backend coverage proves all widgets answer probes.
- Browser integration covers initial health reconciliation, editor-only controls, diagnostics, manual restart, stable composition and instance IDs, update recovery, and Zen-mode absence.
- Review editor screenshots at wide and narrow widths.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, Chromium integration, and Nix flake checks before commit.

## Implementation notes

- Added versioned Ping and Pong protocol messages and matching responses in every packaged backend.
- Added runtime-only health trackers with RFC 3339 timestamps, bounded public errors, manual restart counters, readiness and activity tracking, and server-owned stale transitions.
- Fatal process and protocol details stay in server logs. Public failed health uses a generic message.
- Added bulk and per-instance health resources, confirmed restart, OpenAPI schemas, and health SSE events.
- Manual restart reuses the instance ID, variant, options, composition, and links while retaining the latest diagnostic error.
- Added editor-only responsive health controls and a diagnostics dialog. The 1x1 treatment uses a status dot to fit beside move and remove controls.
- Instance-scoped backend errors no longer open the global dashboard banner. Unscoped, connection, and configuration errors remain global.
- Added direct process coverage that proves all packaged backends answer Ping and exit after Shutdown without triggering provider work.
- Closed `tasks/20260814-153000/TASK.md`, which was complete but still marked in progress.

## Bugs and fixes

- Update-based stale detection would have marked unchanged Tatr data and idle Details instances stale. Replaced it with protocol liveness probes and kept data update age separate.
- Restart HTTP responses can race newer SSE health events. The browser relies on authoritative SSE after restart instead of applying the response snapshot over a newer event.
- The first task note draft omitted required Tatr metadata. Added STATUS, PRIORITY, and TAGS directly below the title and retained this format for task records.
- Tatr Details used `crypto.randomUUID()`, which is unavailable in some mobile browsers and non-secure contexts. Replaced it with `getRandomValues()` plus a non-security fallback and covered the compatibility path in Chromium.
- The first Nix check could not see the new untracked Rust module because flake source snapshots omit untracked files. Staged the reviewed tree and reran the same check successfully.

## Verification results

- Workspace tests and Clippy with warnings denied pass.
- Dashboard production build and formatting pass.
- Chromium integration passes health reconciliation, packaged backend probes, diagnostics, two-step restart confirmation, stable instance identity, telemetry recovery, and Zen-mode control hiding.
- Wide and narrow editor screenshots plus the health dialog screenshot were reviewed.
- Nix flake checks pass after staging the new module for flake source discovery.
