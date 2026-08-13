# Project skeleton decisions

- STATUS: CLOSED
- PRIORITY: 100
- TAGS: skeleton,tooling

# Project skeleton decisions

This task records the accepted skeleton decisions.

## Decisions

- Store the skeleton record in this TATR task, not `docs/`.
- Use Gruber Darker colors from the supplied pi theme.
- Map dashboard colors semantically: background `#181818`, raised surface `#282828`, selected surface `#453d41`, foreground `#e4e4ef`, bright foreground `#f4f4ff`, muted text `#65737e`, dim text `#535057`, accent `#ffdd33`, border `#96a6c8`, success `#73c936`, error `#f43841`, warning `#ffdd33`, secondary `#9e95c7`.
- Select a free Webpack dev port from `7000-7999`.
- Use the latest Rust nightly, with `rust-src`, `clippy`, `rustfmt`, and `rust-analyzer`.

## Scope

- Keep the Rust daemon and static frontend minimal.
- Do not add HTTP, WebSocket, or widget protocol behavior yet.
