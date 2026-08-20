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

## Tray menu

The tray's Open Widget menu is generated from installed widgets. A variant with no required input opens immediately. A variant with required input opens a launch dialog. Enter one JSON value for each displayed immutable input type. Values are validated for that launch and are not saved.

## Home Manager

The flake exports one Home Manager module for both hosts:

```nix
imports = [ inputs.dashboardd.homeManagerModules.default ];

programs.dashboardd = {
  enable = true;
  port = 8000;
  autoStart = true;
  widgetPackages = [ inputs.today.packages.${pkgs.system}.dashboardd-widget ];
};

programs.dashboardd-desktop = {
  enable = true;
  autoStart = true;
};
```

Both hosts start by default. Set either `autoStart` option to `false` to install an on-demand service. Launch an on-demand native host from rofi or run `dashboardd-desktop-start`; both start `dashboardd-desktop.service`.

Both services use `Restart=on-failure`. Tray Quit is a successful exit and does not restart the native host. The package installs `dashboardctl` on `PATH`.

Windows are ordinary, decorated, and resizable. Their initial aspect ratio follows the selected manifest variant. Native close deletes the associated runtime instance. Tray Quit and `dashboardctl quit` close all surfaces, stop all widget backends, and exit the service.
