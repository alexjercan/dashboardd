import {
  parseDashboardEvent,
  parseDashboardLayout,
  parseInstanceHealth,
  parseInstanceHealthList,
  parseInstanceList,
  parseLinkList,
  parseTheme,
  parseWidgetList,
  type DashboardLayout,
  type ErrorResponse,
  type DashboardLink,
  type Instance,
  type InstanceHealth,
  type Theme,
  type WidgetDescriptor,
  type WidgetStateResource,
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
    health: InstanceHealth[],
    links: DashboardLink[],
  ): void;
  onInstanceCreated(instance: Instance): void;
  onInstanceUpdated(instance: Instance): void;
  onInstanceDestroyed(instanceId: string): void;
  onInstanceHealth(health: InstanceHealth): void;
  onLinkUpdated(link: DashboardLink): void;
  onLinkDestroyed(targetInstanceId: string, targetPort: string): void;
  onWidgetUpdate(instanceId: string, payload: unknown): void;
  onWidgetStateUpdated(state: WidgetStateResource): void;
  onError(message: string): void;
};

export type DashboardConnection = {
  sendWidget(instanceId: string, payload: unknown): Promise<void>;
  restartWidget(instanceId: string): Promise<InstanceHealth>;
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
        case "link_updated":
          events.onLinkUpdated(event.data.link);
          break;
        case "link_destroyed":
          events.onLinkDestroyed(
            event.data.target_instance_id,
            event.data.target_port,
          );
          break;
        case "instance_error":
          if (event.data.instance_id === null)
            events.onError(event.data.error.message);
          break;
        case "instance_health_updated":
          events.onInstanceHealth(event.data.health);
          break;
        case "widget_update":
          events.onWidgetUpdate(event.data.instance_id, event.data.payload);
          break;
        case "widget_state_updated":
          events.onWidgetStateUpdated(event.data);
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
    async restartWidget(instanceId) {
      return requestJson(
        `/api/v1/instances/${encodeURIComponent(instanceId)}/restart`,
        parseInstanceHealth,
        { method: "POST" },
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
  const [layout, theme, widgetList, instanceList, healthList, linkList] =
    await Promise.all([
      requestJson("/api/v1/layout", parseDashboardLayout),
      requestJson("/api/v1/theme", parseTheme),
      requestJson("/api/v1/widgets", parseWidgetList),
      requestJson("/api/v1/instances", parseInstanceList),
      requestJson("/api/v1/instance-health", parseInstanceHealthList),
      requestJson("/api/v1/links", parseLinkList),
    ]);
  events.onTheme(theme);
  events.onSnapshot(
    layout,
    widgetList.widgets,
    instanceList.instances,
    healthList.instances,
    linkList.links,
  );
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
