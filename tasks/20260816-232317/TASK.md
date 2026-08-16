# Support externally authored widget packages with Today

- STATUS: OPEN
- PRIORITY: 100
- TAGS: widget,sdk,external,packaging,nix,python,today

## Goal

Prove that dashboardd is an external widget platform by building and installing a real Today widget from `/home/alex/personal/today`. The widget must not live in the dashboardd workspace. It must use public, versioned authoring contracts and install through Nix without copying source into dashboardd.

## Product shape

- `today` owns the widget because it owns the domain and is the only reader and writer for the-den Markdown.
- The backend can be Python. Widget backends are executable processes that use the language-neutral JSON Lines protocol over stdin/stdout.
- The Today CLI and widget backend share one Python application API. Do not duplicate Markdown parsing or mutation logic.
- Start with a read-only 3x2 Summary variant. It shows tasks remaining, habit completion, macros, and whether weight was logged.
- Add a larger Daily variant with Focus after the external path works. Explicit task, habit, weight, macros, and note writes occur only in Focus.
- Keep the-den as data only.

## Dashboardd platform work

### Stable public contracts

- Document the runtime widget directory layout and runtime manifest schema.
- Document the backend process lifecycle, JSON Lines envelopes, stdout/stderr rules, protocol versions, and error behavior.
- Publish machine-readable protocol schemas or conformance fixtures that non-Rust backends can test without depending on `dashboard-protocol`.
- Define compatibility and versioning rules for runtime manifests, backend protocol, and frontend SDK releases.

### Frontend SDK

- Turn `@dashboardd/widget-sdk` into a built consumable package instead of a private workspace source package.
- Emit JavaScript, TypeScript declarations, and the widget/theme CSS assets under `dist/`.
- Restrict package exports to supported public files and verify the packed contents.
- Produce a versioned npm tarball as a release artifact and a dashboardd flake package. A release URL can be used before registry publication.
- Document external frontend setup, bundling requirements, lifecycle methods, options, links, shared state, Focus, and cleanup.

### Standalone packaging and conformance tool

- Replace public dependence on the monorepo-specific `cargo xtask widget prepare` flow with a standalone `dashboardd-widget` command.
- `dashboardd-widget pack <manifest> --output <directory>` consumes already-built artifacts, validates them, generates `widget.json`, and creates a standalone runtime bundle.
- `dashboardd-widget check <bundle>` validates paths and metadata, starts the backend, verifies `ready`, `initialize`, `ping`/`pong`, error handling, and clean shutdown.
- Keep project build orchestration outside the public packer. Each widget repository chooses Python, Rust, npm, or another build system.
- Replace build-system fields in the source manifest with explicit backend and frontend artifact paths. Use a breaking source-manifest revision rather than compatibility machinery.
- Retain a thin dashboardd repository convenience command for building all bundled widgets if useful.

### External widget discovery

- Support multiple widget roots through a platform-aware search path such as `DASHBOARDD_WIDGET_PATH`.
- Discover roots deterministically and reject duplicate widget IDs instead of choosing one silently.
- Preserve path containment and installed-artifact validation for every root.
- Keep the current local `.build/widgets` default for dashboardd development only if it does not complicate the public contract.

### Nix packaging

- Export dashboardd, `dashboardd-widget`, the frontend SDK tarball, and bundled widgets as useful flake packages.
- Standardize installed widgets at `$out/share/dashboardd/widgets/<widget-id>/`.
- Ensure packaged backends are executable and retain their runtime closure. Python wrappers or symlinks are valid.
- Make external widget packages composable through the widget search path. Do not require source-tree copying or one large mutable widget directory.
- Add native Nix checks for bundle validation and backend handshake behavior.

## Today repository work

- Add a small public Python application/service layer reused by the existing CLI and widget backend.
- Preserve `today` as the only parser and writer for the-den Markdown and preserve atomic writes.
- Add a `today-dashboardd-widget` executable that implements backend protocol v1 with Python standard-library code.
- Keep protocol output on stdout and diagnostics on stderr. Flush every protocol message.
- Validate all frontend commands and values. Use explicit command IDs so the UI can show pending, success, and failure state.
- Refresh after successful writes and handle external file changes or day rollover with bounded polling.
- Build the frontend against the released `@dashboardd/widget-sdk` artifact, not a dashboardd repository path.
- Package the runtime bundle as `packages.<system>.dashboardd-widget` under the standard installed layout.
- Add backend protocol, domain mutation, frontend, bundle, and Nix checks.
- Record user-visible behavior in the Today README and changelog.

## nix.dotfiles integration

- Consume the Today flake's `dashboardd-widget` package.
- Compose dashboardd's built-in widget root and Today's external widget root through `DASHBOARDD_WIDGET_PATH`.
- Do not duplicate Today parsing, wrappers, or widget artifacts in nix.dotfiles.
- Add the Summary variant to a dashboard only after the packaged external flow passes end to end.

## Security and reliability

- Treat installed widget backends as trusted local executables and document that trust boundary.
- Never run widget build commands from runtime manifests.
- Reject traversal, missing artifacts, invalid manifests, duplicate IDs, malformed protocol messages, and incompatible protocol versions.
- Bound backend startup, handshake, command, and shutdown waits.
- Prevent stdout logging from corrupting protocol framing.
- Keep Today write actions explicit and scoped. Normal dashboard presentation remains read-only.

## End-to-end proof

The proof must start from clean checkouts and demonstrate:

1. Build and pack dashboardd's public SDK/tooling.
2. Build the Today Python backend and external frontend in the Today repository.
3. Produce the Today Nix widget package without dashboardd workspace membership.
4. Start dashboardd with built-in and Today widget roots.
5. Discover and place the 3x2 Summary variant.
6. Read real fixture data through the Python backend.
7. Exercise at least one Focus write through the larger variant after it exists and verify the-den changes atomically.
8. Pass browser integration, protocol conformance, bundle validation, and Nix checks.

## Delivery order

1. Freeze and document the runtime, backend, and frontend contracts.
2. Build the external SDK artifact and standalone pack/check command.
3. Add multi-root discovery and Nix package outputs.
4. Add an out-of-workspace Python fixture to dashboardd integration tests.
5. Implement and package the Today Summary widget in the Today repository.
6. Integrate it through nix.dotfiles and dogfood it.
7. Add the larger writable Daily variant and its Focus workflows.
8. Release compatible dashboardd and Today versions and record installation instructions.

## Definition of done

- No Today widget source or generated artifact is committed under dashboardd `widgets/`.
- A Python backend passes the same protocol conformance checks as bundled Rust backends.
- An external frontend installs only from the released SDK artifact.
- `dashboardd-widget pack` and `check` work outside the dashboardd repository.
- dashboardd loads built-in and external Nix widget roots together and rejects collisions.
- `inputs.today.packages.${system}.dashboardd-widget` produces the standard runtime bundle.
- nix.dotfiles installs the external package without copying its contents.
- The Today Summary variant works in a real dashboard from a clean installation.
- The documented release and local-development paths are reproducible.
- All dashboardd, Today, and relevant nix.dotfiles checks pass.

## Out of scope

- Rewriting Today in Rust.
- A second Rust parser or writer for the-den.
- Google Calendar or multi-day agenda behavior.
- The proposed Agent Activity widget.
- A general untrusted-widget sandbox or remote widget marketplace.
