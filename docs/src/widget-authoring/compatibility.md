# Compatibility

Widget contracts use independent versions because they change at different rates.

## Source manifest

`schema_version` in `widget.toml` selects the packer input shape. Source version 2 contains built artifact paths and no build-system fields. It is versioned independently from the generated runtime manifest.

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

The released frontend SDK follows its semantic-version rules. Packaging and runtime contracts can still change cleanly before their first tagged dashboardd release. After release, supported versions and removal dates must be stated in release notes before removal.

## Widget identity

Widget, variant, option, and port IDs are persistence keys. Renaming one is a breaking package change even when the protocol and SDK remain compatible.
