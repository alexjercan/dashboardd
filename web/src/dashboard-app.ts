import { isWidgetModule, type WidgetFrontend } from "@dashboardd/widget-sdk";
import { CommandPalette } from "./command-palette";
import {
  connectDashboard,
  type ConnectionStatus,
  type DashboardConnection,
} from "./dashboard";
import { WidgetLinkBus } from "./links";
import { WidgetStateBus } from "./state";
import {
  parseDashboard,
  parseDashboardList,
  parseInstance,
  type DashboardLayout,
  type DashboardLink,
  type Instance,
  type InstanceHealth,
  type Theme,
  type WidgetDescriptor,
  type WidgetOption,
  type WidgetVariant,
} from "./protocol";

const app = document.querySelector<HTMLElement>("#app")!;
const route = parseDashboardRoute(window.location.pathname);
const dashboardId = route?.dashboardId ?? "";
const dashboardPath = `/d/${encodeURIComponent(dashboardId)}`;
const apiDashboardPath = `/api/v1/dashboards/${encodeURIComponent(dashboardId)}`;

app.innerHTML = `
  <section class="dashboard-shell">
    <div class="dashboard-content">
      <h1 id="zen-heading" class="sr-only">dashboardd Dashboard</h1>
      <header id="editor-header" class="dashboard-header" hidden>
        <h1 id="editor-heading" tabindex="-1">Edit dashboard</h1>
        <div class="canvas-columns" aria-label="Dashboard columns">
          <button id="decrease-columns" class="icon-button" type="button" aria-label="Decrease columns">-</button>
          <span><strong id="column-count">9</strong> columns</span>
          <button id="increase-columns" class="icon-button" type="button" aria-label="Increase columns">+</button>
        </div>
        <a id="finish-editing" class="button primary" href="${dashboardPath}">Done</a>
      </header>
      <div id="dashboard-error" class="dashboard-error" role="alert" hidden></div>
      <div id="dashboard-announcement" class="sr-only" aria-live="polite"></div>
      <section id="empty-dashboard" class="empty-dashboard" hidden>
        <span>No widgets</span>
        <a class="empty-edit" href="${dashboardPath}/edit">Edit dashboard</a>
      </section>
      <main id="widgets" class="dashboard-grid" aria-label="Dashboard widgets"></main>
      <footer class="dashboard-footer">
        <span id="keyboard-hint" class="keyboard-hint"><strong id="keyboard-mode">DASHBOARD</strong><span id="keyboard-keys"> hjkl select  i interact  f focus  e edit  ? help</span></span>
        <span class="connection-state"><span id="connection-indicator" class="status-dot" aria-hidden="true"></span><span id="connection-status">Connecting...</span></span>
        <label class="dashboard-switcher-label"><span class="sr-only">Dashboard</span><select id="dashboard-switcher"><option>Dashboards</option></select></label>
        <a id="edit-layout" class="zen-edit" href="${dashboardPath}/edit">Edit</a>
      </footer>
    </div>
  </section>
  <section id="focus-layer" class="focus-layer" aria-labelledby="focus-title" hidden>
    <header class="focus-header">
      <h1 id="focus-title" tabindex="-1">Widget Focus</h1>
      <button id="close-focus" class="button" type="button">Close</button>
    </header>
    <div id="focus-stage" class="focus-stage"></div>
  </section>
  <dialog id="add-widget" class="modal">
    <form method="dialog">
      <header><h2>Add widget</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <p id="add-position" class="modal-position"></p>
      <div class="widget-picker">
        <div id="widget-catalog" class="widget-catalog" aria-label="Widget catalog"></div>
        <section id="widget-selection" class="widget-selection" tabindex="-1" hidden>
          <button id="back-to-widgets" class="back-to-widgets" type="button">&lt; Back</button>
          <h3 id="selected-widget-name"></h3>
          <p id="selected-widget-description" class="widget-description"></p>
          <fieldset><legend>Variant</legend><div id="widget-variants" class="widget-variants"></div></fieldset>
          <fieldset><legend>Options</legend><div id="widget-options" class="widget-options"></div></fieldset>
          <fieldset id="widget-links-fieldset" hidden><legend>Links</legend><div id="widget-links" class="widget-options"></div></fieldset>
        </section>
      </div>
      <footer><button class="button" value="cancel">Cancel</button><button id="confirm-add" class="button primary" type="button" disabled>Add widget</button></footer>
    </form>
  </dialog>
  <dialog id="link-widget" class="modal confirm-modal">
    <form method="dialog">
      <header><h2>Link widget</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <label class="relink-control"><span id="link-input-name">Widget source</span><select id="link-source"></select></label>
      <footer><button class="button" value="cancel">Cancel</button><button id="confirm-link" class="button primary" type="button">Save link</button></footer>
    </form>
  </dialog>
  <dialog id="widget-health" class="modal health-modal">
    <form method="dialog">
      <header><h2 id="health-title">Widget health</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <dl class="health-details">
        <div><dt>Status</dt><dd id="health-status"></dd></div>
        <div><dt>Started</dt><dd id="health-started"></dd></div>
        <div><dt>Last update</dt><dd id="health-updated"></dd></div>
        <div><dt>Restarts</dt><dd id="health-restarts"></dd></div>
        <div class="health-error-row"><dt>Last error</dt><dd id="health-error"></dd></div>
      </dl>
      <footer><button class="button" value="cancel">Close</button><button id="restart-widget" class="button danger" type="button">Restart backend</button></footer>
    </form>
  </dialog>
  <dialog id="remove-widget" class="modal confirm-modal">
    <form method="dialog">
      <header><h2 id="remove-title">Remove widget?</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <p>This stops its backend and clears its current data.</p>
      <footer><button class="button" value="cancel">Cancel</button><button id="confirm-remove" class="button danger" type="button">Remove</button></footer>
    </form>
  </dialog>
  <dialog id="add-keyboard-help" class="modal keyboard-help-modal">
    <form method="dialog">
      <header><h2>Add Widget keys</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <dl class="keyboard-help-list">
        <div><dt>j / k</dt><dd>Next or previous widget or variant</dd></div>
        <div><dt>g g / G</dt><dd>First or last widget in the catalog</dd></div>
        <div><dt>l / Enter</dt><dd>Configure the highlighted widget</dd></div>
        <div><dt>h</dt><dd>Return to the widget catalog</dd></div>
        <div><dt>a</dt><dd>Add the configured widget</dd></div>
        <div><dt>Tab</dt><dd>Navigate options and links normally</dd></div>
        <div><dt>Esc</dt><dd>Close this help or Add Widget</dd></div>
      </dl>
      <footer><button class="button primary" value="cancel">Close</button></footer>
    </form>
  </dialog>
  <dialog id="keyboard-help" class="modal keyboard-help-modal">
    <form method="dialog">
      <header><h2>Keyboard commands</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <dl class="keyboard-help-list">
        <div><dt>h j k l</dt><dd>Move the dashboard cursor one cell</dd></div>
        <div><dt>g g</dt><dd>Move the cursor to the first cell</dd></div>
        <div><dt>i / Enter</dt><dd>Interact with the selected widget</dd></div>
        <div><dt>f</dt><dd>Focus the selected widget</dd></div>
        <div><dt>e / z</dt><dd>Open Editor / return to Zen</dd></div>
        <div><dt>d / g h</dt><dd>Choose a dashboard / open dashboard home</dd></div>
        <div><dt>a / x</dt><dd>Add at the cursor / remove the widget under it in Editor</dd></div>
        <div><dt>v</dt><dd>Pick up the widget under the Editor cursor for a staged move</dd></div>
        <div><dt>:</dt><dd>Open the command palette</dd></div>
        <div><dt>Esc</dt><dd>Leave widget interaction or close the current layer</dd></div>
      </dl>
      <footer><button class="button primary" value="cancel">Close</button></footer>
    </form>
  </dialog>
`;

const statusElement = required<HTMLElement>("#connection-status");
const dashboardSwitcher = required<HTMLSelectElement>("#dashboard-switcher");
const indicatorElement = required<HTMLElement>("#connection-indicator");
const widgetsElement = required<HTMLElement>("#widgets");
const dashboardShell = required<HTMLElement>(".dashboard-shell");
const focusLayer = required<HTMLElement>("#focus-layer");
const focusStage = required<HTMLElement>("#focus-stage");
const focusTitle = required<HTMLElement>("#focus-title");
const closeFocusButton = required<HTMLButtonElement>("#close-focus");
const errorElement = required<HTMLElement>("#dashboard-error");
const announcementElement = required<HTMLElement>("#dashboard-announcement");
const editorHeader = required<HTMLElement>("#editor-header");
const editorHeading = required<HTMLElement>("#editor-heading");
const columnCount = required<HTMLElement>("#column-count");
const decreaseColumns = required<HTMLButtonElement>("#decrease-columns");
const increaseColumns = required<HTMLButtonElement>("#increase-columns");
const emptyDashboard = required<HTMLElement>("#empty-dashboard");
const editButton = required<HTMLAnchorElement>("#edit-layout");
const doneButton = required<HTMLAnchorElement>("#finish-editing");
const addDialog = required<HTMLDialogElement>("#add-widget");
const removeDialog = required<HTMLDialogElement>("#remove-widget");
const healthDialog = required<HTMLDialogElement>("#widget-health");
const linkDialog = required<HTMLDialogElement>("#link-widget");
const helpDialog = required<HTMLDialogElement>("#keyboard-help");
const addHelpDialog = required<HTMLDialogElement>("#add-keyboard-help");
const keyboardModeElement = required<HTMLElement>("#keyboard-mode");
const keyboardKeysElement = required<HTMLElement>("#keyboard-keys");
const catalogElement = required<HTMLElement>("#widget-catalog");
const selectionElement = required<HTMLElement>("#widget-selection");
const selectedNameElement = required<HTMLElement>("#selected-widget-name");
const selectedDescriptionElement = required<HTMLElement>(
  "#selected-widget-description",
);
const variantsElement = required<HTMLElement>("#widget-variants");
const optionsElement = required<HTMLElement>("#widget-options");
const linksFieldset = required<HTMLElement>("#widget-links-fieldset");
const linksElement = required<HTMLElement>("#widget-links");
const linkSourceElement = required<HTMLSelectElement>("#link-source");
const linkInputName = required<HTMLElement>("#link-input-name");
const confirmLinkButton = required<HTMLButtonElement>("#confirm-link");
const backToWidgetsButton = required<HTMLButtonElement>("#back-to-widgets");
const addPositionElement = required<HTMLElement>("#add-position");
const confirmAddButton = required<HTMLButtonElement>("#confirm-add");
const confirmRemoveButton = required<HTMLButtonElement>("#confirm-remove");
const removeTitleElement = required<HTMLElement>("#remove-title");
const healthTitleElement = required<HTMLElement>("#health-title");
const healthStatusElement = required<HTMLElement>("#health-status");
const healthStartedElement = required<HTMLElement>("#health-started");
const healthUpdatedElement = required<HTMLElement>("#health-updated");
const healthRestartsElement = required<HTMLElement>("#health-restarts");
const healthErrorElement = required<HTMLElement>("#health-error");
const restartWidgetButton = required<HTMLButtonElement>("#restart-widget");
for (const dialog of [
  addDialog,
  linkDialog,
  healthDialog,
  removeDialog,
  helpDialog,
  addHelpDialog,
]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
const descriptors = new Map<string, WidgetDescriptor>();
const resources = new Map<string, Instance>();
const instanceHealth = new Map<string, InstanceHealth>();
const frontends = new Map<string, WidgetFrontend>();
const containers = new Map<string, HTMLElement>();
const mounting = new Map<string, Promise<void>>();
const pendingUpdates = new Map<string, unknown>();
const linkBus = new WidgetLinkBus();
const stateBus = new WidgetStateBus();
let editing = route?.mode === "edit";
let focusedInstanceId = route?.focusInstanceId ?? null;
let previousFocusedInstanceId: string | null = null;
let snapshotLoaded = false;
let dashboardLayout: DashboardLayout = { columns: 1 };
let selectedSlot: { column: number; row: number } | null = null;
let selectedWidget: {
  widgetId: string;
  variantId: string;
  options: Record<string, boolean | number | string>;
  links: Array<{
    source_instance_id: string;
    source_port: string;
    target_port: string;
  }>;
} | null = null;
let removeInstanceId: string | null = null;
let healthInstanceId: string | null = null;
let relinkTarget: {
  instanceId: string;
  input: string;
  required: boolean;
} | null = null;
let drag: DragState | null = null;
let connection: DashboardConnection;
let controlsTimer: number | null = null;
let keyboardMode: "dashboard" | "widget" = focusedInstanceId
  ? "widget"
  : "dashboard";
let selectedInstanceId: string | null = focusedInstanceId;
let keyboardCursor = { column: 0, row: 0 };
let moveState: {
  instanceId: string;
  originalCursor: { column: number; row: number };
  width: number;
  height: number;
} | null = null;
let addPendingFirstKey = false;
let addPendingFirstKeyTimer: number | null = null;
let pendingFirstKey = false;
let pendingFirstKeyTimer: number | null = null;
const dashboardNames = new Map<string, string>();
const commandPalette = new CommandPalette(
  dashboardCommandCandidates,
  executeDashboardCommand,
);

type DashboardCommand =
  | "select-left"
  | "select-down"
  | "select-up"
  | "select-right"
  | "cursor-home"
  | "open-home"
  | "enter-widget"
  | "open-focus"
  | "open-editor"
  | "open-zen"
  | "open-switcher"
  | "open-palette"
  | "open-help"
  | "add-widget"
  | "remove-widget"
  | "toggle-move"
  | "commit-move"
  | "escape";

type DragState = {
  instanceId: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  target:
    | { kind: "slot"; column: number; row: number }
    | { kind: "instance"; instanceId: string }
    | null;
};

for (const link of [
  editButton,
  doneButton,
  required<HTMLAnchorElement>(".empty-edit"),
])
  link.addEventListener("click", navigateDashboard);
window.addEventListener("popstate", () => syncRoute(true));
window.addEventListener("resize", renderCanvas);
confirmAddButton.addEventListener("click", () => void createSelectedWidget());
backToWidgetsButton.addEventListener("click", showWidgetCatalog);
addDialog.addEventListener("keydown", handleAddDialogKeydown);
addDialog.addEventListener("close", clearAddFirstKey);
confirmRemoveButton.addEventListener(
  "click",
  () => void removeSelectedWidget(),
);
confirmLinkButton.addEventListener("click", () => void saveLink());
restartWidgetButton.addEventListener(
  "click",
  () => void restartSelectedWidget(),
);
dashboardSwitcher.addEventListener("change", () => void switchDashboard());
decreaseColumns.addEventListener(
  "click",
  () => void updateDashboardColumns(dashboardLayout.columns - 1),
);
increaseColumns.addEventListener(
  "click",
  () => void updateDashboardColumns(dashboardLayout.columns + 1),
);
closeFocusButton.addEventListener("click", closeFocus);
document.addEventListener("pointerdown", handleCanvasPointerDown, true);
healthDialog.addEventListener("close", () => {
  healthInstanceId = null;
  resetRestartConfirmation();
});
for (const eventName of ["pointermove", "pointerdown", "touchstart", "keydown"])
  window.addEventListener(eventName, showControls, { passive: true });
showControls();
renderKeyboardState();
document.addEventListener("keydown", handleDashboardKeydown, true);

function showControls(): void {
  document.body.classList.add("controls-active");
  if (controlsTimer !== null) window.clearTimeout(controlsTimer);
  controlsTimer = window.setTimeout(() => {
    document.body.classList.remove("controls-active");
    controlsTimer = null;
  }, 3_000);
}

function handleDashboardKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey)
    return;
  if (window.matchMedia("(max-width: 580px)").matches) return;
  if ([...document.querySelectorAll("dialog")].some((dialog) => dialog.open))
    return;
  if (event.key === "Escape") {
    const openMenus =
      document.querySelectorAll<HTMLDetailsElement>("details[open]");
    const openMenu = openMenus[openMenus.length - 1];
    if (openMenu) {
      event.preventDefault();
      event.stopPropagation();
      openMenu.open = false;
      return;
    }
  }

  if (moveState) {
    const moveCommand: Partial<Record<string, DashboardCommand>> = {
      h: "select-left",
      j: "select-down",
      k: "select-up",
      l: "select-right",
      Enter: "commit-move",
      v: "toggle-move",
      Escape: "toggle-move",
      "?": "open-help",
    };
    const command = moveCommand[event.key];
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    dispatchDashboardCommand(command);
    return;
  }

  if (keyboardMode === "widget") {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setKeyboardMode("dashboard");
    containers.get(selectedInstanceId ?? "")?.focus();
    return;
  }

  if (isEditableEventPath(event)) return;
  const moveHandle = event
    .composedPath()
    .find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement &&
        target.classList.contains("drag-handle"),
    );
  const arrowOffsets: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const arrowOffset = arrowOffsets[event.key];
  const moveFrame = moveHandle?.closest<HTMLElement>(".dashboard-widget");
  if (editing && arrowOffset && moveFrame?.dataset.instanceId) {
    event.preventDefault();
    event.stopPropagation();
    moveInstanceByOffset(moveFrame.dataset.instanceId, ...arrowOffset);
    return;
  }
  if (pendingFirstKey) {
    const command: DashboardCommand | null =
      event.key === "g"
        ? "cursor-home"
        : event.key === "h"
          ? "open-home"
          : null;
    clearFirstKey();
    if (command) {
      event.preventDefault();
      dispatchDashboardCommand(command);
      return;
    }
  }
  if (event.key === "g") {
    event.preventDefault();
    pendingFirstKey = true;
    pendingFirstKeyTimer = window.setTimeout(clearFirstKey, 700);
    return;
  }
  const command: Partial<Record<string, DashboardCommand>> = editing
    ? {
        h: "select-left",
        j: "select-down",
        k: "select-up",
        l: "select-right",
        a: "add-widget",
        x: "remove-widget",
        v: "toggle-move",
        Enter: "commit-move",
        z: "open-zen",
        Escape: "escape",
        d: "open-switcher",
        ":": "open-palette",
        "?": "open-help",
      }
    : {
        h: "select-left",
        j: "select-down",
        k: "select-up",
        l: "select-right",
        i: "enter-widget",
        Enter: "enter-widget",
        f: "open-focus",
        e: "open-editor",
        d: "open-switcher",
        Escape: "escape",
        ":": "open-palette",
        "?": "open-help",
      };
  const selected = command[event.key];
  if (!selected) return;
  event.preventDefault();
  event.stopPropagation();
  dispatchDashboardCommand(selected);
}

function dispatchDashboardCommand(command: DashboardCommand): void {
  switch (command) {
    case "select-left":
    case "select-down":
    case "select-up":
    case "select-right": {
      const direction = command.slice("select-".length) as
        "left" | "down" | "up" | "right";
      moveKeyboardCursor(direction);
      break;
    }
    case "cursor-home":
      setKeyboardCursor(0, 0);
      break;
    case "open-home":
      window.location.assign("/");
      break;
    case "enter-widget":
      enterSelectedWidget();
      break;
    case "open-focus": {
      const instance = instanceUnderCursor();
      if (instance) openFocus(instance.id);
      break;
    }
    case "open-editor":
      navigateTo(`${dashboardPath}/edit`);
      break;
    case "open-zen":
      navigateTo(dashboardPath);
      break;
    case "open-switcher":
      commandPalette.open("dashboard ");
      break;
    case "open-palette":
      commandPalette.open();
      break;
    case "open-help":
      helpDialog.showModal();
      break;
    case "add-widget": {
      if (instanceUnderCursor()) announce("That position is occupied");
      else openAddDialog(keyboardCursor.column, keyboardCursor.row);
      break;
    }
    case "remove-widget": {
      const instance = instanceUnderCursor();
      if (instance) openRemoveDialog(instance.id);
      else announce("No widget at the cursor");
      break;
    }
    case "toggle-move":
      if (moveState) cancelKeyboardMove();
      else beginKeyboardMove();
      break;
    case "commit-move":
      commitKeyboardMove();
      break;
    case "escape":
      if (drag) cancelDrag();
      else if (focusedInstanceId) closeFocus();
      else if (editing) navigateTo(dashboardPath);
      break;
  }
}

function isEditableEventPath(event: Event): boolean {
  return event.composedPath().some((target) => {
    if (!(target instanceof HTMLElement)) return false;
    const dialog = target.closest<HTMLDialogElement>("dialog");
    if (dialog && !dialog.open) return false;
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    );
  });
}

function clearFirstKey(): void {
  pendingFirstKey = false;
  if (pendingFirstKeyTimer !== null) {
    window.clearTimeout(pendingFirstKeyTimer);
    pendingFirstKeyTimer = null;
  }
}

function setKeyboardMode(mode: "dashboard" | "widget"): void {
  keyboardMode = mode;
  renderKeyboardState();
  announce(mode === "widget" ? "Widget mode" : "Dashboard mode");
}

function selectInstance(instanceId: string, focus = true): void {
  const instance = resources.get(instanceId);
  if (!instance) return;
  setKeyboardCursor(instance.layout.column, instance.layout.row, false);
  if (focus) containers.get(instanceId)?.focus();
}

function setKeyboardCursor(
  column: number,
  row: number,
  announcePosition = true,
): void {
  const rowCount = Number(
    widgetsElement.style.getPropertyValue("--dashboard-rows"),
  );
  keyboardCursor = {
    column: Math.max(
      0,
      Math.min(dashboardLayout.columns - (moveState?.width ?? 1), column),
    ),
    row: Math.max(
      0,
      Math.min(Math.max(0, rowCount - (moveState?.height ?? 1)), row),
    ),
  };
  selectedInstanceId = instanceUnderCursor()?.id ?? null;
  renderKeyboardState();
  if (announcePosition)
    announce(
      `Cursor at column ${keyboardCursor.column + 1}, row ${keyboardCursor.row + 1}`,
    );
}

function moveKeyboardCursor(direction: "left" | "down" | "up" | "right"): void {
  const underCursor = instanceUnderCursor();
  const blockers = moveState
    ? overlappingInstances(
        keyboardCursor.column,
        keyboardCursor.row,
        moveState.width,
        moveState.height,
        moveState.instanceId,
      )
    : underCursor
      ? [underCursor]
      : [];
  if (blockers.length === 0) {
    const offsets = {
      left: [-1, 0],
      right: [1, 0],
      up: [0, -1],
      down: [0, 1],
    } as const;
    const [columnOffset, rowOffset] = offsets[direction];
    setKeyboardCursor(
      keyboardCursor.column + columnOffset,
      keyboardCursor.row + rowOffset,
    );
    return;
  }

  if (direction === "left")
    setKeyboardCursor(
      Math.min(...blockers.map((instance) => instance.layout.column)) -
        (moveState?.width ?? 1),
      keyboardCursor.row,
    );
  else if (direction === "right")
    setKeyboardCursor(
      Math.max(
        ...blockers.map(
          (instance) => instance.layout.column + instance.layout.width,
        ),
      ),
      keyboardCursor.row,
    );
  else if (direction === "up")
    setKeyboardCursor(
      keyboardCursor.column,
      Math.min(...blockers.map((instance) => instance.layout.row)) -
        (moveState?.height ?? 1),
    );
  else
    setKeyboardCursor(
      keyboardCursor.column,
      Math.max(
        ...blockers.map(
          (instance) => instance.layout.row + instance.layout.height,
        ),
      ),
    );
}

function beginKeyboardMove(): void {
  if (!editing) return;
  const instance = instanceUnderCursor();
  if (!instance) {
    announce("No widget at the cursor");
    return;
  }
  moveState = {
    instanceId: instance.id,
    originalCursor: { ...keyboardCursor },
    width: instance.layout.width,
    height: instance.layout.height,
  };
  setKeyboardCursor(instance.layout.column, instance.layout.row, false);
  announce("Move mode");
}

function cancelKeyboardMove(): void {
  const state = moveState;
  if (!state) return;
  moveState = null;
  setKeyboardCursor(
    state.originalCursor.column,
    state.originalCursor.row,
    false,
  );
  announce("Move cancelled");
}

function commitKeyboardMove(): void {
  const state = moveState;
  const source = state && resources.get(state.instanceId);
  if (!state || !source) return;
  const column = keyboardCursor.column;
  const row = keyboardCursor.row;
  const targets = overlappingInstances(
    column,
    row,
    state.width,
    state.height,
    source.id,
  );
  if (targets.length > 1) {
    announce("That position is unavailable");
    return;
  }
  moveState = null;
  renderKeyboardState();
  if (column === source.layout.column && row === source.layout.row) {
    announce("Move cancelled");
    return;
  }
  if (targets[0]) void swapInstances(source.id, targets[0].id);
  else void moveInstance(source.id, column, row);
}

function overlappingInstances(
  column: number,
  row: number,
  width: number,
  height: number,
  excludeId: string,
): Instance[] {
  return [...resources.values()].filter(
    (instance) =>
      instance.id !== excludeId &&
      column < instance.layout.column + instance.layout.width &&
      column + width > instance.layout.column &&
      row < instance.layout.row + instance.layout.height &&
      row + height > instance.layout.row,
  );
}

function instanceUnderCursor(): Instance | undefined {
  return [...resources.values()].find(
    (instance) =>
      keyboardCursor.column >= instance.layout.column &&
      keyboardCursor.column < instance.layout.column + instance.layout.width &&
      keyboardCursor.row >= instance.layout.row &&
      keyboardCursor.row < instance.layout.row + instance.layout.height,
  );
}

function renderKeyboardState(): void {
  const underCursor = instanceUnderCursor();
  selectedInstanceId = underCursor?.id ?? null;
  for (const [instanceId, frame] of containers) {
    frame.classList.toggle(
      "keyboard-selected",
      keyboardMode === "widget" && instanceId === selectedInstanceId,
    );
    frame.classList.toggle(
      "keyboard-under-cursor",
      !moveState &&
        keyboardMode === "dashboard" &&
        instanceId === selectedInstanceId,
    );
    frame.classList.toggle(
      "keyboard-move-source",
      moveState?.instanceId === instanceId,
    );
  }
  widgetsElement.querySelector(".dashboard-keyboard-cursor")?.remove();
  if (!focusedInstanceId) {
    const cursor = document.createElement("div");
    const expandedInstance = editing && !moveState ? underCursor : undefined;
    cursor.className = "dashboard-keyboard-cursor";
    cursor.classList.toggle("occupied", Boolean(underCursor));
    cursor.classList.toggle("moving", Boolean(moveState));
    cursor.classList.toggle("expanded", Boolean(expandedInstance));
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.setProperty(
      "--widget-column",
      String((expandedInstance?.layout.column ?? keyboardCursor.column) + 1),
    );
    cursor.style.setProperty(
      "--widget-row",
      String((expandedInstance?.layout.row ?? keyboardCursor.row) + 1),
    );
    cursor.style.setProperty(
      "--widget-width",
      String(moveState?.width ?? expandedInstance?.layout.width ?? 1),
    );
    cursor.style.setProperty(
      "--widget-height",
      String(moveState?.height ?? expandedInstance?.layout.height ?? 1),
    );
    widgetsElement.append(cursor);
  }
  keyboardModeElement.textContent = moveState
    ? "MOVE"
    : editing
      ? "EDITOR"
      : keyboardMode === "widget"
        ? "WIDGET"
        : "DASHBOARD";
  keyboardKeysElement.textContent = moveState
    ? " hjkl place  Enter commit  v/Esc cancel"
    : editing
      ? " hjkl cursor  a add  x remove  v move  z zen  ? help"
      : keyboardMode === "widget"
        ? " Esc dashboard mode"
        : " hjkl cursor  i interact  f focus  e edit  ? help";
  document.body.dataset.keyboardMode = moveState
    ? "move"
    : editing
      ? "editor"
      : keyboardMode;
}

function enterSelectedWidget(): void {
  if (editing) return;
  const instance = instanceUnderCursor();
  const frame = instance && containers.get(instance.id);
  if (!frame) return;
  selectedInstanceId = instance.id;
  setKeyboardMode("widget");
  const target = frame.querySelector<HTMLElement>(
    ".dashboard-widget-mount input, .dashboard-widget-mount textarea, .dashboard-widget-mount select, .dashboard-widget-mount button, .dashboard-widget-mount [tabindex]:not([tabindex='-1'])",
  );
  (target ?? frame).focus();
}

function handleCanvasPointerDown(event: PointerEvent): void {
  const path = event.composedPath();
  const frame = path.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement &&
      target.classList.contains("dashboard-widget"),
  );
  if (frame?.dataset.instanceId) {
    selectInstance(frame.dataset.instanceId, false);
    if (!editing) setKeyboardMode("widget");
    return;
  }
  const slot = path.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement &&
      target.classList.contains("dashboard-slot"),
  );
  if (editing && slot)
    setKeyboardCursor(Number(slot.dataset.column), Number(slot.dataset.row));
  else if (!editing) setKeyboardMode("dashboard");
}

function dashboardCommandCandidates(): string[] {
  return [
    "edit",
    "zen",
    "focus",
    "home",
    "help",
    ...[...dashboardNames.values()].map((name) => `dashboard ${name}`),
  ];
}

function executeDashboardCommand(value: string): string | null {
  const [name, ...arguments_] = value.split(/\s+/);
  if (name === "edit" && arguments_.length === 0)
    dispatchDashboardCommand("open-editor");
  else if (name === "zen" && arguments_.length === 0)
    dispatchDashboardCommand("open-zen");
  else if (name === "focus" && arguments_.length === 0)
    dispatchDashboardCommand("open-focus");
  else if (name === "home" && arguments_.length === 0)
    dispatchDashboardCommand("open-home");
  else if (name === "help" && arguments_.length === 0)
    window.setTimeout(() => helpDialog.showModal());
  else if (name === "dashboard" && arguments_.length > 0) {
    const requested = arguments_.join(" ");
    const match = [...dashboardNames].find(
      ([, dashboardName]) => dashboardName === requested,
    );
    if (match) window.location.assign(`/d/${encodeURIComponent(match[0])}`);
    else return `Dashboard not found: ${requested}`;
  } else return `Unknown command: ${value}`;
  return null;
}

function navigateTo(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  syncRoute(true);
}

function renderStatus(status: ConnectionStatus): void {
  const labels: Record<ConnectionStatus, string> = {
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Reconnecting...",
    error: "Connection error",
  };
  statusElement.textContent = labels[status];
  indicatorElement.dataset.status = status;
}

function showError(message: string): void {
  delete errorElement.dataset.source;
  errorElement.textContent = message;
  if (!snapshotLoaded && message === "dashboard was not found") {
    const home = document.createElement("a");
    home.className = "button";
    home.href = "/";
    home.textContent = "Dashboard home";
    errorElement.append(" ", home);
  }
  errorElement.hidden = false;
}

function showConfigurationError(message: string): void {
  errorElement.dataset.source = "configuration";
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function applyTheme(theme: Theme): void {
  for (const [name, value] of Object.entries(theme)) {
    if (name === "fonts") continue;
    document.documentElement.style.setProperty(
      `--dashboardd-color-${name.replaceAll("_", "-")}`,
      value as string,
    );
  }
  document.documentElement.style.setProperty(
    "--dashboardd-font-sans",
    `"${theme.fonts.sans}", ui-sans-serif, system-ui, sans-serif`,
  );
  document.documentElement.style.setProperty(
    "--dashboardd-font-mono",
    `"${theme.fonts.mono}", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`,
  );
  if (errorElement.dataset.source === "configuration") clearError();
}

function clearError(): void {
  delete errorElement.dataset.source;
  errorElement.hidden = true;
}

function applySnapshot(
  layout: DashboardLayout,
  widgets: WidgetDescriptor[],
  instances: Instance[],
  health: InstanceHealth[],
  links: DashboardLink[],
): void {
  dashboardLayout = layout;
  renderCanvasDimensions();
  widgetsElement.style.setProperty(
    "--dashboard-columns",
    String(layout.columns),
  );
  descriptors.clear();
  for (const descriptor of widgets) descriptors.set(descriptor.id, descriptor);
  void stateBus.reconcile(widgets.map((widget) => widget.id));
  const currentIds = new Set(instances.map((instance) => instance.id));
  for (const instanceId of resources.keys()) {
    if (!currentIds.has(instanceId)) removeInstance(instanceId);
  }
  instanceHealth.clear();
  for (const record of health) instanceHealth.set(record.instance_id, record);
  for (const instance of instances) upsertInstance(instance);
  linkBus.replace(links);
  snapshotLoaded = true;
  renderCanvas();
}

function upsertInstance(instance: Instance): void {
  resources.set(instance.id, instance);
  const frame = containers.get(instance.id);
  if (frame) applyLayout(frame, instance);
  if (!descriptors.has(instance.widget_id)) return;
  if (!frontends.has(instance.id) && !mounting.has(instance.id)) {
    const promise = mountWidget(instance).finally(() =>
      mounting.delete(instance.id),
    );
    mounting.set(instance.id, promise);
  }
  renderCanvas();
}

async function mountWidget(instance: Instance): Promise<void> {
  const descriptor = descriptors.get(instance.widget_id);
  if (!descriptor) return;
  const frame = document.createElement("section");
  frame.className = "dashboard-widget";
  frame.dataset.instanceId = instance.id;
  frame.dataset.widgetId = instance.widget_id;
  applyLayout(frame, instance);
  const mount = document.createElement("div");
  mount.className = "dashboard-widget-mount";
  const focusButton = document.createElement("button");
  focusButton.className = "widget-focus-button";
  focusButton.type = "button";
  focusButton.textContent = "Focus";
  focusButton.setAttribute(
    "aria-label",
    `Focus ${descriptor.name} ${variantFor(instance, descriptor).name}`,
  );
  focusButton.addEventListener("click", () => openFocus(instance.id));
  const dragHandle = document.createElement("button");
  dragHandle.className = "drag-handle";
  dragHandle.type = "button";
  dragHandle.innerHTML = '<span aria-hidden="true">:::</span>';
  dragHandle.setAttribute("aria-label", `Move ${descriptor.name}`);
  dragHandle.addEventListener("pointerdown", startDrag);
  dragHandle.addEventListener("pointermove", updateDrag);
  dragHandle.addEventListener("pointerup", finishDrag);
  dragHandle.addEventListener("pointercancel", cancelDrag);
  const healthButton = document.createElement("button");
  healthButton.className = "widget-health-button";
  healthButton.type = "button";
  healthButton.innerHTML =
    '<span class="widget-health-dot" aria-hidden="true"></span><span class="widget-health-label">Starting</span>';
  healthButton.addEventListener("click", () => openHealthDialog(instance.id));
  const linkControls = document.createElement("div");
  linkControls.className = "widget-link-controls";
  const remove = document.createElement("button");
  remove.className = "remove-widget";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${descriptor.name}`);
  remove.addEventListener("click", () => openRemoveDialog(instance.id));
  frame.addEventListener("focusin", (event) => {
    const widgetContentFocused =
      event.target instanceof Node && mount.contains(event.target);
    if ((editing && event.target !== frame) || widgetContentFocused)
      selectInstance(instance.id, false);
    if (!editing && widgetContentFocused) setKeyboardMode("widget");
  });
  frame.append(
    mount,
    focusButton,
    healthButton,
    linkControls,
    dragHandle,
    remove,
  );
  containers.set(instance.id, frame);
  renderCanvas();

  try {
    const module: unknown = await import(
      /* webpackIgnore: true */ variantFor(instance, descriptor).frontend_url
    );
    if (!isWidgetModule(module)) throw new Error("invalid widget module");
    const frontend = module.mount(mount, {
      widgetId: instance.widget_id,
      variantId: instance.variant_id,
      instanceId: instance.id,
      options: instance.options,
      links: linkBus.context(instance.id),
      sharedState: stateBus.context(instance.widget_id),
      send: (payload) => connection.sendWidget(instance.id, payload),
    });
    if (!resources.has(instance.id)) {
      frontend.destroy();
      frame.remove();
      containers.delete(instance.id);
      return;
    }
    frontends.set(instance.id, frontend);
    frontend.setPresentation?.(
      focusedInstanceId === instance.id ? "focus" : "tile",
    );
    if (pendingUpdates.has(instance.id)) {
      frontend.update(pendingUpdates.get(instance.id));
      pendingUpdates.delete(instance.id);
    }
  } catch (error) {
    frame.remove();
    containers.delete(instance.id);
    if (focusedInstanceId === instance.id)
      leaveInvalidFocus(
        `Could not focus ${descriptor.name}: widget failed to load`,
      );
    else showError(`Could not load ${descriptor.name}: ${errorMessage(error)}`);
  }
}

function navigateDashboard(event: MouseEvent): void {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  const link = event.currentTarget as HTMLAnchorElement;
  window.history.pushState(null, "", link.href);
  syncRoute(true);
}

function openFocus(instanceId: string): void {
  if (!supportsFocus(instanceId) || editing) return;
  selectedInstanceId = instanceId;
  keyboardMode = "widget";
  window.history.pushState(
    { dashboarddFocus: true },
    "",
    `${dashboardPath}/focus/${encodeURIComponent(instanceId)}`,
  );
  syncRoute(true);
}

function closeFocus(): void {
  if (!focusedInstanceId) return;
  if (isFocusHistoryEntry()) window.history.back();
  else {
    window.history.replaceState(null, "", dashboardPath);
    syncRoute(true);
  }
}

function isFocusHistoryEntry(): boolean {
  return (
    typeof window.history.state === "object" &&
    window.history.state !== null &&
    window.history.state.dashboarddFocus === true
  );
}

function parseDashboardRoute(pathname: string): {
  dashboardId: string;
  mode: "zen" | "edit" | "focus";
  focusInstanceId: string | null;
} | null {
  const match = /^\/d\/([^/]+)(?:\/(edit|focus\/([^/]+)))?$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      dashboardId: decodeURIComponent(match[1]),
      mode: match[2] === "edit" ? "edit" : match[3] ? "focus" : "zen",
      focusInstanceId: match[3] ? decodeURIComponent(match[3]) : null,
    };
  } catch {
    return null;
  }
}

function syncRoute(focus: boolean): void {
  previousFocusedInstanceId = focusedInstanceId;
  const nextRoute = parseDashboardRoute(window.location.pathname);
  focusedInstanceId = nextRoute?.focusInstanceId ?? null;
  const nextEditing = nextRoute?.mode === "edit";
  if (!nextEditing) {
    cancelDrag();
    if (moveState) cancelKeyboardMove();
  }
  editing = nextEditing;
  if (focusedInstanceId) {
    selectedInstanceId = focusedInstanceId;
    keyboardMode = "widget";
  } else if (editing) keyboardMode = "dashboard";
  else if (previousFocusedInstanceId) keyboardMode = "dashboard";
  document.title = focusedInstanceId
    ? "Widget Focus - dashboardd"
    : editing
      ? "Edit dashboard - dashboardd"
      : "dashboardd Dashboard";
  renderCanvas();
  if (!focus) return;
  if (focusedInstanceId) closeFocusButton.focus();
  else if (previousFocusedInstanceId)
    containers
      .get(previousFocusedInstanceId)
      ?.querySelector<HTMLButtonElement>(".widget-focus-button")
      ?.focus();
  else (editing ? editorHeading : editButton).focus();
}

function renderCanvas(): void {
  renderCanvasDimensions();
  widgetsElement.classList.toggle("editing", editing);
  document.body.classList.toggle("editing", editing);
  editorHeader.hidden = !editing;
  editButton.hidden = editing;
  emptyDashboard.hidden = editing || resources.size > 0;
  for (const [instanceId, frame] of containers) {
    frame.tabIndex = editing ? 0 : -1;
    renderFocusControl(instanceId, frame);
    renderHealthControl(instanceId, frame);
    renderLinkControls(instanceId, frame);
  }
  const instances = [...resources.values()].sort(
    (left, right) =>
      left.layout.row - right.layout.row ||
      left.layout.column - right.layout.column ||
      left.id.localeCompare(right.id),
  );
  widgetsElement.replaceChildren();

  if (!editing) {
    for (const instance of instances) {
      const frame = containers.get(instance.id);
      if (frame) widgetsElement.append(frame);
    }
    renderFocusLayer();
    renderKeyboardState();
    return;
  }

  const occupied = new Map<string, Instance>();
  let occupiedRows = 0;
  for (const instance of instances) {
    occupiedRows = Math.max(
      occupiedRows,
      instance.layout.row + instance.layout.height,
    );
    for (
      let row = instance.layout.row;
      row < instance.layout.row + instance.layout.height;
      row++
    ) {
      for (
        let column = instance.layout.column;
        column < instance.layout.column + instance.layout.width;
        column++
      ) {
        occupied.set(`${column}:${row}`, instance);
      }
    }
  }
  const rowCount = Number(
    widgetsElement.style.getPropertyValue("--dashboard-rows"),
  );
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < dashboardLayout.columns; column++) {
      const instance = occupied.get(`${column}:${row}`);
      if (instance) {
        if (instance.layout.column === column && instance.layout.row === row) {
          const frame = containers.get(instance.id);
          if (frame) widgetsElement.append(frame);
        }
        continue;
      }
      const slot = document.createElement("button");
      slot.className = "dashboard-slot";
      slot.type = "button";
      slot.dataset.column = String(column);
      slot.dataset.row = String(row);
      slot.style.setProperty("--widget-column", String(column + 1));
      slot.style.setProperty("--widget-row", String(row + 1));
      slot.innerHTML = `<span aria-hidden="true">+</span><span class="sr-only">Add widget at column ${column + 1}, row ${row + 1}</span>`;
      slot.addEventListener("click", () => openAddDialog(column, row));
      slot.addEventListener("focus", () =>
        setKeyboardCursor(column, row, false),
      );
      widgetsElement.append(slot);
    }
  }
  renderFocusLayer();
  renderKeyboardState();
}

function renderFocusControl(instanceId: string, frame: HTMLElement): void {
  const button = frame.querySelector<HTMLButtonElement>(".widget-focus-button");
  if (!button) return;
  button.hidden = editing || !supportsFocus(instanceId);
}

function supportsFocus(instanceId: string): boolean {
  const instance = resources.get(instanceId);
  const descriptor = instance && descriptors.get(instance.widget_id);
  return Boolean(
    instance && descriptor && variantFor(instance, descriptor).focus,
  );
}

function renderFocusLayer(): void {
  if (!focusedInstanceId) {
    focusLayer.hidden = true;
    focusStage.replaceChildren();
    dashboardShell.inert = false;
    dashboardShell.removeAttribute("aria-hidden");
    document.body.classList.remove("focused");
    for (const instanceId of containers.keys())
      setWidgetPresentation(instanceId, "tile");
    return;
  }

  const instance = resources.get(focusedInstanceId);
  const descriptor = instance && descriptors.get(instance.widget_id);
  const variant = instance && descriptor && variantFor(instance, descriptor);
  const frame = containers.get(focusedInstanceId);
  if (
    snapshotLoaded &&
    (!instance || !descriptor || !variant?.focus || !frame)
  ) {
    leaveInvalidFocus(
      !instance
        ? "Could not focus widget: instance was not found"
        : "Could not focus widget: variant does not support Focus",
    );
    return;
  }
  if (!instance || !descriptor || !variant || !frame) return;

  focusTitle.textContent = `${descriptor.name} - ${variant.name}`;
  closeFocusButton.setAttribute(
    "aria-label",
    `Close ${descriptor.name} ${variant.name} Focus`,
  );
  focusLayer.hidden = false;
  dashboardShell.inert = true;
  dashboardShell.setAttribute("aria-hidden", "true");
  document.body.classList.add("focused");
  focusStage.replaceChildren(frame);
  for (const instanceId of containers.keys())
    setWidgetPresentation(
      instanceId,
      instanceId === focusedInstanceId ? "focus" : "tile",
    );
}

function setWidgetPresentation(
  instanceId: string,
  presentation: "tile" | "focus",
): void {
  const frame = containers.get(instanceId);
  if (!frame || frame.dataset.presentation === presentation) return;
  frame.dataset.presentation = presentation;
  try {
    frontends.get(instanceId)?.setPresentation?.(presentation);
  } catch (error) {
    showError(`Could not update widget presentation: ${errorMessage(error)}`);
  }
}

function leaveInvalidFocus(message: string): void {
  previousFocusedInstanceId = focusedInstanceId;
  focusedInstanceId = null;
  window.history.replaceState(null, "", dashboardPath);
  renderCanvas();
  showError(message);
}

function renderHealthControl(instanceId: string, frame: HTMLElement): void {
  const button = frame.querySelector<HTMLButtonElement>(
    ".widget-health-button",
  );
  if (!button) return;
  const health = instanceHealth.get(instanceId);
  const status = health?.status ?? "starting";
  const label = healthStatusLabel(status);
  button.dataset.status = status;
  button.hidden = !editing;
  button.title = `Widget health: ${label}`;
  button.setAttribute("aria-label", `Widget health: ${label}`);
  const text = button.querySelector<HTMLElement>(".widget-health-label");
  if (text) text.textContent = label;
}

function updateInstanceHealth(health: InstanceHealth): void {
  instanceHealth.set(health.instance_id, health);
  const frame = containers.get(health.instance_id);
  if (frame) renderHealthControl(health.instance_id, frame);
  if (healthInstanceId === health.instance_id) renderHealthDialog(health);
}

function healthStatusLabel(status: InstanceHealth["status"]): string {
  return status[0].toUpperCase() + status.slice(1);
}

function renderLinkControls(instanceId: string, frame: HTMLElement): void {
  const controls = frame.querySelector<HTMLElement>(".widget-link-controls");
  if (!controls) return;
  controls.replaceChildren();
  if (!editing) return;
  const instance = resources.get(instanceId);
  const descriptor = instance && descriptors.get(instance.widget_id);
  if (!instance || !descriptor) return;
  for (const output of descriptor.outputs.filter(
    (port) =>
      port.variants.length === 0 || port.variants.includes(instance.variant_id),
  )) {
    const outgoing = linkBus
      .list()
      .filter(
        (link) =>
          link.source_instance_id === instanceId &&
          link.source_port === output.id,
      );
    if (outgoing.length === 0) continue;
    const badge = document.createElement("span");
    badge.className = "widget-link-badge output";
    badge.tabIndex = 0;
    badge.textContent = `${output.name} -> ${outgoing.length} ${outgoing.length === 1 ? "widget" : "widgets"}`;
    bindLinkHighlight(badge, [
      instanceId,
      ...outgoing.map((link) => link.target_instance_id),
    ]);
    controls.append(badge);
  }
  for (const input of descriptor.inputs.filter(
    (port) =>
      port.variants.length === 0 || port.variants.includes(instance.variant_id),
  )) {
    const link = linkBus
      .list()
      .find(
        (candidate) =>
          candidate.target_instance_id === instanceId &&
          candidate.target_port === input.id,
      );
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "widget-link-badge input";
    const source = link && resources.get(link.source_instance_id);
    badge.textContent = source
      ? `${input.name}: ${instanceLabel(source)}`
      : `${input.name}: Not linked`;
    badge.addEventListener("click", () => openLinkDialog(instanceId, input.id));
    bindLinkHighlight(
      badge,
      link ? [instanceId, link.source_instance_id] : [instanceId],
    );
    controls.append(badge);
  }
}

function bindLinkHighlight(element: HTMLElement, instanceIds: string[]): void {
  const toggle = (active: boolean) => {
    for (const instanceId of instanceIds)
      containers.get(instanceId)?.classList.toggle("linked-highlight", active);
  };
  element.addEventListener("mouseenter", () => toggle(true));
  element.addEventListener("mouseleave", () => toggle(false));
  element.addEventListener("focus", () => toggle(true));
  element.addEventListener("blur", () => toggle(false));
}

function openLinkDialog(instanceId: string, inputId: string): void {
  const instance = resources.get(instanceId);
  if (!instance) return;
  const descriptor = descriptors.get(instance.widget_id);
  const input = descriptor?.inputs.find(
    (port) =>
      port.id === inputId &&
      (port.variants.length === 0 ||
        port.variants.includes(instance.variant_id)),
  );
  if (!input) return;
  relinkTarget = {
    instanceId,
    input: inputId,
    required: input.required,
  };
  linkInputName.textContent = input.name;
  linkSourceElement.replaceChildren();
  const current = linkBus
    .list()
    .find(
      (link) =>
        link.target_instance_id === instanceId && link.target_port === inputId,
    );
  if (!input.required) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Not linked";
    none.selected = !current;
    linkSourceElement.append(none);
  }
  for (const source of compatibleOutputs(input.type).filter(
    (source) => source.instance.id !== instanceId,
  )) {
    const option = document.createElement("option");
    option.value = `${source.instance.id}\u0000${source.port}`;
    option.textContent = instanceLabel(source.instance);
    option.selected =
      current?.source_instance_id === source.instance.id &&
      current.source_port === source.port;
    linkSourceElement.append(option);
  }
  confirmLinkButton.disabled =
    input.required && linkSourceElement.options.length === 0;
  linkDialog.showModal();
}

async function saveLink(): Promise<void> {
  const target = relinkTarget;
  if (!target || (target.required && !linkSourceElement.value)) return;
  confirmLinkButton.disabled = true;
  try {
    const url = `${apiDashboardPath}/links/${encodeURIComponent(target.instanceId)}/${encodeURIComponent(target.input)}`;
    if (!linkSourceElement.value) {
      const linked = linkBus
        .list()
        .some(
          (link) =>
            link.target_instance_id === target.instanceId &&
            link.target_port === target.input,
        );
      if (!linked) {
        linkDialog.close();
        renderCanvas();
        return;
      }
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      linkBus.delete(target.instanceId, target.input);
    } else {
      const [sourceInstanceId, sourcePort] =
        linkSourceElement.value.split("\u0000");
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_instance_id: sourceInstanceId,
          source_port: sourcePort,
        }),
      });
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      linkBus.update((await response.json()) as DashboardLink);
    }
    linkDialog.close();
    renderCanvas();
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    confirmLinkButton.disabled = false;
    relinkTarget = null;
  }
}

function startDrag(event: PointerEvent): void {
  if (!editing || event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const frame = handle.closest<HTMLElement>(".dashboard-widget");
  const instanceId = frame?.dataset.instanceId;
  if (!instanceId) return;
  drag = {
    instanceId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
    target: null,
  };
  handle.setPointerCapture(event.pointerId);
}

function updateDrag(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const frame = containers.get(drag.instanceId);
  if (!frame) return cancelDrag();
  if (!drag.started) {
    if (
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8
    )
      return;
    drag.started = true;
    frame.classList.add("dragging");
    widgetsElement.classList.add("drag-active");
  }
  event.preventDefault();
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const slot = element?.closest<HTMLElement>(".dashboard-slot");
  const targetFrame = element?.closest<HTMLElement>(".dashboard-widget");
  setDragTarget(
    slot
      ? {
          kind: "slot",
          column: Number(slot.dataset.column),
          row: Number(slot.dataset.row),
        }
      : targetFrame?.dataset.instanceId &&
          targetFrame.dataset.instanceId !== drag.instanceId
        ? { kind: "instance", instanceId: targetFrame.dataset.instanceId }
        : null,
  );
}

function finishDrag(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const target = drag.started ? drag.target : null;
  const instanceId = drag.instanceId;
  cancelDrag();
  if (target?.kind === "slot")
    void moveInstance(instanceId, target.column, target.row);
  else if (target?.kind === "instance")
    void swapInstances(instanceId, target.instanceId);
}

function cancelDrag(): void {
  if (!drag) return;
  const frame = containers.get(drag.instanceId);
  const handle = frame?.querySelector<HTMLElement>(".drag-handle");
  if (handle?.hasPointerCapture(drag.pointerId))
    handle.releasePointerCapture(drag.pointerId);
  frame?.classList.remove("dragging");
  widgetsElement.classList.remove("drag-active");
  setDragTarget(null);
  drag = null;
}

function setDragTarget(target: DragState["target"]): void {
  for (const element of widgetsElement.querySelectorAll(".drop-target"))
    element.classList.remove("drop-target");
  drag && (drag.target = target);
  if (target?.kind === "slot") {
    widgetsElement
      .querySelector<HTMLElement>(
        `.dashboard-slot[data-column="${target.column}"][data-row="${target.row}"]`,
      )
      ?.classList.add("drop-target");
  } else if (target?.kind === "instance") {
    containers.get(target.instanceId)?.classList.add("drop-target");
  }
}

function moveInstanceByOffset(
  instanceId: string,
  columnOffset: number,
  rowOffset: number,
): void {
  const instance = resources.get(instanceId);
  if (!instance) return;
  const column = instance.layout.column + columnOffset;
  const row = instance.layout.row + rowOffset;
  if (!isWithinBounds(instance, column, row)) {
    announce("That position is unavailable");
    return;
  }
  const target = instanceAt(column, row, instance.id);
  if (target) void swapInstances(instance.id, target.id);
  else void moveInstance(instance.id, column, row);
}

function isWithinBounds(
  instance: Instance,
  column: number,
  row: number,
): boolean {
  return (
    column >= 0 &&
    row >= 0 &&
    column + instance.layout.width <= dashboardLayout.columns
  );
}

function instanceAt(
  column: number,
  row: number,
  excludeId: string,
): Instance | undefined {
  return [...resources.values()].find(
    (other) =>
      other.id !== excludeId &&
      column >= other.layout.column &&
      column < other.layout.column + other.layout.width &&
      row >= other.layout.row &&
      row < other.layout.row + other.layout.height,
  );
}

async function moveInstance(
  instanceId: string,
  column: number,
  row: number,
): Promise<void> {
  const instance = resources.get(instanceId);
  if (
    !instance ||
    !isWithinBounds(instance, column, row) ||
    instanceAt(column, row, instanceId)
  ) {
    announce("That position is unavailable");
    return;
  }
  clearError();
  try {
    const updated = await apiRequest(
      `${apiDashboardPath}/instances/${encodeURIComponent(instanceId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: { column, row } }),
      },
    );
    if (updated) upsertInstance(updated);
    announce(
      `${descriptors.get(instance.widget_id)?.name ?? "Widget"} moved to column ${column + 1}, row ${row + 1}`,
    );
    containers.get(instanceId)?.focus();
  } catch (error) {
    const message = errorMessage(error);
    showError(message);
    announce(message);
  }
}

async function swapInstances(
  sourceId: string,
  targetId: string,
): Promise<void> {
  const source = resources.get(sourceId);
  const target = resources.get(targetId);
  if (!source || !target) return;
  clearError();
  try {
    const response = await fetch(`${apiDashboardPath}/layout/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_instance_id: sourceId,
        target_instance_id: targetId,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        body?.error?.message ?? `${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as { instances: unknown[] };
    for (const value of body.instances) upsertInstance(parseInstance(value));
    announce(
      `${descriptors.get(source.widget_id)?.name ?? "Widget"} swapped with ${descriptors.get(target.widget_id)?.name ?? "widget"}`,
    );
    containers.get(sourceId)?.focus();
  } catch (error) {
    const message = errorMessage(error);
    showError(message);
    announce(message);
  }
}

function announce(message: string): void {
  announcementElement.textContent = "";
  requestAnimationFrame(() => (announcementElement.textContent = message));
}

function applyLayout(frame: HTMLElement, instance: Instance): void {
  frame.style.setProperty(
    "--widget-column",
    String(instance.layout.column + 1),
  );
  frame.style.setProperty("--widget-row", String(instance.layout.row + 1));
  frame.dataset.column = String(instance.layout.column);
  frame.dataset.row = String(instance.layout.row);
  frame.style.setProperty("--widget-width", String(instance.layout.width));
  frame.style.setProperty("--widget-height", String(instance.layout.height));
  frame.dataset.layout = `${instance.layout.width}x${instance.layout.height}`;
}

function handleAddDialogKeydown(event: KeyboardEvent): void {
  if (
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    isEditableEventPath(event)
  )
    return;
  const configuring = !selectionElement.hidden;
  if (!configuring && addPendingFirstKey) {
    const first = event.key === "g";
    clearAddFirstKey();
    if (first) {
      event.preventDefault();
      highlightAddChoice(0);
      return;
    }
  }
  if (!configuring && event.key === "g") {
    event.preventDefault();
    addPendingFirstKey = true;
    addPendingFirstKeyTimer = window.setTimeout(clearAddFirstKey, 700);
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    addHelpDialog.showModal();
    return;
  }
  if (!configuring && event.key === "G") {
    event.preventDefault();
    highlightAddChoice(catalogElement.children.length - 1);
    return;
  }
  if (event.key === "j" || event.key === "k") {
    event.preventDefault();
    if (configuring) cycleVariant(event.key === "j" ? 1 : -1);
    else cycleAddChoice(event.key === "j" ? 1 : -1);
    return;
  }
  if (!configuring && (event.key === "l" || event.key === "Enter")) {
    event.preventDefault();
    catalogElement
      .querySelector<HTMLButtonElement>(".widget-choice.selected")
      ?.click();
  } else if (configuring && event.key === "h") {
    event.preventDefault();
    showWidgetCatalog();
  } else if (configuring && event.key === "a") {
    event.preventDefault();
    if (!confirmAddButton.disabled) void createSelectedWidget();
  }
}

function clearAddFirstKey(): void {
  addPendingFirstKey = false;
  if (addPendingFirstKeyTimer !== null) {
    window.clearTimeout(addPendingFirstKeyTimer);
    addPendingFirstKeyTimer = null;
  }
}

function cycleAddChoice(offset: number): void {
  const choices = [
    ...catalogElement.querySelectorAll<HTMLButtonElement>(".widget-choice"),
  ];
  const current = choices.findIndex((choice) =>
    choice.classList.contains("selected"),
  );
  highlightAddChoice(
    Math.max(0, Math.min(choices.length - 1, current + offset)),
  );
}

function highlightAddChoice(index: number): void {
  const choices = [
    ...catalogElement.querySelectorAll<HTMLButtonElement>(".widget-choice"),
  ];
  const selected = choices[index];
  if (!selected) return;
  for (const choice of choices)
    choice.classList.toggle("selected", choice === selected);
  selected.focus();
}

function cycleVariant(offset: number): void {
  const variants = [
    ...variantsElement.querySelectorAll<HTMLButtonElement>(".variant-choice"),
  ];
  const current = variants.findIndex((variant) =>
    variant.classList.contains("selected"),
  );
  const next =
    variants[Math.max(0, Math.min(variants.length - 1, current + offset))];
  if (!next || next === variants[current]) return;
  next.click();
  selectionElement.focus();
}

function openAddDialog(column: number, row: number): void {
  selectedSlot = { column, row };
  selectedWidget = null;
  addPositionElement.textContent = `Position: Column ${column + 1}, Row ${row + 1}`;
  selectionElement.hidden = true;
  catalogElement.hidden = false;
  confirmAddButton.disabled = true;
  catalogElement.replaceChildren();
  for (const descriptor of [...descriptors.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const choice = document.createElement("button");
    choice.className = "widget-choice";
    choice.type = "button";
    choice.dataset.widgetId = descriptor.id;
    choice.innerHTML = `<strong>${descriptor.name}</strong><span>${descriptor.description}</span>`;
    choice.addEventListener("click", () => selectWidget(descriptor, choice));
    catalogElement.append(choice);
  }
  addDialog.showModal();
  highlightAddChoice(0);
}

function selectWidget(
  descriptor: WidgetDescriptor,
  choice: HTMLButtonElement,
): void {
  for (const item of catalogElement.children) item.classList.remove("selected");
  choice.classList.add("selected");
  selectedNameElement.textContent = descriptor.name;
  selectedDescriptionElement.textContent = descriptor.description;
  selectionElement.hidden = false;
  if (window.matchMedia("(max-width: 680px)").matches)
    catalogElement.hidden = true;
  renderVariants(descriptor, descriptor.variants[0]);
  selectionElement.focus();
}

function renderVariants(
  descriptor: WidgetDescriptor,
  selectedVariant: WidgetVariant,
): void {
  selectedWidget = {
    widgetId: descriptor.id,
    variantId: selectedVariant.id,
    options: {},
    links: [],
  };
  variantsElement.replaceChildren();
  for (const variant of descriptor.variants) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "variant-choice";
    button.classList.toggle("selected", variant.id === selectedVariant.id);
    button.innerHTML = `<strong>${variant.name}</strong><span>${variant.width}x${variant.height}</span>`;
    button.addEventListener("click", () => renderVariants(descriptor, variant));
    variantsElement.append(button);
  }
  renderOptions(descriptor.options, selectedVariant.id);
  renderLinks(descriptor, selectedVariant.id);
}

function renderOptions(options: WidgetOption[], variantId: string): void {
  optionsElement.replaceChildren();
  const applicable = options.filter(
    (option) =>
      option.variants.length === 0 || option.variants.includes(variantId),
  );
  if (applicable.length === 0) {
    const empty = document.createElement("p");
    empty.className = "no-options";
    empty.textContent = "No options for this variant";
    optionsElement.append(empty);
    return;
  }
  for (const option of applicable) {
    const label = document.createElement("label");
    label.className = `widget-option ${option.type}`;
    const control = optionControl(option);
    control.setAttribute("aria-describedby", `option-${option.id}-description`);
    control.addEventListener("input", () => {
      if (!selectedWidget) return;
      selectedWidget.options[option.id] = optionValue(option, control);
    });
    if (selectedWidget)
      selectedWidget.options[option.id] = optionValue(option, control);
    const text = document.createElement("span");
    text.innerHTML = `<strong>${option.name}</strong><small id="option-${option.id}-description">${option.description}</small>`;
    label.append(control, text);
    optionsElement.append(label);
  }
}

function renderLinks(descriptor: WidgetDescriptor, variantId: string): void {
  linksElement.replaceChildren();
  const inputs = descriptor.inputs.filter((port) =>
    port.variants.length === 0 ? true : port.variants.includes(variantId),
  );
  linksFieldset.hidden = inputs.length === 0;
  if (inputs.length === 0) {
    confirmAddButton.disabled = false;
    return;
  }
  for (const input of inputs) {
    const label = document.createElement("label");
    label.className = "widget-option select";
    const select = document.createElement("select");
    select.dataset.targetPort = input.id;
    select.dataset.required = String(input.required);
    const compatible = compatibleOutputs(input.type);
    if (!input.required) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "Not linked";
      select.append(none);
    }
    for (const source of compatible) {
      const option = document.createElement("option");
      option.value = `${source.instance.id}\u0000${source.port}`;
      option.textContent = instanceLabel(source.instance);
      select.append(option);
    }
    if (compatible.length === 0 && input.required) {
      const unavailable = document.createElement("option");
      unavailable.value = "";
      unavailable.textContent = "Add a compatible widget first";
      select.append(unavailable);
      select.disabled = true;
    }
    const text = document.createElement("span");
    text.innerHTML = `<strong>${input.name}</strong><small>${input.required ? "Required" : "Optional"} compatible widget output</small>`;
    label.append(select, text);
    linksElement.append(label);
    select.addEventListener("change", updateSelectedLinks);
  }
  updateSelectedLinks();
}

function updateSelectedLinks(): void {
  if (!selectedWidget) return;
  const controls = [
    ...linksElement.querySelectorAll<HTMLSelectElement>("select"),
  ];
  selectedWidget.links = controls.flatMap((control) => {
    if (!control.value) return [];
    const [source_instance_id, source_port] = control.value.split("\u0000");
    return [
      {
        source_instance_id,
        source_port,
        target_port: control.dataset.targetPort ?? "",
      },
    ];
  });
  confirmAddButton.disabled = controls.some(
    (control) => control.dataset.required === "true" && !control.value,
  );
}

function compatibleOutputs(linkType: string): Array<{
  instance: Instance;
  port: string;
}> {
  const compatible = [];
  for (const instance of resources.values()) {
    const descriptor = descriptors.get(instance.widget_id);
    if (!descriptor) continue;
    for (const output of descriptor.outputs) {
      if (
        output.type === linkType &&
        (output.variants.length === 0 ||
          output.variants.includes(instance.variant_id))
      )
        compatible.push({ instance, port: output.id });
    }
  }
  return compatible.sort((left, right) =>
    left.instance.id.localeCompare(right.instance.id),
  );
}

function instanceLabel(instance: Instance): string {
  const name = descriptors.get(instance.widget_id)?.name ?? "Widget";
  return `${name} at column ${instance.layout.column + 1}, row ${instance.layout.row + 1}`;
}

function optionControl(
  option: WidgetOption,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  if (option.type === "select") {
    const select = document.createElement("select");
    for (const choice of option.choices) {
      const item = document.createElement("option");
      item.value = choice.value;
      item.textContent = choice.name;
      item.selected = choice.value === option.default;
      select.append(item);
    }
    return select;
  }
  if (option.type === "text" && option.multiline) {
    const textarea = document.createElement("textarea");
    textarea.rows = 5;
    textarea.value = String(option.default);
    return textarea;
  }
  const input = document.createElement("input");
  if (option.type === "boolean") {
    input.type = "checkbox";
    input.checked = option.default === true;
  } else if (option.type === "text") {
    input.type = "text";
    input.value = String(option.default);
  } else {
    input.type = "number";
    input.value = String(option.default);
    input.min = String(option.minimum);
    input.max = String(option.maximum);
    input.step = String(option.step);
  }
  return input;
}

function optionValue(
  option: WidgetOption,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): boolean | number | string {
  if (option.type === "boolean") return (control as HTMLInputElement).checked;
  if (option.type === "integer") return Number(control.value);
  return control.value;
}

function showWidgetCatalog(): void {
  selectionElement.hidden = true;
  catalogElement.hidden = false;
  const selected = selectedWidget?.widgetId;
  catalogElement
    .querySelector<HTMLButtonElement>(`[data-widget-id="${selected}"]`)
    ?.focus();
  confirmAddButton.disabled = true;
}

async function createSelectedWidget(): Promise<void> {
  if (!selectedSlot || !selectedWidget) return;
  confirmAddButton.disabled = true;
  clearError();
  try {
    await apiRequest(`${apiDashboardPath}/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        widget_id: selectedWidget.widgetId,
        variant_id: selectedWidget.variantId,
        position: selectedSlot,
        options: selectedWidget.options,
        links: selectedWidget.links,
      }),
    });
    addDialog.close();
  } catch (error) {
    showError(errorMessage(error));
    confirmAddButton.disabled = false;
  }
}

function openHealthDialog(instanceId: string): void {
  const health = instanceHealth.get(instanceId);
  const instance = resources.get(instanceId);
  if (!health || !instance) return;
  healthInstanceId = instanceId;
  healthTitleElement.textContent = `${descriptors.get(instance.widget_id)?.name ?? "Widget"} health`;
  renderHealthDialog(health);
  resetRestartConfirmation();
  healthDialog.showModal();
}

function renderHealthDialog(health: InstanceHealth): void {
  healthStatusElement.textContent = healthStatusLabel(health.status);
  healthStatusElement.dataset.status = health.status;
  setHealthTime(healthStartedElement, health.started_at);
  setHealthTime(healthUpdatedElement, health.last_update_at);
  healthRestartsElement.textContent = String(health.restart_count);
  if (health.last_error) {
    healthErrorElement.textContent = `${health.last_error.code}: ${health.last_error.message}`;
    healthErrorElement.title = new Date(health.last_error.at).toLocaleString();
  } else {
    healthErrorElement.textContent = "None";
    healthErrorElement.removeAttribute("title");
  }
}

function setHealthTime(element: HTMLElement, value: string | null): void {
  if (!value) {
    element.textContent = "Never";
    element.removeAttribute("title");
    return;
  }
  const date = new Date(value);
  element.textContent = relativeTime(date);
  element.title = date.toLocaleString();
}

function relativeTime(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

async function restartSelectedWidget(): Promise<void> {
  if (!healthInstanceId) return;
  if (restartWidgetButton.dataset.confirm !== "true") {
    restartWidgetButton.dataset.confirm = "true";
    restartWidgetButton.textContent = "Confirm restart";
    return;
  }
  const instanceId = healthInstanceId;
  restartWidgetButton.disabled = true;
  restartWidgetButton.textContent = "Restarting...";
  clearError();
  try {
    await connection.restartWidget(instanceId);
    announcementElement.textContent = "Widget backend restarted";
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    restartWidgetButton.disabled = false;
    resetRestartConfirmation();
  }
}

function resetRestartConfirmation(): void {
  delete restartWidgetButton.dataset.confirm;
  restartWidgetButton.textContent = "Restart backend";
}

function openRemoveDialog(instanceId: string): void {
  const instance = resources.get(instanceId);
  if (!instance) return;
  removeInstanceId = instanceId;
  removeTitleElement.textContent = `Remove ${descriptors.get(instance.widget_id)?.name ?? "widget"}?`;
  removeDialog.showModal();
}

async function removeSelectedWidget(): Promise<void> {
  if (!removeInstanceId) return;
  confirmRemoveButton.disabled = true;
  clearError();
  try {
    await apiRequest(
      `${apiDashboardPath}/instances/${encodeURIComponent(removeInstanceId)}`,
      { method: "DELETE" },
    );
    removeDialog.close();
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    confirmRemoveButton.disabled = false;
    removeInstanceId = null;
  }
}

function removeInstance(instanceId: string): void {
  if (moveState?.instanceId === instanceId) cancelKeyboardMove();
  resources.delete(instanceId);
  if (selectedInstanceId === instanceId) selectedInstanceId = null;
  instanceHealth.delete(instanceId);
  if (healthInstanceId === instanceId) healthDialog.close();
  linkBus.removeInstance(instanceId);
  pendingUpdates.delete(instanceId);
  frontends.get(instanceId)?.destroy();
  frontends.delete(instanceId);
  containers.get(instanceId)?.remove();
  containers.delete(instanceId);
  renderCanvas();
}

function renderCanvasDimensions(): void {
  const occupiedRows = Math.max(
    0,
    ...[...resources.values()].map(
      (instance) => instance.layout.row + instance.layout.height,
    ),
  );
  const naturalRows = Math.max(
    1,
    Math.ceil((dashboardLayout.columns * innerHeight) / innerWidth),
  );
  const rows = Math.min(
    24,
    Math.max(
      naturalRows,
      occupiedRows + (editing && occupiedRows < 24 ? 1 : 0),
    ),
  );
  widgetsElement.style.setProperty(
    "--dashboard-columns",
    String(dashboardLayout.columns),
  );
  widgetsElement.style.setProperty("--dashboard-rows", String(rows));
  columnCount.textContent = String(dashboardLayout.columns);
  decreaseColumns.disabled = dashboardLayout.columns <= 3;
  increaseColumns.disabled = dashboardLayout.columns >= 24;
}

async function updateDashboardColumns(columns: number): Promise<void> {
  if (columns < 3 || columns > 24) return;
  try {
    const response = await fetch(apiDashboardPath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ columns }),
    });
    if (!response.ok) throw await responseError(response);
    const dashboard = parseDashboard(await response.json());
    dashboardLayout = { columns: dashboard.columns };
    renderCanvas();
    announce(`${dashboard.columns} dashboard columns`);
  } catch (error) {
    showError(errorMessage(error));
  }
}

async function responseError(response: Response): Promise<Error> {
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(
    value?.error?.message ?? `${response.status} ${response.statusText}`,
  );
}

async function loadDashboardSwitcher(): Promise<void> {
  try {
    const response = await fetch("/api/v1/dashboards");
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`);
    const dashboards = parseDashboardList(await response.json()).dashboards;
    dashboardNames.clear();
    for (const dashboard of dashboards)
      dashboardNames.set(dashboard.id, dashboard.name);
    dashboardSwitcher.replaceChildren();
    const home = document.createElement("option");
    home.value = "/";
    home.textContent = "Dashboard home";
    dashboardSwitcher.append(home);
    for (const dashboard of dashboards) {
      const option = document.createElement("option");
      option.value = `/d/${encodeURIComponent(dashboard.id)}`;
      option.textContent = dashboard.name;
      option.selected = dashboard.id === dashboardId;
      dashboardSwitcher.append(option);
    }
    if (dashboards.length < 32) {
      const create = document.createElement("option");
      create.value = "new";
      create.textContent = "+ New dashboard";
      dashboardSwitcher.append(create);
    }
    const current = dashboards.find(
      (dashboard) => dashboard.id === dashboardId,
    );
    if (current) {
      document.title = editing
        ? `Edit ${current.name} - dashboardd`
        : focusedInstanceId
          ? `${current.name} Focus - dashboardd`
          : `${current.name} - dashboardd`;
    }
  } catch (error) {
    showError(`Could not load dashboards: ${errorMessage(error)}`);
  }
}

async function switchDashboard(): Promise<void> {
  const target = dashboardSwitcher.value;
  if (target === "new") {
    const name = window.prompt("Dashboard name");
    if (!name) {
      await loadDashboardSwitcher();
      return;
    }
    try {
      const response = await fetch("/api/v1/dashboards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          columns: Math.max(3, Math.min(24, Math.round(innerWidth / 160))),
        }),
      });
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      const dashboard = parseDashboard(await response.json());
      window.location.assign(`/d/${encodeURIComponent(dashboard.id)}/edit`);
    } catch (error) {
      showError(`Could not create dashboard: ${errorMessage(error)}`);
      await loadDashboardSwitcher();
    }
    return;
  }
  window.location.assign(target);
}

async function apiRequest(
  input: string,
  init: RequestInit,
): Promise<Instance | null> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      body?.error?.message ?? `${response.status} ${response.statusText}`,
    );
  }
  if (response.status === 204) return null;
  return parseInstance(await response.json());
}

function variantFor(
  instance: Instance,
  descriptor: WidgetDescriptor,
): WidgetVariant {
  const variant = descriptor.variants.find(
    (candidate) => candidate.id === instance.variant_id,
  );
  if (!variant)
    throw new Error(`unknown widget variant: ${instance.variant_id}`);
  return variant;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

syncRoute(false);
void loadDashboardSwitcher();

connection = connectDashboard(dashboardId, {
  onDashboardsChanged(dashboard, destroyedDashboardId) {
    if (destroyedDashboardId === dashboardId) window.location.assign("/");
    else {
      if (
        dashboard?.id === dashboardId &&
        dashboard.columns !== dashboardLayout.columns
      ) {
        dashboardLayout = { columns: dashboard.columns };
        renderCanvasDimensions();
        renderCanvas();
      }
      void loadDashboardSwitcher();
    }
  },
  onStatus: renderStatus,
  onTheme: applyTheme,
  onConfigurationError: showConfigurationError,
  onSnapshot: applySnapshot,
  onInstanceCreated: upsertInstance,
  onInstanceHealth: updateInstanceHealth,
  onInstanceUpdated: upsertInstance,
  onInstanceDestroyed: removeInstance,
  onLinkUpdated(link) {
    linkBus.update(link);
    renderCanvas();
  },
  onLinkDestroyed(targetInstanceId, targetPort) {
    linkBus.delete(targetInstanceId, targetPort);
    renderCanvas();
  },
  onWidgetUpdate(instanceId, payload) {
    const frontend = frontends.get(instanceId);
    if (frontend) frontend.update(payload);
    else pendingUpdates.set(instanceId, payload);
  },
  onWidgetStateUpdated(state) {
    stateBus.update(state);
  },
  onError: showError,
});

window.addEventListener("beforeunload", () => {
  for (const frontend of frontends.values()) frontend.destroy();
  connection.close();
});
