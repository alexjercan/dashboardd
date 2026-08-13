import {
  cpuUsage,
  createInstanceMessage,
  helloMessage,
  listWidgetsMessage,
  parseServerMessage,
  type DashboardToServer,
} from "./protocol";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export function connectDashboard(
  onStatus: (status: ConnectionStatus) => void,
  onCpuUsage: (usage: number) => void,
): WebSocket {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
  let failed = false;

  onStatus("connecting");

  socket.addEventListener("open", () => send(socket, helloMessage()));

  socket.addEventListener("message", (event) => {
    try {
      const message = parseServerMessage(JSON.parse(event.data));

      switch (message.kind) {
        case "ready":
          onStatus("connected");
          send(socket, listWidgetsMessage("widgets-1"));
          break;
        case "widgets":
          if (message.data.widgets.some((widget) => widget.id === "cpu")) {
            send(socket, createInstanceMessage("cpu-1", "cpu"));
          }
          break;
        case "widget_message": {
          const usage = cpuUsage(message.data.payload);
          if (usage !== null) onCpuUsage(usage);
          break;
        }
        case "error":
          failed = true;
          onStatus("error");
          break;
        case "instance_created":
          break;
      }
    } catch {
      failed = true;
      onStatus("error");
      socket.close();
    }
  });

  socket.addEventListener("error", () => {
    failed = true;
    onStatus("error");
  });
  socket.addEventListener("close", () => {
    if (!failed) onStatus("disconnected");
  });

  return socket;
}

function send(socket: WebSocket, message: DashboardToServer): void {
  socket.send(JSON.stringify(message));
}
