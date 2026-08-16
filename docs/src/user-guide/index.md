# User guide

A dashboard owns a canonical 3 to 24 column layout, widget instances, options, and links. Desktop layouts fill the viewport. Narrow displays project the same composition into a scrolling three-column view.

Dashboard routes are:

- `/` - dashboard home.
- `/d/<dashboard-id>` - Zen view.
- `/d/<dashboard-id>/edit` - layout editor.
- `/d/<dashboard-id>/focus/<instance-id>` - focused widget.

All dashboards continue running for immediate switching. Widget instance IDs are globally unique. Shared widget package state remains global.

The dashboard home can create, open, edit, rename, duplicate, and delete dashboards. An invalid or obsolete prototype state file stops startup instead of being migrated.
