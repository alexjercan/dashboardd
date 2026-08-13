import "./styles.css";
import { isWidgetModule, type WidgetFrontend } from "@scufris/widget-sdk";
import {
  connectDashboard,
  type ConnectionStatus,
  type DashboardConnection,
} from "./dashboard";
import type { Instance, WidgetDescriptor } from "./protocol";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <section class="dashboard-shell">
    <div class="dashboard-content">
      <header class="dashboard-header">
        <div>
          <p class="dashboard-brand">Scufris</p>
          <h1>Dashboard</h1>
        </div>
        <p class="dashboard-server">
          Server <span id="connection-status">Connecting...</span>
        </p>
      </header>
      <div id="dashboard-error" class="dashboard-error" role="alert" hidden></div>
      <main id="widgets" class="dashboard-grid"></main>
    </div>
  </section>
`;

const statusElement =
  document.querySelector<HTMLElement>("#connection-status")!;
const widgetsElement = document.querySelector<HTMLElement>("#widgets")!;
const errorElement = document.querySelector<HTMLElement>("#dashboard-error")!;
const descriptors = new Map<string, WidgetDescriptor>();
const resources = new Map<string, Instance>();
const frontends = new Map<string, WidgetFrontend>();
const containers = new Map<string, HTMLElement>();
const mounting = new Map<string, Promise<void>>();
const pendingUpdates = new Map<string, unknown>();
let connection: DashboardConnection;

function renderStatus(status: ConnectionStatus): void {
  const labels: Record<ConnectionStatus, string> = {
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Reconnecting...",
    error: "Connection error",
  };

  statusElement.textContent = labels[status];
  statusElement.dataset.status = status;
}

function showError(message: string): void {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function applySnapshot(
  widgets: WidgetDescriptor[],
  instances: Instance[],
): void {
  descriptors.clear();
  for (const descriptor of widgets) descriptors.set(descriptor.id, descriptor);
  console.info("Dashboard state reconciled", {
    widgets: widgets.length,
    instances: instances.length,
  });

  const currentIds = new Set(instances.map((instance) => instance.id));
  for (const instanceId of resources.keys()) {
    if (!currentIds.has(instanceId)) removeInstance(instanceId);
  }
  for (const instance of instances) upsertInstance(instance);
}

function upsertInstance(instance: Instance): void {
  resources.set(instance.id, instance);
  if (!descriptors.has(instance.widget_id)) {
    console.debug("Instance arrived before widget descriptors", {
      instanceId: instance.id,
      widgetId: instance.widget_id,
    });
    return;
  }
  if (!frontends.has(instance.id) && !mounting.has(instance.id)) {
    const promise = mountWidget(instance).finally(() =>
      mounting.delete(instance.id),
    );
    mounting.set(instance.id, promise);
  }
}

async function mountWidget(instance: Instance): Promise<void> {
  const descriptor = descriptors.get(instance.widget_id);
  if (!descriptor) return;

  const frame = document.createElement("section");
  frame.className = "dashboard-widget";
  frame.dataset.instanceId = instance.id;
  frame.dataset.widgetId = instance.widget_id;
  const mount = document.createElement("div");
  mount.className = "dashboard-widget-mount";
  frame.append(mount);
  containers.set(instance.id, frame);
  widgetsElement.append(frame);

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
    console.info("Widget frontend mounted", {
      instanceId: instance.id,
      widgetId: instance.widget_id,
    });
    if (pendingUpdates.has(instance.id)) {
      frontend.update(pendingUpdates.get(instance.id));
      pendingUpdates.delete(instance.id);
    }
  } catch (error) {
    frame.remove();
    containers.delete(instance.id);
    showError(
      `Could not load ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function removeInstance(instanceId: string): void {
  console.info("Widget instance removed", { instanceId });
  resources.delete(instanceId);
  pendingUpdates.delete(instanceId);
  frontends.get(instanceId)?.destroy();
  frontends.delete(instanceId);
  containers.get(instanceId)?.remove();
  containers.delete(instanceId);
}

connection = connectDashboard({
  onStatus: renderStatus,
  onSnapshot: applySnapshot,
  onInstanceCreated: upsertInstance,
  onInstanceUpdated(instance) {
    resources.set(instance.id, instance);
  },
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
