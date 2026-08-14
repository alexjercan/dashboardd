# Add theme font configuration

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: configuration, theme, fonts, frontend

## Goal

Use the same regular Iosevka family as the user's Kitty configuration by default and allow theme font families to reload live.

## Accepted design

- Add `[theme.fonts]` with `sans` and `mono` family names.
- Default both families to `Iosevka`, matching the Kitty Home Manager configuration.
- Normal text keeps CSS weight 400. Existing deliberate component emphasis remains unchanged.
- `sans` controls headings, buttons, and primary UI text.
- `mono` controls telemetry, positions, dimensions, and metadata.
- Append existing system sans-serif and monospace fallback stacks.
- Use system-installed fonts. Do not bundle font assets.
- Validate family names as non-empty ASCII letters, digits, spaces, underscores, or hyphens.
- Invalid startup values stop dashboardd.
- Invalid live values preserve the last valid theme and show the configuration error.
- Valid font changes use the existing theme hot-reload path and update open widgets without remounting.

## Verification

- Unit tests cover defaults, valid families, and invalid family syntax.
- Browser integration covers initial Iosevka stacks, live font changes, invalid reload retention and errors, recovery, and widget inheritance.

## Implementation notes

- Added strict nested `theme.fonts.sans` and `theme.fonts.mono` configuration.
- Changed built-in SDK font stacks and the tracked default config to use Iosevka first.
- Effective theme resources and SSE updates now include both family names.
- Dashboard CSS variables append the existing system sans and mono fallback stacks.
- Font family validation prevents arbitrary CSS values while allowing common family names.
- Theme events box the larger effective theme payload to keep the event enum compact.

## Verification results

- Dashboardd unit tests pass for defaults, valid font families, and invalid syntax.
- Dashboardd Clippy passes with warnings denied.
- Prettier checks and all production frontend builds pass.
- Real Chromium integration passes initial stacks, live font changes, invalid retention and errors, recovery, deletion fallback, and widget inheritance.
- Workspace Rust tests and Nix flake checks pass.
