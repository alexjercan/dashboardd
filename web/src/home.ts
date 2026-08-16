import { CommandPalette } from "./command-palette";
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
      <div><p class="home-kicker">dashboardd</p><h1>Dashboards</h1></div>
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
  <dialog id="home-keyboard-help" class="modal keyboard-help-modal">
    <form method="dialog">
      <header><h2>Dashboard home keys</h2><button class="icon-button" value="cancel" aria-label="Close">x</button></header>
      <dl class="keyboard-help-list">
        <div><dt>h j k l</dt><dd>Select a dashboard card</dd></div>
        <div><dt>g g / G</dt><dd>Select the first or last dashboard</dd></div>
        <div><dt>Enter / e</dt><dd>Open the selected dashboard in Zen / Editor</dd></div>
        <div><dt>a</dt><dd>Create a dashboard</dd></div>
        <div><dt>:</dt><dd>Open the command palette</dd></div>
        <div><dt>Esc</dt><dd>Clear the dashboard selection</dd></div>
      </dl>
      <footer><button class="button primary" value="cancel">Close</button></footer>
    </form>
  </dialog>
`;

const gallery = required<HTMLElement>("#dashboard-gallery");
const empty = required<HTMLElement>("#dashboard-empty");
const errorElement = required<HTMLElement>("#home-error");
const helpDialog = required<HTMLDialogElement>("#home-keyboard-help");
const createButtons = [
  required<HTMLButtonElement>("#create-dashboard"),
  required<HTMLButtonElement>(".create-dashboard"),
];
let dashboards: Dashboard[] = [];
let refreshTimer: number | null = null;
let selectedDashboardId: string | null = null;
let pendingFirstKey = false;
let pendingFirstKeyTimer: number | null = null;
const commandPalette = new CommandPalette(
  homeCommandCandidates,
  executeHomeCommand,
);

for (const button of createButtons)
  button.addEventListener("click", () => void createDashboard());
document.addEventListener("keydown", handleHomeKeydown, true);
gallery.addEventListener("pointerdown", (event) => {
  const card = (event.target as Element).closest<HTMLElement>(
    ".dashboard-card",
  );
  if (card?.dataset.dashboardId) selectDashboard(card.dataset.dashboardId);
});

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

function handleHomeKeydown(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    window.matchMedia("(max-width: 580px)").matches ||
    [...document.querySelectorAll("dialog")].some((dialog) => dialog.open) ||
    event.composedPath().some((target) => {
      if (!(target instanceof HTMLElement)) return false;
      const dialog = target.closest<HTMLDialogElement>("dialog");
      if (dialog && !dialog.open) return false;
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      );
    })
  )
    return;
  if (pendingFirstKey) {
    const first = event.key === "g";
    clearHomeFirstKey();
    if (first) {
      event.preventDefault();
      selectBoundaryDashboard(false);
      return;
    }
  }
  if (event.key === "g") {
    event.preventDefault();
    pendingFirstKey = true;
    pendingFirstKeyTimer = window.setTimeout(clearHomeFirstKey, 700);
    return;
  }
  if (["h", "j", "k", "l"].includes(event.key)) {
    event.preventDefault();
    selectDashboardSpatially(event.key as "h" | "j" | "k" | "l");
  } else if (event.key === "G") {
    event.preventDefault();
    selectBoundaryDashboard(true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    openSelectedDashboard(false);
  } else if (event.key === "e") {
    event.preventDefault();
    openSelectedDashboard(true);
  } else if (event.key === "a") {
    event.preventDefault();
    void createDashboard();
  } else if (event.key === ":") {
    event.preventDefault();
    commandPalette.open();
  } else if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
    event.preventDefault();
    helpDialog.showModal();
  } else if (event.key === "Escape") {
    selectedDashboardId = null;
    renderHomeSelection();
  }
}

function clearHomeFirstKey(): void {
  pendingFirstKey = false;
  if (pendingFirstKeyTimer !== null) {
    window.clearTimeout(pendingFirstKeyTimer);
    pendingFirstKeyTimer = null;
  }
}

function selectDashboard(dashboardId: string): void {
  if (!dashboards.some((dashboard) => dashboard.id === dashboardId)) return;
  selectedDashboardId = dashboardId;
  renderHomeSelection();
}

function selectBoundaryDashboard(last: boolean): void {
  const dashboard = dashboards[last ? dashboards.length - 1 : 0];
  if (dashboard) selectDashboard(dashboard.id);
}

function selectDashboardSpatially(direction: "h" | "j" | "k" | "l"): void {
  const cards = [...gallery.querySelectorAll<HTMLElement>(".dashboard-card")];
  if (!selectedDashboardId) return selectBoundaryDashboard(false);
  const current = cards.find(
    (card) => card.dataset.dashboardId === selectedDashboardId,
  );
  if (!current) return selectBoundaryDashboard(false);
  const currentBox = current.getBoundingClientRect();
  const horizontal = direction === "h" || direction === "l";
  const sign = direction === "h" || direction === "k" ? -1 : 1;
  const currentPrimary = horizontal
    ? currentBox.left + currentBox.width / 2
    : currentBox.top + currentBox.height / 2;
  const currentSecondary = horizontal
    ? currentBox.top + currentBox.height / 2
    : currentBox.left + currentBox.width / 2;
  const candidate = cards
    .filter((card) => card !== current)
    .map((card) => {
      const box = card.getBoundingClientRect();
      const primary = horizontal
        ? box.left + box.width / 2
        : box.top + box.height / 2;
      const secondary = horizontal
        ? box.top + box.height / 2
        : box.left + box.width / 2;
      return {
        card,
        primary: (primary - currentPrimary) * sign,
        secondary: Math.abs(secondary - currentSecondary),
      };
    })
    .filter((item) => item.primary > 0)
    .sort(
      (left, right) =>
        left.primary - right.primary || left.secondary - right.secondary,
    )[0];
  if (candidate?.card.dataset.dashboardId)
    selectDashboard(candidate.card.dataset.dashboardId);
}

function renderHomeSelection(): void {
  for (const card of gallery.querySelectorAll<HTMLElement>(".dashboard-card"))
    card.classList.toggle(
      "keyboard-selected",
      card.dataset.dashboardId === selectedDashboardId,
    );
}

function openSelectedDashboard(editing: boolean): void {
  if (!selectedDashboardId) return selectBoundaryDashboard(false);
  window.location.assign(
    `/d/${encodeURIComponent(selectedDashboardId)}${editing ? "/edit" : ""}`,
  );
}

function homeCommandCandidates(): string[] {
  return [
    "new",
    "help",
    ...dashboards.flatMap((dashboard) => [
      `dashboard ${dashboard.name}`,
      `edit ${dashboard.name}`,
    ]),
  ];
}

function executeHomeCommand(value: string): string | null {
  if (value === "new") {
    void createDashboard();
    return null;
  }
  if (value === "help") {
    window.setTimeout(() => helpDialog.showModal());
    return null;
  }
  const [command, ...nameParts] = value.split(/\s+/);
  const name = nameParts.join(" ");
  const dashboard = dashboards.find((candidate) => candidate.name === name);
  if (!dashboard || (command !== "dashboard" && command !== "edit"))
    return `Unknown command: ${value}`;
  window.location.assign(
    `/d/${encodeURIComponent(dashboard.id)}${command === "edit" ? "/edit" : ""}`,
  );
  return null;
}

async function loadDashboards(): Promise<void> {
  try {
    const response = await fetch("/api/v1/dashboards");
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`);
    dashboards = parseDashboardList(await response.json()).dashboards;
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
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
  if (
    selectedDashboardId &&
    !dashboards.some((dashboard) => dashboard.id === selectedDashboardId)
  )
    selectedDashboardId = null;
  renderHomeSelection();
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
      `--dashboardd-color-${name.replaceAll("_", "-")}`,
      value as string,
    );
  }
  document.documentElement.style.setProperty(
    "--dashboardd-font-sans",
    `"${theme.fonts.sans}", ui-sans-serif, system-ui, sans-serif`,
  );
  document.documentElement.style.setProperty(
    "--dashboardd-font-mono",
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
