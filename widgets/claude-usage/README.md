# Claude Usage widget

Shows Claude subscription limits from the local Claude Code login.

## Variants

- `full` (3x2): weekly Fable usage first, then weekly all-model usage.
- `compact` (3x1): weekly Fable usage, with all-model usage as a fallback.
- `minimal` (1x1): important remaining percentage only.

Values are whole percentages remaining. Detailed variants show the subscription type, relative reset time, relative update time, and remaining-capacity bars.

## Data source

The backend reads Claude Code OAuth credentials from
`$CLAUDE_CONFIG_DIR/.credentials.json`, or `$HOME/.claude/.credentials.json`,
and requests the Claude OAuth usage resource. Credentials and raw provider
responses are not sent to the frontend or written to logs.

Normalized usage is shared through `$XDG_CACHE_HOME/dashboardd`, with
`$HOME/.cache/dashboardd` as the fallback. This prevents duplicate full, compact,
and minimal instances from polling Claude independently.

The cache refreshes after five minutes. Temporary errors preserve the last
successful value. Data older than 15 minutes is marked stale.

Full and compact frontends request the current cached value when they mount and
provide a manual Refresh button. Manual refresh bypasses cache freshness but
still obeys the shared refresh lock and provider `Retry-After` limits. Minimal
frontends request the current value on mount but do not show a button.
