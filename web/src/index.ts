import "./styles.css";
import {
  connectDashboard,
  type ConnectionStatus,
  type DashboardConnection,
} from "./dashboard";
import type { Instance, WidgetDescriptor } from "./protocol";

type WidgetContext = {
  widgetId: string;
  instanceId: string;
  send(payload: unknown): void;
};

type WidgetFrontend = {
  update(payload: unknown): void;
  destroy(): void;
};

type WidgetFrontendModule = {
  mount(container: HTMLElement, context: WidgetContext): WidgetFrontend;
};

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <section class="min-h-screen bg-dashboard-background px-5 py-8 text-dashboard-foreground sm:px-8">
    <div class="mx-auto max-w-6xl">
      <header class="flex items-end justify-between gap-6 border-b border-dashboard-selected pb-5">
        <div>
          <p class="text-xs uppercase tracking-[0.24em] text-dashboard-accent">Scufris</p>
          <h1 class="mt-2 text-3xl font-semibold text-dashboard-bright">Dashboard</h1>
        </div>
        <p class="text-xs text-dashboard-dim">
          Server <span id="connection-status" class="text-dashboard-accent">Connecting...</span>
        </p>
      </header>
      <div id="dashboard-error" class="mt-5 hidden rounded border border-dashboard-error bg-dashboard-raised px-4 py-3 text-sm text-dashboard-error"></div>
      <main id="widgets" class="mt-6 grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3"></main>
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
  statusElement.className =
    status === "connected"
      ? "text-dashboard-success"
      : status === "error"
        ? "text-dashboard-error"
        : "text-dashboard-accent";
}

function showError(message: string): void {
  errorElement.textContent = message;
  errorElement.classList.remove("hidden");
}

function applySnapshot(
  widgets: WidgetDescriptor[],
  instances: Instance[],
): void {
  descriptors.clear();
  for (const descriptor of widgets) descriptors.set(descriptor.id, descriptor);

  const currentIds = new Set(instances.map((instance) => instance.id));
  for (const instanceId of resources.keys()) {
    if (!currentIds.has(instanceId)) removeInstance(instanceId);
  }
  for (const instance of instances) upsertInstance(instance);
}

function upsertInstance(instance: Instance): void {
  resources.set(instance.id, instance);
  if (!frontends.has(instance.id) && !mounting.has(instance.id)) {
    const promise = mountWidget(instance).finally(() =>
      mounting.delete(instance.id),
    );
    mounting.set(instance.id, promise);
  }
}

async function mountWidget(instance: Instance): Promise<void> {
  const descriptor = descriptors.get(instance.widget_id);
  if (!descriptor) {
    showError(`Widget descriptor not found: ${instance.widget_id}`);
    return;
  }

  const container = document.createElement("section");
  container.dataset.instanceId = instance.id;
  containers.set(instance.id, container);
  widgetsElement.append(container);

  try {
    const module = (await import(
      /* webpackIgnore: true */ descriptor.frontend_url
    )) as WidgetFrontendModule;
    const frontend = module.mount(container, {
      widgetId: instance.widget_id,
      instanceId: instance.id,
      send: (payload) => {
        void connection
          .sendWidget(instance.id, payload)
          .catch((error) =>
            showError(error instanceof Error ? error.message : String(error)),
          );
      },
    });

    if (!resources.has(instance.id)) {
      frontend.destroy();
      container.remove();
      containers.delete(instance.id);
      return;
    }

    frontends.set(instance.id, frontend);
    if (pendingUpdates.has(instance.id)) {
      frontend.update(pendingUpdates.get(instance.id));
      pendingUpdates.delete(instance.id);
    }
  } catch (error) {
    container.remove();
    containers.delete(instance.id);
    showError(
      `Could not load ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function removeInstance(instanceId: string): void {
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
