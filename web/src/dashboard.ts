import {
  parseInstanceHealth,
  parseRuntimeEvent,
  type InstanceHealth,
  type RuntimeInstance,
  type Theme,
  type WidgetStateResource,
} from "./protocol";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export type RuntimeEvents = {
  onStatus(status: ConnectionStatus): void;
  onReconnect(): Promise<void>;
  onTheme(theme: Theme): void;
  onConfigurationError(message: string): void;
  onInstanceCreated(instance: RuntimeInstance): void;
  onInstanceDestroyed(instanceId: string): void;
  onInstanceHealth(health: InstanceHealth): void;
  onWidgetUpdate(instanceId: string, payload: unknown): void;
  onWidgetStateUpdated(state: WidgetStateResource): void;
  onError(instanceId: string | null, message: string): void;
};

export type RuntimeConnection = {
  sendWidget(instanceId: string, payload: unknown): Promise<void>;
  restartWidget(instanceId: string): Promise<InstanceHealth>;
  close(): void;
};

export function connectRuntime(events: RuntimeEvents): RuntimeConnection {
  const source = new EventSource("/api/v1/events");
  let closed = false;
  let reconciliation = Promise.resolve();

  events.onStatus("connecting");
  source.addEventListener("open", () => {
    console.info("Runtime event stream connected");
    events.onStatus("connected");
    reconciliation = reconciliation
      .then(() => events.onReconnect())
      .catch((error) => {
        events.onStatus("error");
        events.onError(null, errorMessage(error));
      });
  });
  source.addEventListener("message", (message) => {
    try {
      const event = parseRuntimeEvent(JSON.parse(message.data));
      switch (event.kind) {
        case "instance_created":
          events.onInstanceCreated(event.data.instance);
          break;
        case "instance_destroyed":
          events.onInstanceDestroyed(event.data.instance_id);
          break;
        case "instance_error":
          events.onError(event.data.instance_id, event.data.error.message);
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
      events.onError(null, errorMessage(error));
    }
  });
  source.addEventListener("error", () => {
    if (!closed) {
      console.info("Runtime event stream disconnected; reconnecting");
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
      const response = await request(
        `/api/v1/instances/${encodeURIComponent(instanceId)}/restart`,
        { method: "POST" },
      );
      return parseInstanceHealth(await response.json());
    },
    close() {
      closed = true;
      source.close();
    },
  };
}

async function request(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new Error(
    value?.error?.message ?? `${response.status} ${response.statusText}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
