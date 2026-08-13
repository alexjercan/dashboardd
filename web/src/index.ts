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
  type WidgetDescriptor,
} from "./protocol";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <section class="dashboard-shell">
    <div class="dashboard-content">
      <header class="dashboard-header">
        <h1>Scufris Dashboard</h1>
        <button id="edit-layout" class="button" type="button">Edit</button>
        <button id="finish-editing" class="button primary" type="button" hidden>Done</button>
      </header>
      <div id="dashboard-error" class="dashboard-error" role="alert" hidden></div>
      <main id="widgets" class="dashboard-grid" aria-label="Dashboard widgets"></main>
      <footer class="dashboard-footer">
        <span id="connection-indicator" class="status-dot" aria-hidden="true"></span>
        <span id="connection-status">Connecting...</span>
      </footer>
    </div>
  </section>
  <dialog id="add-widget" class="modal">
    <form method="dialog">
      <header><h2>Add widget</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <p id="add-position" class="modal-position"></p>
      <div id="widget-catalog" class="widget-catalog"></div>
      <section id="widget-selection" class="widget-selection" hidden>
        <h3 id="selected-widget-name"></h3>
        <dl><div><dt>Size</dt><dd>1x1</dd></div><div><dt>Options</dt><dd>No options</dd></div></dl>
      </section>
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
const editButton = required<HTMLButtonElement>("#edit-layout");
const doneButton = required<HTMLButtonElement>("#finish-editing");
const addDialog = required<HTMLDialogElement>("#add-widget");
const removeDialog = required<HTMLDialogElement>("#remove-widget");
const catalogElement = required<HTMLElement>("#widget-catalog");
const selectionElement = required<HTMLElement>("#widget-selection");
const selectedNameElement = required<HTMLElement>("#selected-widget-name");
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
let editing = false;
let dashboardLayout: DashboardLayout = { columns: 1 };
let selectedSlot: { column: number; row: number } | null = null;
let selectedWidgetId: string | null = null;
let removeInstanceId: string | null = null;
let connection: DashboardConnection;

editButton.addEventListener("click", () => setEditing(true));
doneButton.addEventListener("click", () => setEditing(false));
confirmAddButton.addEventListener("click", () => void createSelectedWidget());
confirmRemoveButton.addEventListener(
  "click",
  () => void removeSelectedWidget(),
);

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
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearError(): void {
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
  if (instances.length === 0) editing = true;
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
  const remove = document.createElement("button");
  remove.className = "remove-widget";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${descriptor.name}`);
  remove.addEventListener("click", () => openRemoveDialog(instance.id));
  frame.append(mount, remove);
  containers.set(instance.id, frame);
  renderCanvas();

  try {
    const module: unknown = await import(
      /* webpackIgnore: true */ descriptor.frontend_url
    );
    if (!isWidgetModule(module)) throw new Error("invalid widget module");
    const frontend = module.mount(mount, {
      widgetId: instance.widget_id,
      instanceId: instance.id,
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

function setEditing(value: boolean): void {
  editing = value;
  renderCanvas();
}

function renderCanvas(): void {
  widgetsElement.classList.toggle("editing", editing);
  editButton.hidden = editing;
  doneButton.hidden = !editing;
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
  const rowCount = Math.max(2, occupiedRows + 1);
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

function applyLayout(frame: HTMLElement, instance: Instance): void {
  frame.style.setProperty(
    "--widget-column",
    String(instance.layout.column + 1),
  );
  frame.style.setProperty("--widget-row", String(instance.layout.row + 1));
  frame.style.setProperty("--widget-width", String(instance.layout.width));
  frame.style.setProperty("--widget-height", String(instance.layout.height));
  frame.dataset.layout = `${instance.layout.width}x${instance.layout.height}`;
}

function openAddDialog(column: number, row: number): void {
  selectedSlot = { column, row };
  selectedWidgetId = null;
  addPositionElement.textContent = `Position: Column ${column + 1}, Row ${row + 1}`;
  selectionElement.hidden = true;
  confirmAddButton.disabled = true;
  catalogElement.replaceChildren();
  for (const descriptor of [...descriptors.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const choice = document.createElement("button");
    choice.className = "widget-choice";
    choice.type = "button";
    choice.innerHTML = `<strong>${descriptor.name}</strong><span>${widgetDescription(descriptor.id)}</span>`;
    choice.addEventListener("click", () => {
      selectedWidgetId = descriptor.id;
      for (const item of catalogElement.children)
        item.classList.remove("selected");
      choice.classList.add("selected");
      selectedNameElement.textContent = descriptor.name;
      selectionElement.hidden = false;
      confirmAddButton.disabled = false;
    });
    catalogElement.append(choice);
  }
  addDialog.showModal();
}

async function createSelectedWidget(): Promise<void> {
  if (!selectedSlot || !selectedWidgetId) return;
  confirmAddButton.disabled = true;
  clearError();
  try {
    await apiRequest("/api/v1/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        widget_id: selectedWidgetId,
        layout: { ...selectedSlot, width: 1, height: 1 },
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
  if (resources.size === 0) editing = true;
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

function widgetDescription(widgetId: string): string {
  if (widgetId === "cpu") return "Processor usage and temperatures";
  if (widgetId === "memory") return "RAM and swap usage";
  return "Dashboard widget";
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

connection = connectDashboard({
  onStatus: renderStatus,
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
