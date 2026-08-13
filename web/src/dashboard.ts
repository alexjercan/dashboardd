import { helloMessage, parseServerMessage } from "./protocol";

export type ConnectionStatus =
  "connecting" | "connected" | "disconnected" | "error";

export function connectDashboard(
  onStatus: (status: ConnectionStatus) => void,
): WebSocket {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

  onStatus("connecting");

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(helloMessage()));
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = parseServerMessage(JSON.parse(event.data));
      onStatus(message.kind === "ready" ? "connected" : "error");
    } catch {
      onStatus("error");
      socket.close();
    }
  });

  socket.addEventListener("error", () => onStatus("error"));
  socket.addEventListener("close", () => onStatus("disconnected"));

  return socket;
}
