# Research a local personal assistant with agent-driven widgets

- STATUS: OPEN
- PRIORITY: 100
- TAGS: assistant,agents,orchestration,tauri,widgets,research

## Goal

Research and design a local, low-latency personal assistant that delegates project work to specialized coding agents and opens dashboardd widget surfaces on demand.

This task belongs in dashboardd because dashboardd is the current widget runtime and the likely presentation foundation. The assistant itself should remain a separate project unless research shows a strong reason otherwise.

## User outcomes

- User can hold a fast, non-blocking conversation with one primary assistant.
- User can delegate long-running work without blocking the primary conversation.
- User can inspect, steer, stop, and collect results from delegated agents.
- User can select Pi or Claude Code for each delegated task. The design can add other harnesses later without changing its core contracts.
- User can ask for projects, tasks, machine telemetry, LLM usage, or similar information and receive a focused widget window instead of opening a full dashboard.
- User can open a specific task artifact from a project and task ID.
- Spawned widgets can refresh and run independently until the user or assistant closes them.

## Constraints

- Local-first. Keep project data, credentials, agent transcripts, and widget state local unless an explicitly selected model or tool requires network access.
- Keep the foreground path small and responsive. Long reasoning, tool work, and coding run in delegated sessions.
- Keep model selection configurable. Initial candidates include `gpt-5.6-sol` with medium thinking and `gpt-5.6-luna` with xhigh thinking.
- Do not make the primary assistant wait for delegated work. Deliver progress and completion as events.
- Do not couple orchestration semantics to one coding harness.
- Reuse dashboardd widget packages and protocols where practical. Do not require a permanent dashboard composition to show an ad hoc widget.
- Treat agent execution and widget spawning as privileged local operations with explicit policy, path boundaries, audit records, and cancellation.
- Prefer clean contracts over compatibility with the current prototype.

## Accepted design

### Assistant and agent mediation

- Build the assistant outside this repository. Use Pi as the fast foreground conversation harness.
- Implement orchestration as one small TypeScript Pi extension. Do not add MCP, a supervisor daemon, an agent runner, or an RPC bridge.
- Run the actual delegated Pi, Claude Code, or future harness process in a tmux window. Keep harness differences behind small launch, send, inspect, and stop adapters.
- Give every delegated coding job its own Git worktree. Never let concurrent coding agents share a checkout.
- Place worktrees under `${XDG_CACHE_HOME:-$HOME/.cache}/sprouts/<project>/<branch>`. Interoperate with `sprout` when useful, but do not require it; an internal implementation must preserve the same path convention.
- Use Plannotator as the local pull-request surface for coding jobs. Run `plannotator review --git` in the isolated worktree and return requested changes to the same worker for another committed revision.
- Require `sprout sync <feature>` before every review. The worker reruns applicable checks after synchronization, records the evidence in `report.md`, and only then reports `review-ready:`. The extension verifies that the current landing-target commit is an ancestor of the clean feature worktree before opening Plannotator.
- Bind approval to the exact feature and landing-target commits shown during review. If either commit or the worktree changes before landing, invalidate approval and repeat synchronization, checks, and review.
- Treat explicit Plannotator approval as authorization to land without another confirmation. Until review exposes structured approval output, require an exact full-output match for the configured approval response. Fail closed on feedback, closure without feedback, unknown output, or process failure.
- Run `sprout land --dry-run` after approval, then land with `sprout land` or an equivalent guarded local operation. Never push to a forge merely to obtain pull-request workflow semantics.
- Let the extension own one fixed one-second polling loop for all jobs. Start it with the Pi session and stop it during Pi shutdown. Coalesce changes found in one cycle and never emit an event for unchanged status content.
- Give every job a directory containing immutable `prompt.md`, append-only `status`, and worker-written `report.md`. Require UTF-8 with LF line endings. A tmux window is eligible for orphan discovery only when its matching job directory exists.
- Limit `prompt.md` and `report.md` to 1 MiB each, `status` to 256 KiB, and each status line to 2 KiB. Parse only complete newline-terminated `<state>: <summary>` lines. The worker writes `report.md` before publishing its related status line. Surface malformed, unknown, or oversized input as a protocol-error follow-up without interpreting it or automatically stopping the worker.
- Put complete initial and long follow-up instructions in files. Use short tmux submissions for ordinary steering.
- Submit steering literally through a tmux buffer: load and paste the text once, wait a short fixed delay, then send Enter once. Never automatically retype the text or retry Enter. A tmux failure fails the send; an uncertain harness result remains uncertain and requires explicit inspection or intervention.
- Require delegated agents to append sparse `working:`, `needs-decision:`, `blocked:`, `review-ready:`, `done:`, or `failed:` lines to their status file. Coding agents use `review-ready:` only after committing the proposed revision and recording its checks in `report.md`; this starts or restarts the Plannotator review loop. Reserve `done:` for terminal work that requires no review or landing.
- Show `working:` as a non-blocking Pi notification or compact status update. Let `review-ready:` start review and show a compact notification. Deliver `needs-decision:`, `blocked:`, `done:`, and `failed:` as Pi follow-up messages so the foreground assistant mediates between the user and worker.
- Expose native Pi operations for spawn, list, inspect, send, and stop. Keep the exact schemas narrow and harness-neutral.
- On normal Pi shutdown, stop extension-owned agent windows. After an unexpected exit, scan matching job directories and tmux windows once at startup, report possible orphans, and ask whether to retain or close them. Do not auto-adopt, restart, or reconstruct work.
- Use FirstMate only as design evidence. Its raw harness windows, prompt/status/report files, polling, and Pi wake injection validate this shape, but its agent distribution and recovery machinery are out of scope. Evidence inspected at `kunchenguid/firstmate` commit `03bb1d8b78a8632ae2d9cea4c10868eb100e885e`.

### Widget runtime and presentations

- Extract a reusable Rust `dashboardd-runtime` library for widget discovery, instance lifecycle, backend supervision, events, health, shared state, and the runtime HTTP API.
- Keep `dashboardd` as the current browser-oriented service binary. It starts the runtime, serves the Dashboard frontend, and handles configuration and shutdown.
- Add `dashboardd-desktop` as a thin Tauri application and resident local desktop service. Embed `dashboardd-runtime` by default; allow an explicit external-runtime endpoint when shared runtime state is required, but do not auto-detect one. The desktop process owns native widget windows while the embedded runtime owns widget execution and data.
- Start the desktop service explicitly, such as from rofi, and keep it resident after the last widget window closes. Treat it as a graphical-session daemon, not a detached system daemon: it owns the Tauri event loop, tray, webviews, and embedded runtime. Provide a system tray item for status and explicit Quit. Quit closes all surfaces, deletes their instances, stops widget backends and the embedded runtime, and exits completely. Keep login startup optional and disabled by default. Add `systemd --user` deployment through Nix only when the service is ready for actual use.
- Expose a narrow same-user control API on `$XDG_RUNTIME_DIR/dashboardd-desktop.sock`. Linux-only support is sufficient. Restrict the socket to the current user and expose typed discover, open, update, focus, list, close, and quit operations; never accept arbitrary URLs, filesystem paths, or Tauri commands. Use one bounded newline-terminated JSON request and response per connection, with a protocol version and named response status rather than a boolean. Provide a small `dashboardctl` client for scripts, rofi, and diagnostics.
- In protocol version 1, return only `{ "version": 1, "status": "ok", "result": ... }` or `{ "version": 1, "status": "failed", "error": { "code": "...", "message": "..." } }`. Return `ok` only after the requested window operation completes; do not add an asynchronous status until a command requires one.
- Write metadata-only control records to `$XDG_STATE_HOME/dashboardd-desktop/control.jsonl`. Include timestamp, server-generated request ID, command, status, duration, applicable surface ID, and error code. Never log complete requests, typed input values, widget payloads, or results. Rotate at 10 MiB and retain three files.
- Split frontend hosts into `web/dashboard` for the current multi-widget dashboard experience and `web/surface` for exactly one widget instance.
- Make a runtime instance independent from dashboard placement, frontend mount, standalone surface, and Tauri window. Remove dashboard ID, grid position, collision rules, and dashboard link definitions from runtime instance creation and events.
- Provide global instance CRUD. Instances are memory-only running resources and do not record who created them or why they exist.
- Let consumers own lifecycle. Removing a Dashboard placement or closing a Tauri widget window deletes its instance.
- Let the Dashboard frontend own dashboard documents, layout, navigation, and link graphs. Store each device's dashboard specifications in browser-local storage and recreate runtime instances after a runtime restart.
- Let a standalone surface provide declared typed inputs directly, without hidden source widgets or browser-owned Dashboard links. Create and update inputs as `{ "type": "<versioned-manifest-type>", "value": <opaque-json> }` envelopes keyed by input port. The runtime verifies that each port applies to the selected variant and that its envelope type exactly matches the manifest, but leaves value validation to the widget.
- Store direct inputs only for the in-memory instance lifetime and publish their updates through instance events. Before mounting, a presentation host verifies that every required port has exactly one binding: either a direct value or a Dashboard-local dynamic link, never both.
- Split the frontend SDK's current link capability into `inputs.get`, `inputs.subscribe`, and `outputs.publish` capabilities shared by Dashboard and standalone hosts.
- A Task Artifact surface can receive project, worktree, task, and artifact identity directly.
- Keep durable project and task data in its source. Runtime instances receive typed opaque references, not ownership of project data.
- Use HTML and JavaScript widget frontends in Tauri webviews. Keep Tauri capability-scoped and prevent arbitrary URL loading or unrestricted native commands.

### Assistant widget tools

- Use native Pi extension tools for widget discovery, query, open, update, focus, list, and close operations.
- Keep data queries separate from visual window operations so simple questions do not need to open a widget.
- Make every `open` operation create a new surface, runtime instance, and native window with a generated `surface_id`. Closing the window deletes that surface and instance; opening the same widget and inputs afterward creates a new surface normally. Omit implicit reuse, semantic deduplication, and a `show` operation from version 1. Require explicit surface IDs for later update, focus, and close operations.

### Desktop lifecycle spike

- Build the first retained `dashboardd-desktop` foundation as a narrow lifecycle spike before runtime extraction.
- Start hidden with a system tray item, publish Unix-socket readiness, and remain resident with no windows.
- Add a minimal `dashboardctl` with `open-demo`, `list`, `focus`, and `close`; load only static local HTML in demo windows. Limit each socket request and response to 64 KiB and reject unknown protocol versions or commands explicitly.
- Verify external socket requests can schedule Tauri UI-thread window operations under X11 and i3, and that tray Quit closes windows, stops the socket server, removes the socket, and exits.
- Exclude real widget packages, widget backends, typed inputs, runtime extraction, Pi integration, systemd units, and Nix deployment from this spike. Launch the binary directly and evolve the retained foundation in later vertical slices instead of making disposable demo machinery.

## Dashboardd implementation task

- `20260820-094041` - Build desktop-hosted standalone widget surfaces. Its ordered steps cover the retained lifecycle slice, runtime extraction, composition decoupling, typed direct inputs, standalone surface host, real desktop widgets, direct Tatr Artifact surfaces, and Nix packaging.

## Research questions

### Foreground assistant

- Which Pi extension structure and model configuration provide the lowest practical input-to-response latency?
- How should the foreground model decide between answering, querying local data, opening a widget, and delegating work?
- Which progress events belong in compact UI, and which should trigger a mediated model follow-up?

### Agent mediation

- What exact allowlisted launch commands and permission modes should the Pi and Claude Code tmux adapters use?
- Which repository checks are applicable to each coding job, and how does the extension verify the worker recorded post-sync evidence before opening Plannotator?
- Which permissions, credentials, prompts, and approval requests can delegated harnesses expose safely?
- How should a worker process exit that has no matching terminal status be reported?

### Widget service and desktop shell

- Which current dashboardd backend-process, event, health, shared-state, and frontend SDK contracts move into `dashboardd-runtime` unchanged?
- Which contracts must change when instances no longer belong to Dashboard composition?
- Which Tauri APIs and Linux native dependencies are required for a hidden resident tray process, UI-thread window creation, X11 focus, and clean shutdown?
- How should startup validate and safely replace a stale same-user socket without following a malicious path?
- How do window placement, sizing, focus, refresh, multi-monitor behavior, and cleanup work?
- How does an agent retain and use a returned surface ID for explicit update, focus, and close operations?
- How does a Task Artifact surface validate and resolve a direct project/worktree/task reference?

### Tool boundary

- Define narrow native Pi tool schemas. Avoid exposing generic shell, arbitrary URLs, raw filesystem paths, or unrestricted window creation.
- Define separate read/query and visual surface operations.
- Measure native tool and standalone-window latency on the foreground path.

### Safety and operations

- Define capability grants for repositories, commands, network use, credentials, harnesses, and widget types.
- Define minimal audit events, resource limits, timeouts, cancellation, unexpected-exit reporting, and orphan cleanup without adding recovery machinery.
- Identify sensitive values that must never enter widget payloads, logs, model context, or browser storage.

## Required artifacts

- `SPIKE.md`: findings with links to Pi documentation, Pi examples, FirstMate evidence, Claude Code interfaces, Tauri window APIs, and applicable dashboardd code.
- `ARCHITECTURE.md`: recommended process boundaries, ownership, data flow, trust boundaries, and lifecycle diagrams.
- `PROTOCOL.md`: draft native Pi orchestration tools, job-file/status grammar, and dashboard widget control API with example messages.
- `PLAN.md`: phased implementation plan split between dashboardd changes and a new assistant repository. Include dependencies, risks, and small end-to-end milestones.
- The retained `dashboardd-desktop` tray, Unix-socket, and static-window lifecycle spike.

## Acceptance criteria

- Records measured or directly observed evidence for the important latency and lifecycle claims.
- Compares at least Pi and Claude Code as delegated harnesses.
- Identifies existing subagent solutions but does not adopt one only because it exists.
- Separates the assistant extension, delegated harness processes, widget runtime, and desktop presentation responsibilities.
- Defines how a request such as `show CPU usage` opens a standalone live widget.
- Defines how a request such as `show the artifact for my current task` resolves context and opens or updates one Task Artifact window.
- Defines non-blocking job progress, steering, cancellation, completion, shutdown, and orphan discovery behavior.
- Defines explicit security and permission boundaries.
- Ends with one recommended architecture and a sequence of independently testable implementation tasks.

## Non-goals

- Implement the full personal assistant in this task.
- Add all missing widgets.
- Build voice input, wake-word detection, home automation, or cloud synchronization.
- Make dashboardd the source of truth for projects or tasks.
- Let an LLM issue unrestricted shell or desktop commands through the widget API.
