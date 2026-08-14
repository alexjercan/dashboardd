import "./styles.css";
import { isWidgetModule, type WidgetFrontend } from "@scufris/widget-sdk";
import {
  connectDashboard,
  type ConnectionStatus,
  type DashboardConnection,
} from "./dashboard";
import {
  parseInstance,
  type DashboardLayout,
  type Instance,
  type Theme,
  type WidgetDescriptor,
  type WidgetOption,
  type WidgetVariant,
} from "./protocol";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <section class="dashboard-shell">
    <div class="dashboard-content">
      <h1 id="zen-heading" class="sr-only">Scufris Dashboard</h1>
      <header id="editor-header" class="dashboard-header" hidden>
        <h1 id="editor-heading" tabindex="-1">Edit dashboard</h1>
        <a id="finish-editing" class="button primary" href="/">Done</a>
      </header>
      <div id="dashboard-error" class="dashboard-error" role="alert" hidden></div>
      <div id="dashboard-announcement" class="sr-only" aria-live="polite"></div>
      <section id="empty-dashboard" class="empty-dashboard" hidden>
        <span>No widgets</span>
        <a class="empty-edit" href="/edit">Edit dashboard</a>
      </section>
      <main id="widgets" class="dashboard-grid" aria-label="Dashboard widgets"></main>
      <footer class="dashboard-footer">
        <span class="connection-state"><span id="connection-indicator" class="status-dot" aria-hidden="true"></span><span id="connection-status">Connecting...</span></span>
        <a id="edit-layout" class="zen-edit" href="/edit">Edit</a>
      </footer>
    </div>
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
        </section>
      </div>
      <footer><button class="button" value="cancel">Cancel</button><button id="confirm-add" class="button primary" type="button" disabled>Add widget</button></footer>
    </form>
  </dialog>
  <dialog id="remove-widget" class="modal confirm-modal">
    <form method="dialog">
      <header><h2 id="remove-title">Remove widget?</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <p>This stops its backend and clears its current data.</p>
      <footer><button class="button" value="cancel">Cancel</button><button id="confirm-remove" class="button danger" type="button">Remove</button></footer>
    </form>
  </dialog>
`;

const statusElement = required<HTMLElement>("#connection-status");
const indicatorElement = required<HTMLElement>("#connection-indicator");
const widgetsElement = required<HTMLElement>("#widgets");
const errorElement = required<HTMLElement>("#dashboard-error");
const announcementElement = required<HTMLElement>("#dashboard-announcement");
const editorHeader = required<HTMLElement>("#editor-header");
const editorHeading = required<HTMLElement>("#editor-heading");
const emptyDashboard = required<HTMLElement>("#empty-dashboard");
const editButton = required<HTMLAnchorElement>("#edit-layout");
const doneButton = required<HTMLAnchorElement>("#finish-editing");
const addDialog = required<HTMLDialogElement>("#add-widget");
const removeDialog = required<HTMLDialogElement>("#remove-widget");
const catalogElement = required<HTMLElement>("#widget-catalog");
const selectionElement = required<HTMLElement>("#widget-selection");
const selectedNameElement = required<HTMLElement>("#selected-widget-name");
const selectedDescriptionElement = required<HTMLElement>(
  "#selected-widget-description",
);
const variantsElement = required<HTMLElement>("#widget-variants");
const optionsElement = required<HTMLElement>("#widget-options");
const backToWidgetsButton = required<HTMLButtonElement>("#back-to-widgets");
const addPositionElement = required<HTMLElement>("#add-position");
const confirmAddButton = required<HTMLButtonElement>("#confirm-add");
const confirmRemoveButton = required<HTMLButtonElement>("#confirm-remove");
const removeTitleElement = required<HTMLElement>("#remove-title");
for (const dialog of [addDialog, removeDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
const descriptors = new Map<string, WidgetDescriptor>();
const resources = new Map<string, Instance>();
const frontends = new Map<string, WidgetFrontend>();
const containers = new Map<string, HTMLElement>();
const mounting = new Map<string, Promise<void>>();
const pendingUpdates = new Map<string, unknown>();
let editing = window.location.pathname === "/edit";
let dashboardLayout: DashboardLayout = { columns: 1 };
let selectedSlot: { column: number; row: number } | null = null;
let selectedWidget: {
  widgetId: string;
  variantId: string;
  options: Record<string, boolean | number | string>;
} | null = null;
let removeInstanceId: string | null = null;
let drag: DragState | null = null;
let connection: DashboardConnection;

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
confirmAddButton.addEventListener("click", () => void createSelectedWidget());
backToWidgetsButton.addEventListener("click", showWidgetCatalog);
confirmRemoveButton.addEventListener(
  "click",
  () => void removeSelectedWidget(),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drag) cancelDrag();
});

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
      `--scufris-color-${name.replaceAll("_", "-")}`,
      value as string,
    );
  }
  document.documentElement.style.setProperty(
    "--scufris-font-sans",
    `"${theme.fonts.sans}", ui-sans-serif, system-ui, sans-serif`,
  );
  document.documentElement.style.setProperty(
    "--scufris-font-mono",
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
): void {
  dashboardLayout = layout;
  widgetsElement.style.setProperty(
    "--dashboard-columns",
    String(layout.columns),
  );
  descriptors.clear();
  for (const descriptor of widgets) descriptors.set(descriptor.id, descriptor);
  const currentIds = new Set(instances.map((instance) => instance.id));
  for (const instanceId of resources.keys()) {
    if (!currentIds.has(instanceId)) removeInstance(instanceId);
  }
  for (const instance of instances) upsertInstance(instance);
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
  const dragHandle = document.createElement("button");
  dragHandle.className = "drag-handle";
  dragHandle.type = "button";
  dragHandle.innerHTML = '<span aria-hidden="true">:::</span>';
  dragHandle.setAttribute("aria-label", `Move ${descriptor.name}`);
  dragHandle.addEventListener("pointerdown", startDrag);
  dragHandle.addEventListener("pointermove", updateDrag);
  dragHandle.addEventListener("pointerup", finishDrag);
  dragHandle.addEventListener("pointercancel", cancelDrag);
  const remove = document.createElement("button");
  remove.className = "remove-widget";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${descriptor.name}`);
  remove.addEventListener("click", () => openRemoveDialog(instance.id));
  frame.addEventListener("keydown", moveWithKeyboard);
  frame.append(mount, dragHandle, remove);
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
      send: (payload) => connection.sendWidget(instance.id, payload),
    });
    if (!resources.has(instance.id)) {
      frontend.destroy();
      frame.remove();
      containers.delete(instance.id);
      return;
    }
    frontends.set(instance.id, frontend);
    if (pendingUpdates.has(instance.id)) {
      frontend.update(pendingUpdates.get(instance.id));
      pendingUpdates.delete(instance.id);
    }
  } catch (error) {
    frame.remove();
    containers.delete(instance.id);
    showError(`Could not load ${descriptor.name}: ${errorMessage(error)}`);
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

function syncRoute(focus: boolean): void {
  const nextEditing = window.location.pathname === "/edit";
  if (!nextEditing) cancelDrag();
  editing = nextEditing;
  document.title = editing ? "Edit dashboard - Scufris" : "Scufris Dashboard";
  renderCanvas();
  if (focus) (editing ? editorHeading : editButton).focus();
}

function renderCanvas(): void {
  widgetsElement.classList.toggle("editing", editing);
  document.body.classList.toggle("editing", editing);
  editorHeader.hidden = !editing;
  editButton.hidden = editing;
  emptyDashboard.hidden = editing || resources.size > 0;
  for (const frame of containers.values()) frame.tabIndex = editing ? 0 : -1;
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
  const rowCount = Math.max(6, occupiedRows + 1);
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
      widgetsElement.append(slot);
    }
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

function moveWithKeyboard(event: KeyboardEvent): void {
  if (!editing || !event.key.startsWith("Arrow")) return;
  const frame = event.currentTarget as HTMLElement;
  const instance = frame.dataset.instanceId
    ? resources.get(frame.dataset.instanceId)
    : undefined;
  if (!instance) return;
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const [columnOffset, rowOffset] = offsets[event.key];
  const column = instance.layout.column + columnOffset;
  const row = instance.layout.row + rowOffset;
  event.preventDefault();
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
      `/api/v1/instances/${encodeURIComponent(instanceId)}`,
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
    const response = await fetch("/api/v1/layout/swap", {
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
  confirmAddButton.disabled = false;
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

function optionControl(
  option: WidgetOption,
): HTMLInputElement | HTMLSelectElement {
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
  const input = document.createElement("input");
  if (option.type === "boolean") {
    input.type = "checkbox";
    input.checked = option.default === true;
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
  control: HTMLInputElement | HTMLSelectElement,
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
    await apiRequest("/api/v1/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        widget_id: selectedWidget.widgetId,
        variant_id: selectedWidget.variantId,
        position: selectedSlot,
        options: selectedWidget.options,
      }),
    });
    addDialog.close();
  } catch (error) {
    showError(errorMessage(error));
    confirmAddButton.disabled = false;
  }
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
      `/api/v1/instances/${encodeURIComponent(removeInstanceId)}`,
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
  resources.delete(instanceId);
  pendingUpdates.delete(instanceId);
  frontends.get(instanceId)?.destroy();
  frontends.delete(instanceId);
  containers.get(instanceId)?.remove();
  containers.delete(instanceId);
  renderCanvas();
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

connection = connectDashboard({
  onStatus: renderStatus,
  onTheme: applyTheme,
  onConfigurationError: showConfigurationError,
  onSnapshot: applySnapshot,
  onInstanceCreated: upsertInstance,
  onInstanceUpdated: upsertInstance,
  onInstanceDestroyed: removeInstance,
  onWidgetUpdate(instanceId, payload) {
    const frontend = frontends.get(instanceId);
    if (frontend) frontend.update(payload);
    else pendingUpdates.set(instanceId, payload);
  },
  onError: showError,
});

window.addEventListener("beforeunload", () => {
  for (const frontend of frontends.values()) frontend.destroy();
  connection.close();
});
