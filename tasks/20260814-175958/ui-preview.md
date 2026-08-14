# Artifact viewer preview

This Markdown file checks common content in the Task Artifact widget.

## Summary

- Markdown headings and lists
- Inline `code` and a fenced block
- Tables, quotes, emphasis, and links
- Relative artifact navigation

> The artifact viewer defaults to `TASK.md`. Select this file from the identity menu.

| Format | State | Notes |
| --- | --- | --- |
| Markdown | Ready | Sanitized rendering |
| HTML | Ready | Active content removed |
| PNG | Ready | Signature and size validated |

```json
{
  "project": "scufris",
  "artifact": "ui-preview.md",
  "status": "ready"
}
```

Open the [HTML preview](ui-preview.html) or [PNG preview](ui-preview.png).

**Result:** The artifact selector can navigate between task-local files.
