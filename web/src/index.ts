import "./styles.css";
import {
  connectDashboard,
  type ConnectionStatus,
  type DashboardConnection,
} from "./dashboard";
import type { WidgetDescriptor } from "./protocol";

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
const instances = new Map<string, WidgetFrontend>();
const pendingUpdates = new Map<string, unknown>();
let connection: DashboardConnection;

function renderStatus(status: ConnectionStatus): void {
  const labels: Record<ConnectionStatus, string> = {
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
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

async function mountWidget(
  instanceId: string,
  widgetId: string,
): Promise<void> {
  const descriptor = descriptors.get(widgetId);
  if (!descriptor) {
    showError(`Widget descriptor not found: ${widgetId}`);
    return;
  }

  const container = document.createElement("section");
  container.dataset.instanceId = instanceId;
  widgetsElement.append(container);

  try {
    const module = (await import(
      /* webpackIgnore: true */ descriptor.frontend_url
    )) as WidgetFrontendModule;
    const frontend = module.mount(container, {
      widgetId,
      instanceId,
      send: (payload) => connection.sendWidget(instanceId, payload),
    });
    instances.set(instanceId, frontend);

    if (pendingUpdates.has(instanceId)) {
      frontend.update(pendingUpdates.get(instanceId));
      pendingUpdates.delete(instanceId);
    }
  } catch (error) {
    container.remove();
    showError(
      `Could not load ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

connection = connectDashboard({
  onStatus: renderStatus,
  onWidgets(widgets) {
    for (const descriptor of widgets) {
      descriptors.set(descriptor.id, descriptor);
      connection.createInstance(descriptor.id);
    }
  },
  onInstanceCreated(instanceId, widgetId) {
    void mountWidget(instanceId, widgetId);
  },
  onWidgetMessage(instanceId, payload) {
    const frontend = instances.get(instanceId);
    if (frontend) frontend.update(payload);
    else pendingUpdates.set(instanceId, payload);
  },
  onError: showError,
});

window.addEventListener("beforeunload", () => {
  for (const frontend of instances.values()) frontend.destroy();
  connection.close();
});
