import "./styles.css";
import { connectDashboard, type ConnectionStatus } from "./dashboard";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
    <section class="min-h-screen bg-dashboard-background p-8 text-dashboard-foreground">
        <div class="mx-auto max-w-4xl">
            <p class="text-sm uppercase tracking-widest text-dashboard-accent">Scufris</p>
            <h1 class="mt-2 text-4xl font-semibold text-dashboard-bright">Dashboard</h1>
            <p class="mt-4 text-dashboard-muted">The dashboard skeleton is ready.</p>
            <p class="mt-8 text-sm text-dashboard-dim">
                Server status:
                <span id="connection-status" class="text-dashboard-accent">Connecting...</span>
            </p>
        </div>
    </section>
`;

const statusElement =
  document.querySelector<HTMLElement>("#connection-status")!;

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

connectDashboard(renderStatus);
