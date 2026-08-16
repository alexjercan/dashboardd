# Compatibility

Widget contracts use independent versions because they change at different rates.

## Runtime manifest

`schema_version` in `widget.json` selects the complete manifest shape. dashboardd rejects unsupported versions. A breaking metadata or discovery change requires a new schema version.

## Backend protocol

Every JSON Lines envelope contains `version`. A backend and dashboardd must use the same major protocol version. Adding an optional object field is compatible because decoders ignore unknown fields. New required fields, message kinds, framing, or changed semantics require another protocol version.

Widget-owned `message` and `update` payloads are outside the dashboardd protocol. The widget owns their versioning.

## Frontend SDK

`@dashboardd/widget-sdk` uses semantic versions:

- Patch - documentation, declarations, or fixes that preserve behavior.
- Minor - additive optional APIs.
- Major - removed APIs, new requirements, or changed behavior.

The frontend bundle imports SDK code at build time. dashboardd does not inject an SDK module at runtime. GitHub release tarballs and the `dashboardd#widget-sdk` Nix package contain the same packed files.

## Prototype policy

No external widget release exists yet. Until the first tagged SDK and packaging release, dashboardd can replace these contracts cleanly without compatibility adapters. After release, supported versions and removal dates must be stated in release notes before removal.

## Widget identity

Widget, variant, option, and port IDs are persistence keys. Renaming one is a breaking package change even when the protocol and SDK remain compatible.
