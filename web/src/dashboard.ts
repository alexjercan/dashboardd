import {
  createInstanceMessage,
  helloMessage,
  listWidgetsMessage,
  parseServerMessage,
  widgetMessage,
  type DashboardToServer,
  type WidgetDescriptor,
} from "./protocol";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export type DashboardEvents = {
  onStatus(status: ConnectionStatus): void;
  onWidgets(widgets: WidgetDescriptor[]): void;
  onInstanceCreated(instanceId: string, widgetId: string): void;
  onWidgetMessage(instanceId: string, payload: unknown): void;
  onError(message: string): void;
};

export type DashboardConnection = {
  createInstance(widgetId: string): void;
  sendWidget(instanceId: string, payload: unknown): void;
  close(): void;
};

export function connectDashboard(events: DashboardEvents): DashboardConnection {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
  let failed = false;
  let requestSequence = 0;

  events.onStatus("connecting");
  socket.addEventListener("open", () => send(socket, helloMessage()));

  socket.addEventListener("message", (event) => {
    try {
      const message = parseServerMessage(JSON.parse(event.data));

      switch (message.kind) {
        case "ready":
          events.onStatus("connected");
          send(socket, listWidgetsMessage(nextRequestId("widgets")));
          break;
        case "widgets":
          events.onWidgets(message.data.widgets);
          break;
        case "instance_created":
          events.onInstanceCreated(
            message.data.instance_id,
            message.data.widget_id,
          );
          break;
        case "widget_message":
          events.onWidgetMessage(
            message.data.instance_id,
            message.data.payload,
          );
          break;
        case "error":
          events.onError(message.data.error.message);
          break;
      }
    } catch {
      failed = true;
      events.onStatus("error");
      socket.close();
    }
  });

  socket.addEventListener("error", () => {
    failed = true;
    events.onStatus("error");
  });
  socket.addEventListener("close", () => {
    if (!failed) events.onStatus("disconnected");
  });

  function nextRequestId(prefix: string): string {
    requestSequence += 1;
    return `${prefix}-${requestSequence}`;
  }

  return {
    createInstance(widgetId) {
      send(socket, createInstanceMessage(nextRequestId("instance"), widgetId));
    },
    sendWidget(instanceId, payload) {
      send(socket, widgetMessage(instanceId, payload));
    },
    close() {
      socket.close();
    },
  };
}

function send(socket: WebSocket, message: DashboardToServer): void {
  socket.send(JSON.stringify(message));
}
