# Isolate browser test fixture projects

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: testing, browser, tatr

## Goal

Keep generated Tatr repositories and external widget fixture trees outside the repository and other normal recursive project discovery roots. Retain browser failure logs and screenshots under `tests/artifacts`.

## Implementation

- Create one unique browser runtime root with `mkdtempSync` under the OS temporary directory.
- Store Tatr projects, external widget links, runtime state, and runtime configuration below that root.
- Assert that the runtime root is outside the repository.
- Enclose fixture setup and all browser scenarios in cleanup handling.
- Stop owned resources, close the log descriptor, and recursively remove the complete runtime root with force semantics.
- Keep durable logs and screenshots in `tests/artifacts`.

## Tradeoffs

- A unique temporary root supports concurrent browser runs. Cleanup removes the root by recorded path instead of broad process or path matching.
- Failure diagnostics do not retain generated repositories. Existing durable logs and screenshots provide the intended diagnostics.

## Review follow-up

- Canonicalize the repository and temporary runtime root with `realpathSync` before the containment assertion. This catches a temporary-directory symlink that resolves inside the repository.
- The containment predicate rejects equal and descendant paths. An absolute `path.relative` result denotes a cross-volume path and remains outside.
- A synthetic symlink scenario confirmed that canonical containment detects an OS temporary path resolving into `tests/artifacts`.
- The complete browser suite and temporary-root residue comparison passed after this correction. The first run reached an unrelated timing-sensitive task-row count with zero rows; an immediate unchanged rerun passed.

## Verification

- `sprout sync isolate-tatr-fixtures` reported `Already up to date` at implementation revision `b9cd535592cf2fccce8e7ef260b3ab9a508eea44` against master revision `e6df026751f02e2ddcde9e04a8704a073409af64`.
- `nix develop -c bash -lc '<temporary-root snapshot>; node tests/browser.mjs; <temporary-root comparison>'` passed all browser scenarios before and after synchronization. The comparison found no added `dashboardd-browser-*` directory after either run.
- `npm run format:check` passed before and after synchronization.
- `npm run test:contracts` passed before and after synchronization.
- `npm run test:sdk` passed before and after synchronization.

## Check setup

- Initial direct browser execution could not find workspace dependencies. `npm ci` restored them.
- The first Nix browser attempt found the clean worktree's desktop frontend output absent before the harness's Cargo build. `nix develop -c npm run build` generated the expected ignored output; the complete browser rerun passed.
- No verification limitation remains.
