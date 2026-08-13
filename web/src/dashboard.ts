import {
  parseDashboardEvent,
  parseInstance,
  parseInstanceList,
  parseWidgetList,
  type ErrorResponse,
  type Instance,
  type WidgetDescriptor,
} from "./protocol";

const CPU_WIDGET_ID = "cpu";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export type DashboardEvents = {
  onStatus(status: ConnectionStatus): void;
  onSnapshot(widgets: WidgetDescriptor[], instances: Instance[]): void;
  onInstanceCreated(instance: Instance): void;
  onInstanceUpdated(instance: Instance): void;
  onInstanceDestroyed(instanceId: string): void;
  onWidgetUpdate(instanceId: string, payload: unknown): void;
  onError(message: string): void;
};

export type DashboardConnection = {
  sendWidget(instanceId: string, payload: unknown): Promise<void>;
  close(): void;
};

export function connectDashboard(events: DashboardEvents): DashboardConnection {
  const source = new EventSource("/api/v1/events");
  let closed = false;
  let reconciliation = Promise.resolve();

  events.onStatus("connecting");

  source.addEventListener("open", () => {
    console.info("Dashboard event stream connected");
    events.onStatus("connected");
    reconciliation = reconciliation
      .then(() => reconcile(events))
      .catch((error) => {
        events.onStatus("error");
        events.onError(errorMessage(error));
      });
  });

  source.addEventListener("message", (message) => {
    try {
      const event = parseDashboardEvent(JSON.parse(message.data));
      console.debug("Dashboard event received", { kind: event.kind });

      switch (event.kind) {
        case "instance_created":
          events.onInstanceCreated(event.data.instance);
          break;
        case "instance_updated":
          events.onInstanceUpdated(event.data.instance);
          break;
        case "instance_destroyed":
          events.onInstanceDestroyed(event.data.instance_id);
          break;
        case "instance_error":
          events.onError(event.data.error.message);
          break;
        case "widget_update":
          events.onWidgetUpdate(event.data.instance_id, event.data.payload);
          break;
      }
    } catch (error) {
      events.onError(errorMessage(error));
    }
  });

  source.addEventListener("error", () => {
    if (!closed) {
      console.info("Dashboard event stream disconnected; reconnecting");
      events.onStatus("disconnected");
    }
  });

  return {
    async sendWidget(instanceId, payload) {
      await request(
        `/api/v1/instances/${encodeURIComponent(instanceId)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    close() {
      closed = true;
      source.close();
    },
  };
}

async function reconcile(events: DashboardEvents): Promise<void> {
  console.debug("Reconciling dashboard state");
  const [widgetList, instanceList] = await Promise.all([
    requestJson("/api/v1/widgets", parseWidgetList),
    requestJson("/api/v1/instances", parseInstanceList),
  ]);
  let instances = instanceList.instances;
  const cpuAvailable = widgetList.widgets.some(
    (widget) => widget.id === CPU_WIDGET_ID,
  );
  const cpuExists = instances.some(
    (instance) => instance.widget_id === CPU_WIDGET_ID,
  );

  if (cpuAvailable && !cpuExists) {
    console.info("Creating default CPU widget instance");
    try {
      const cpu = await requestJson("/api/v1/instances", parseInstance, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ widget_id: CPU_WIDGET_ID }),
      });
      instances = [...instances, cpu];
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      instances = (await requestJson("/api/v1/instances", parseInstanceList))
        .instances;
    }
  }

  events.onSnapshot(widgetList.widgets, instances);
}

async function requestJson<T>(
  input: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  const response = await request(input, init);
  return parse(await response.json());
}

async function request(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;

  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as ErrorResponse;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the HTTP status when the server does not return the API error shape.
  }
  throw new ApiError(response.status, message);
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
