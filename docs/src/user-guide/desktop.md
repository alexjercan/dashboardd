# Desktop widget windows

`dashboardd-desktop` is a resident graphical-session service. It embeds an independent widget runtime, starts with no windows, and remains available through its tray icon after the last window closes.

Use `dashboardctl` through the same-user session socket:

```console
dashboardctl discover
dashboardctl open cpu --variant full
dashboardctl list
dashboardctl update surface-1 --presentation tile
dashboardctl focus surface-1
dashboardctl close surface-1
dashboardctl quit
```

`discover` returns the installed widgets and their public variants, options, and input contracts as JSON. It does not return backend or frontend paths.

Each `open` creates a new runtime instance and native window. It never reuses another surface. Supply option and typed-input maps as JSON objects:

```console
dashboardctl open example --variant full \
  --options '{"limit":20}' \
  --inputs '{"task":{"type":"task/v1","value":{"id":"task-1"}}}'
```

`update --inputs` replaces the complete direct-input map. Omit it to retain current inputs. Widget options are immutable; close and reopen a surface to change them.

A Tatr Artifact window accepts one atomic project, worktree, task, and initial artifact reference. The window's artifact picker can then switch files within that task:

```console
dashboardctl open tatr-tasks --variant details \
  --inputs '{"artifact":{"type":"tatr.task-artifact-reference/v1","value":{"project_id":"project-...","worktree_id":"worktree-...","task_id":"20260820-094041","artifact":"TASK.md"}}}'
```

Windows are ordinary, decorated, and resizable. Their initial aspect ratio follows the selected manifest variant. Native close deletes the associated runtime instance. Tray Quit and `dashboardctl quit` close all surfaces, stop all widget backends, and exit the service.
