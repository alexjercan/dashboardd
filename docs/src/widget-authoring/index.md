# Widget authoring

A widget package contains one backend executable and one or more frontend variants. dashboardd treats the installed package as trusted local software.

```mermaid
graph TD
    Package[Installed widget package]
    Package --> Manifest[widget.json]
    Package --> Backend[Backend executable]
    Package --> Frontends[Frontend ES modules]
    Server[dashboardd] <-->|JSON Lines v1| Backend
    Browser[Browser] -->|mount and update| Frontends
    Frontends -->|HTTP message| Server
```

The three extension contracts are versioned independently:

- [Runtime bundle](runtime-bundle.md) - discovery and metadata.
- [Backend protocol](backend-protocol.md) - process communication.
- [Frontend contract](frontend.md) - browser lifecycle and capabilities.

The current repository packer is development tooling for bundled widgets. A standalone external packer is planned. External authors can already construct the documented runtime layout directly.

## Trust boundary

A backend runs with the dashboardd user's permissions. Install widgets only from trusted sources. Runtime manifests contain artifact paths and metadata only. They must never contain build commands.

Frontend code runs in the dashboard page inside a Shadow DOM mount. Shadow DOM isolates styles, not authority. A frontend can use the capabilities supplied through `WidgetContext`.
