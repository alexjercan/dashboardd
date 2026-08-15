import {
  parseDashboard,
  parseDashboardEvent,
  parseDashboardList,
  parseTheme,
  type Dashboard,
  type HealthStatus,
  type Theme,
} from "./protocol";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <main class="dashboard-home">
    <header class="home-header">
      <div><p class="home-kicker">Scufris</p><h1>Dashboards</h1></div>
      <button id="create-dashboard" class="button primary" type="button">Create dashboard</button>
    </header>
    <div id="home-error" class="dashboard-error" role="alert" hidden></div>
    <section id="dashboard-gallery" class="dashboard-gallery" aria-label="Dashboards"></section>
    <section id="dashboard-empty" class="dashboard-home-empty" hidden>
      <h2>No dashboards yet</h2>
      <p>Create a dashboard for system monitoring, projects, or anything else you want to keep visible.</p>
      <button class="button primary create-dashboard" type="button">Create dashboard</button>
    </section>
  </main>
`;

const gallery = required<HTMLElement>("#dashboard-gallery");
const empty = required<HTMLElement>("#dashboard-empty");
const errorElement = required<HTMLElement>("#home-error");
const createButtons = [
  required<HTMLButtonElement>("#create-dashboard"),
  required<HTMLButtonElement>(".create-dashboard"),
];
let dashboards: Dashboard[] = [];
let refreshTimer: number | null = null;

for (const button of createButtons)
  button.addEventListener("click", () => void createDashboard());

void Promise.all([loadTheme(), loadDashboards()]);
const events = new EventSource("/api/v1/events");
events.addEventListener("message", (message) => {
  try {
    const event = parseDashboardEvent(JSON.parse(message.data));
    if (event.kind === "theme_updated") {
      applyTheme(event.data.theme);
      return;
    }
    if (event.kind === "instance_health_updated") {
      const dashboard = dashboards.find(
        (candidate) => candidate.id === event.data.dashboard_id,
      );
      if (!dashboard) return;
      const index = dashboard.health.findIndex(
        (health) => health.instance_id === event.data.health.instance_id,
      );
      if (index >= 0) dashboard.health[index] = event.data.health;
      else dashboard.health.push(event.data.health);
      updateHealthSummary(dashboard);
      return;
    }
    if (
      event.kind === "dashboard_created" ||
      event.kind === "dashboard_updated" ||
      event.kind === "dashboard_destroyed" ||
      event.kind === "instance_created" ||
      event.kind === "instance_updated" ||
      event.kind === "instance_destroyed"
    )
      scheduleRefresh();
  } catch {
    // Reconciliation recovers from events added by newer servers.
  }
});
window.addEventListener("beforeunload", () => events.close());

async function loadDashboards(): Promise<void> {
  try {
    const response = await fetch("/api/v1/dashboards");
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`);
    dashboards = parseDashboardList(await response.json()).dashboards;
    render();
    clearError();
  } catch (error) {
    showError(`Could not load dashboards: ${errorMessage(error)}`);
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void loadDashboards();
  }, 50);
}

function render(): void {
  gallery.replaceChildren();
  for (const button of createButtons) {
    button.disabled = dashboards.length >= 32;
    button.title = button.disabled ? "Dashboard limit reached" : "";
  }
  empty.hidden = dashboards.length !== 0;
  gallery.hidden = dashboards.length === 0;
  for (const dashboard of dashboards) gallery.append(dashboardCard(dashboard));
  if (dashboards.length < 32) gallery.append(createTile());
}

function dashboardCard(dashboard: Dashboard): HTMLElement {
  const card = document.createElement("article");
  card.className = "dashboard-card";
  card.dataset.dashboardId = dashboard.id;

  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = dashboard.name;
  const summary = document.createElement("span");
  summary.className = "dashboard-card-summary";
  summary.textContent = `${dashboard.instances.length} ${dashboard.instances.length === 1 ? "widget" : "widgets"}`;
  header.append(title, summary);

  const preview = document.createElement("div");
  preview.className = "dashboard-preview";
  preview.setAttribute("aria-label", `${dashboard.name} layout preview`);
  const rows = Math.max(
    3,
    ...dashboard.instances.map(
      (instance) => instance.layout.row + instance.layout.height,
    ),
  );
  preview.style.setProperty("--preview-columns", String(dashboard.columns));
  preview.style.setProperty("--preview-rows", String(rows));
  for (const instance of dashboard.instances) {
    const block = document.createElement("span");
    block.className = "dashboard-preview-widget";
    block.style.gridColumn = `${instance.layout.column + 1} / span ${instance.layout.width}`;
    block.style.gridRow = `${instance.layout.row + 1} / span ${instance.layout.height}`;
    block.textContent = instance.widget_id;
    preview.append(block);
  }
  if (dashboard.instances.length === 0) {
    const blank = document.createElement("span");
    blank.className = "dashboard-preview-empty";
    blank.textContent = "Empty dashboard";
    preview.append(blank);
  }

  const health = document.createElement("p");
  health.className = "dashboard-card-health";
  const status = aggregateHealth(dashboard);
  health.dataset.status = status;
  health.innerHTML = '<span class="status-dot" aria-hidden="true"></span>';
  health.append(document.createTextNode(healthLabel(status)));

  const actions = document.createElement("footer");
  const open = link(
    "Open",
    `/d/${encodeURIComponent(dashboard.id)}`,
    "primary",
  );
  const edit = link("Edit", `/d/${encodeURIComponent(dashboard.id)}/edit`);
  const menu = document.createElement("details");
  menu.className = "dashboard-card-menu";
  const menuLabel = document.createElement("summary");
  menuLabel.textContent = "Manage";
  const menuActions = document.createElement("div");
  menuActions.append(
    action("Rename", () => void renameDashboard(dashboard)),
    action("Duplicate", () => void duplicateDashboard(dashboard)),
    action("Delete", () => void deleteDashboard(dashboard), "danger-text"),
  );
  menu.append(menuLabel, menuActions);
  actions.append(open, edit, menu);
  card.append(header, preview, health, actions);
  return card;
}

function updateHealthSummary(dashboard: Dashboard): void {
  const card = [
    ...gallery.querySelectorAll<HTMLElement>(".dashboard-card"),
  ].find((candidate) => candidate.dataset.dashboardId === dashboard.id);
  const health = card?.querySelector<HTMLElement>(".dashboard-card-health");
  if (!health) return;
  const status = aggregateHealth(dashboard);
  health.dataset.status = status;
  const dot = health.querySelector(".status-dot");
  health.replaceChildren();
  if (dot) health.append(dot);
  health.append(document.createTextNode(healthLabel(status)));
}

function createTile(): HTMLElement {
  const button = document.createElement("button");
  button.className = "dashboard-create-tile";
  button.type = "button";
  button.innerHTML = "<strong>+</strong><span>Create dashboard</span>";
  button.addEventListener("click", () => void createDashboard());
  return button;
}

async function createDashboard(): Promise<void> {
  const name = window.prompt("Dashboard name");
  if (name === null) return;
  const dashboard = await dashboardRequest("/api/v1/dashboards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      columns: suggestedColumns(window.innerWidth),
    }),
  });
  if (dashboard)
    window.location.assign(`/d/${encodeURIComponent(dashboard.id)}/edit`);
}

async function renameDashboard(dashboard: Dashboard): Promise<void> {
  const name = window.prompt("Dashboard name", dashboard.name);
  if (name === null) return;
  await dashboardRequest(
    `/api/v1/dashboards/${encodeURIComponent(dashboard.id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  await loadDashboards();
}

async function duplicateDashboard(dashboard: Dashboard): Promise<void> {
  const copy = await dashboardRequest(
    `/api/v1/dashboards/${encodeURIComponent(dashboard.id)}/duplicate`,
    { method: "POST" },
  );
  if (copy) window.location.assign(`/d/${encodeURIComponent(copy.id)}/edit`);
}

async function deleteDashboard(dashboard: Dashboard): Promise<void> {
  if (!window.confirm(`Delete ${dashboard.name} and all of its widgets?`))
    return;
  try {
    const response = await fetch(
      `/api/v1/dashboards/${encodeURIComponent(dashboard.id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw await responseError(response);
    await loadDashboards();
  } catch (error) {
    showError(`Could not delete dashboard: ${errorMessage(error)}`);
  }
}

async function dashboardRequest(
  url: string,
  init: RequestInit,
): Promise<Dashboard | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw await responseError(response);
    clearError();
    return parseDashboard(await response.json());
  } catch (error) {
    showError(errorMessage(error));
    return null;
  }
}

function suggestedColumns(width: number): number {
  return Math.max(3, Math.min(24, Math.round(width / 160)));
}

function aggregateHealth(dashboard: Dashboard): HealthStatus | "empty" {
  if (dashboard.health.length === 0) return "empty";
  const order: HealthStatus[] = [
    "failed",
    "degraded",
    "stale",
    "starting",
    "healthy",
  ];
  return order.find((status) =>
    dashboard.health.some((health) => health.status === status),
  )!;
}

function healthLabel(status: HealthStatus | "empty"): string {
  const labels: Record<HealthStatus | "empty", string> = {
    empty: "No widget backends",
    starting: "Widgets starting",
    healthy: "All widgets healthy",
    stale: "Some widgets stale",
    degraded: "Some widgets degraded",
    failed: "Some widgets failed",
  };
  return labels[status];
}

function link(label: string, href: string, className = ""): HTMLAnchorElement {
  const element = document.createElement("a");
  element.className = `button ${className}`.trim();
  element.href = href;
  element.textContent = label;
  return element;
}

function action(
  label: string,
  handler: () => void,
  className = "",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `home-card-action ${className}`.trim();
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function loadTheme(): Promise<void> {
  try {
    const response = await fetch("/api/v1/theme");
    if (response.ok) applyTheme(parseTheme(await response.json()));
  } catch {
    // The dashboard error reports the primary resource failure.
  }
}

function applyTheme(theme: Theme): void {
  for (const [name, value] of Object.entries(theme)) {
    if (name === "fonts") continue;
    document.documentElement.style.setProperty(
      `--scufris-color-${name.replaceAll("_", "-")}`,
      value as string,
    );
  }
  document.documentElement.style.setProperty(
    "--scufris-font-sans",
    `"${theme.fonts.sans}", ui-sans-serif, system-ui, sans-serif`,
  );
  document.documentElement.style.setProperty(
    "--scufris-font-mono",
    `"${theme.fonts.mono}", ui-monospace, monospace`,
  );
}

async function responseError(response: Response): Promise<Error> {
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(
    value?.error?.message ?? `${response.status} ${response.statusText}`,
  );
}

function showError(message: string): void {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearError(): void {
  errorElement.hidden = true;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
