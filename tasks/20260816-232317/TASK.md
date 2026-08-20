# Support externally authored widget packages with Today

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, sdk, external, packaging, nix, python, today

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
- `dashboardd-widget check <bundle>` performs static bundle validation. Backend protocol conformance remains a separate test concern.
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

## Contract baseline progress

- Added an mdBook documentation site with Mermaid diagrams, user guides, widget authoring contracts, and a Nix documentation package.
- Added a GitHub Pages workflow that builds documentation on pull requests and deploys `master`.
- Reduced the repository README to project purpose, quick start, documentation, and checks. Moved widget-specific README content into the user guide.
- Added runtime manifest v2 and backend protocol v1 JSON Schemas.
- Added public protocol fixtures and an executable Python backend fixture outside the Cargo and npm widget workspaces.
- Added contract tests for schemas, manifest semantics, and the Python ready, initialize, update, ping, message, and shutdown lifecycle.
- Tightened runtime widget, variant, option, and port ID validation to match the public contract.
- Added mdBook, mdbook-mermaid, Python, documentation build, and documentation checks to the Nix flake.
- Fixed Project document traversal expressions found by the complete Nix Clippy checks without changing behavior.

- Converted `@dashboardd/widget-sdk` into a compiled public package with JavaScript, declarations, CSS exports, package metadata, and a minimal package README.
- Added an external consumer test that packs the SDK, installs only its tarball outside the workspace, compiles TypeScript and CSS imports, checks runtime exports, and enforces exact package contents.
- Added a reproducible `dashboardd#widget-sdk` Nix tarball package and flake check.
- Added focused SDK CI and tag-driven GitHub Release upload workflows. Published the first SDK release.

## Standalone pack/check design

- Add a `dashboardd-widget` binary and shared Rust library.
- `dashboardd-widget pack <widget.toml> --output <bundle>` consumes built artifacts only. It does not invoke a build system.
- Source manifest schema version 2 removes Cargo and npm workspace fields. Backend and frontend fields are explicit artifact paths inside the manifest directory.
- Pack writes the standard runtime names `bin/<widget-id>` and `frontend/<variant-id>.js`, generates runtime manifest v2, and refuses an existing output directory.
- `dashboardd-widget check <bundle>` performs static validation only. It validates the manifest semantics, path containment, bundle directory name, artifact existence and readability, and backend executable permission. It never starts the backend and is not a protocol fuzzer.
- One shared library owns source parsing, runtime parsing, semantic validation, packing, and static checks. dashboardd uses its runtime validator.
- `cargo xtask widget prepare` remains repository convenience tooling. It builds each bundled backend and frontend, stages the backend artifact, and calls the shared packer.
- Export the binary through Nix and document the standalone workflow.

## Standalone pack/check progress

- Added the `dashboardd-widget` Rust package with a standalone binary and shared library.
- Added source manifest schema version 2 with explicit built backend and frontend artifact paths.
- Added strict source and runtime parsing, semantic validation, path containment, readable artifact checks, executable backend checks, stable runtime names, deterministic permissions, and atomic installation into a new output directory.
- Added external temporary-project CLI tests and invalid traversal, missing artifact, permission, output collision, directory identity, unknown field, and deterministic output cases.
- Migrated dashboardd runtime discovery to the shared validator.
- Migrated every bundled `widget.toml` and changed `xtask` into repository build orchestration followed by the shared packer.
- Exported `dashboardd#dashboardd-widget` through Nix and added a native pack/check fixture check.
- Documented source manifests, pack/check commands, Nix installation layout, and the static-only check boundary.
- Passed workspace Clippy, Rust tests, contract and SDK tests, all bundled widget preparation, Chromium integration, documentation builds, and all Nix flake checks.

## Multi-root and Nix composition design

- Replace `DASHBOARDD_WIDGETS_DIR` with `DASHBOARDD_WIDGET_PATH` without compatibility handling.
- Parse the search path with platform path-list semantics. Unset uses `.build/widgets` for source development. An explicitly empty value discovers no widgets. Empty entries in a non-empty value are invalid.
- Preserve configured root order, sort bundles inside each root, sort the final catalog by widget ID, and reject duplicate IDs with both bundle paths. Missing, unreadable, or invalid roots stop startup.
- Add `DASHBOARDD_WEB_DIR`, defaulting to `web/dist`, so packaged dashboardd does not change process working directory.
- Export `dashboardd-unwrapped`, `bundled-widgets`, and a complete `dashboardd` package alongside `dashboardd-widget`, `widget-sdk`, and `docs`.
- Install built-in bundles under `$out/share/dashboardd/widgets/<widget-id>/` and web files under `$out/share/dashboardd/web/`.
- The complete dashboardd wrapper supplies packaged web and built-in widget paths only when their environment variables are unset. Explicit widget composition replaces the built-in default.
- Compose external packages with `lib.makeSearchPath "share/dashboardd/widgets"` rather than merging widget trees.
- Build frontend assets reproducibly from the npm lock, use Nix-built backend packages, and pack every built-in widget with `dashboardd-widget`.
- Add Rust discovery tests, browser coverage with a second external root, Nix layout and startup checks, and user and author documentation.

## Multi-root and Nix composition progress

- Replaced the single-root variable with platform-aware `DASHBOARDD_WIDGET_PATH` parsing and added the packaged `DASHBOARDD_WEB_DIR` boundary.
- Added deterministic multi-root discovery, explicit empty-root behavior, missing-root errors, final ID sorting, and duplicate rejection with both bundle paths.
- Added Rust tests for path parsing, empty entries, no roots, missing roots, multiple roots, sorting, and duplicate IDs.
- Added an external Python bundle root to the complete Chromium integration scenario.
- Added reproducible npm frontend builds and Nix packing for every built-in widget with Nix-built Rust backends.
- Exported complete `dashboardd`, raw `dashboardd-unwrapped`, and composable `bundled-widgets` packages under the standard installed layout.
- Added a Nix package check that statically checks every built-in bundle, composes a second external root, starts packaged dashboardd, and verifies the complete widget catalog.
- Added Git to the Projects and Tatr Tasks Nix build environments because their existing package tests create Git fixtures.
- Documented packaged startup, package outputs, search-path semantics, and external Nix composition.
- Passed Rust tests and Clippy, complete contract, SDK, and Chromium integration with two roots, documentation builds, packaged startup, and all Nix flake checks.

Remaining work starts with the external Today repository implementation and its out-of-workspace end-to-end fixture.

## Out of scope

- Rewriting Today in Rust.
- A second Rust parser or writer for the-den.
- Google Calendar or multi-day agenda behavior.
- The proposed Agent Activity widget.
- A general untrusted-widget sandbox or remote widget marketplace.
