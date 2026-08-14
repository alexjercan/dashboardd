# Add Disk and Network widgets

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: widget, disk, network, telemetry

## Goal

Complete the core host-monitoring set with portable local Disk and Network telemetry.

## Accepted design

### Disk

- Widget ID `disk`; display name `Disk`.
- Full is 3x2 and Compact is 1x1.
- Refresh every second with no user options in the first slice.
- Monitor only the system root filesystem.
- Send used, available, and total bytes; usage percentage; read and write bytes per second; sanitized filesystem type; and read-only state.
- Never send mount paths or device names to the browser.
- Report `disk_unavailable` when the root filesystem cannot be identified and preserve the last valid frontend snapshot.
- Compact shows usage, a capacity bar, and free space.
- Full shows capacity, filesystem state, current I/O, and 60 seconds of read/write history.
- Capacity is warning at 70% and danger at 90%.

### Network

- Widget ID `network`; display name `Network`.
- Full is 3x2 and Compact is 1x1.
- Refresh every second with no user options in the first slice.
- Aggregate active non-loopback interfaces.
- Send receive and transmit bytes per second, session totals, receive and transmit errors, and active-interface count.
- Never send interface names, IP addresses, or MAC addresses.
- VPN and physical traffic can overlap. Aggregate throughput may therefore count encapsulated traffic more than once.
- Report `network_unavailable` when no eligible interface exists and preserve the last valid frontend snapshot.
- Compact shows current Down and Up rates.
- Full shows 60 seconds of receive/transmit history, current rates, totals, interface count, and errors.
- Throughput has no severity threshold because link capacity is unknown. Errors use danger styling.

### Shared behavior

- Use native Rust and portable `sysinfo`; never execute external tools.
- Use IEC units and IEC rates.
- Packaged backends support the existing health Ping/Pong protocol.
- Add both widgets to workspace, preparation, catalog, health-probe, browser, responsive, and screenshot coverage.
- Update README and record implementation tradeoffs and verification results here.
- Stop for playtest and code review before commit.

## Verification plan

- Backend tests cover percentages, root selection, rate calculation, privacy-safe serialization, interface eligibility, aggregation, and empty-source errors.
- Manifest preparation covers both variants and frontend artifacts.
- Chromium covers catalog metadata, telemetry rendering, health, Zen/editor behavior, and desktop/mobile projection.
- Review wide and narrow screenshots.
- Run workspace tests, Clippy with warnings denied, formatting, production builds, widget preparation, browser integration, and Nix flake checks before commit.

## Implementation notes

- Added native `disk` and `network` workspace backends with one-second telemetry and health probe support.
- Disk selects the longest root-containing mount internally and publishes no mount or device identity. Filesystem labels are restricted to 24 safe ASCII characters.
- Disk rates use `sysinfo` per-refresh byte deltas divided by actual elapsed time rather than assuming an exact one-second scheduler interval.
- Network excludes down and loopback interfaces, aggregates counters with saturating arithmetic, and publishes only counts and byte/error metrics.
- Network deliberately includes active VPN and physical interfaces without exposing identity. Encapsulated traffic can therefore overlap as accepted.
- Repeated unavailable scans emit one backend error per unavailable period rather than one error every second. A recovered telemetry update restores healthy state.
- Added compact 1x1 and full 3x2 frontends with local parsing, IEC formatting, 60-sample histories, responsive rendering, and the accepted capacity/error severity rules.
- Added both widgets to workspace packaging, catalog assertions, frontend serving, backend Ping/Pong process coverage, health assertions, and browser scenarios.

## Tradeoffs

- Root-only capacity avoids a dynamic mount selector and filesystem path disclosure. Multi-filesystem support remains deferred.
- Throughput graphs scale to their current 60-second maximum. This preserves low-rate visibility but means vertical scale changes between samples.
- Aggregated network totals are useful host activity indicators, not billing-grade counters, because virtual and physical layers can overlap.

## Verification results

- Disk and Network backend tests and Clippy with warnings denied pass.
- Both production frontend builds and widget preparation pass.
- Chromium integration passes catalog, telemetry, dimensions, health, backend probes, privacy assertions, desktop rendering, mobile projection, and existing scenarios.
- Wide Zen/editor and 420 px screenshots were reviewed.
- Full workspace tests, Clippy with warnings denied, production builds, widget preparation, Chromium integration, and Nix flake checks pass.
