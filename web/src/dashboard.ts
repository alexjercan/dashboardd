import {
  parseDashboardEvent,
  parseDashboardLayout,
  parseInstanceList,
  parseTheme,
  parseWidgetList,
  type DashboardLayout,
  type ErrorResponse,
  type Instance,
  type Theme,
  type WidgetDescriptor,
} from "./protocol";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export type DashboardEvents = {
  onStatus(status: ConnectionStatus): void;
  onTheme(theme: Theme): void;
  onConfigurationError(message: string): void;
  onSnapshot(
    layout: DashboardLayout,
    widgets: WidgetDescriptor[],
    instances: Instance[],
  ): void;
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
        case "theme_updated":
          events.onTheme(event.data.theme);
          break;
        case "configuration_error":
          events.onConfigurationError(event.data.error.message);
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
  const [layout, theme, widgetList, instanceList] = await Promise.all([
    requestJson("/api/v1/layout", parseDashboardLayout),
    requestJson("/api/v1/theme", parseTheme),
    requestJson("/api/v1/widgets", parseWidgetList),
    requestJson("/api/v1/instances", parseInstanceList),
  ]);
  events.onTheme(theme);
  events.onSnapshot(layout, widgetList.widgets, instanceList.instances);
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
