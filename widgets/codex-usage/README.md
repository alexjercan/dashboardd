# Codex Usage widget

Shows the primary weekly Codex subscription limit from the installed Codex CLI.

## Variants

- `compact` (3x1): title, subscription type, weekly remaining percentage, bar,
  relative reset time, and relative update time.
- `minimal` (1x1): weekly remaining percentage only.

## Data source

The backend starts the official Codex app server, requests an authentication
refresh, and reads `account/rateLimits/read`. It uses the primary `codex` weekly
limit and intentionally ignores model-specific limits such as Codex Spark.

The user-facing account plan is preferred over internal metering tiers. Tokens,
account identifiers, and raw app-server responses are not sent to the frontend
or written to logs.

The backend polls every five minutes. Temporary errors preserve the last
successful value. Data older than 15 minutes is marked stale.

Both frontends request the current in-memory value when they mount. The compact
variant also provides a manual Refresh button that requests a new app-server
snapshot. The minimal variant does not show a button.
