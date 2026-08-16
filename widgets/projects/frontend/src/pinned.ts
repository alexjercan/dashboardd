import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./pinned.css";
import {
  createViewId,
  fuzzyScore,
  parseSummary,
  relativeTime,
  type ProjectSelection,
  type ProjectSummary,
} from "./shared";
import {
  createPinButton,
  MAX_PINS,
  movePin,
  parsePins,
  togglePin,
  type ProjectPin,
} from "./pins";

type Snapshot = { view_id: string; projects: ProjectSummary[] };

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header><h2>Pinned Projects</h2><button class="manage" type="button">Manage</button></header>
      <div class="cards"></div>
    </article>
    <dialog class="manager" aria-labelledby="pin-manager-title">
      <section>
        <header><h2 id="pin-manager-title">Manage pinned projects</h2><button class="done" type="button">Done</button></header>
        <input class="search" type="search" aria-label="Search projects to pin" placeholder="Search projects">
        <div class="limit" aria-live="polite"></div>
        <div class="pinned-list" aria-label="Pinned projects"></div>
        <div class="project-list" aria-label="Available projects"></div>
      </section>
    </dialog>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Pinned projects for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let projects: ProjectSummary[] = [];
  let pins = parsePins(context.sharedState.get());
  let selectedId: string | null = null;
  let query = "";

  const publish = (project: ProjectSelection | null): void => {
    context.links.publish("selected_project", project);
  };
  const select = (project: ProjectSummary): void => {
    if (selectedId === project.project_id) {
      selectedId = null;
      publish(null);
    } else {
      selectedId = project.project_id;
      publish(project);
    }
    renderCards(shadow, projects, pins, selectedId, select, openManager);
  };
  const updatePin = (pin: ProjectPin): void => {
    void togglePin(context.sharedState, pin).catch(() => {});
  };
  const reorder = (projectId: string, direction: -1 | 1): void => {
    void movePin(context.sharedState, projectId, direction).catch(() => {});
  };
  const manager = required<HTMLDialogElement>(shadow, ".manager");
  function openManager(): void {
    renderManager(shadow, projects, pins, query, updatePin, reorder);
    if (!manager.open) manager.showModal();
    required<HTMLInputElement>(shadow, ".manager .search").focus();
  }
  function closeManager(): void {
    if (manager.open) manager.close();
  }

  required<HTMLButtonElement>(shadow, ".manage").addEventListener(
    "click",
    openManager,
  );
  required<HTMLButtonElement>(shadow, ".done").addEventListener(
    "click",
    closeManager,
  );
  required<HTMLInputElement>(shadow, ".manager .search").addEventListener(
    "input",
    (event) => {
      query = (event.currentTarget as HTMLInputElement).value;
      renderManager(shadow, projects, pins, query, updatePin, reorder);
    },
  );
  manager.addEventListener("click", (event) => {
    if (event.target === manager) closeManager();
  });

  const unsubscribeState = context.sharedState.subscribe((value) => {
    pins = parsePins(value);
    if (selectedId && !pins.some((pin) => pin.project_id === selectedId)) {
      selectedId = null;
      publish(null);
    }
    renderCards(shadow, projects, pins, selectedId, select, openManager);
    if (manager.open)
      renderManager(shadow, projects, pins, query, updatePin, reorder);
  });
  void context.send({ command: "open_view", view_id: viewId }).catch(() => {});

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot || snapshot.view_id !== viewId) return;
      projects = snapshot.projects;
      const selected = projects.find(
        (project) => project.project_id === selectedId,
      );
      if (selected) publish(selected);
      else if (selectedId) {
        selectedId = null;
        publish(null);
      }
      renderCards(shadow, projects, pins, selectedId, select, openManager);
      if (manager.open)
        renderManager(shadow, projects, pins, query, updatePin, reorder);
    },
    destroy(): void {
      unsubscribeState();
      publish(null);
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      closeManager();
      shadow.replaceChildren();
    },
  };
}

function renderCards(
  shadow: ShadowRoot,
  projects: ProjectSummary[],
  pins: ProjectPin[],
  selectedId: string | null,
  select: (project: ProjectSummary) => void,
  manage: () => void,
): void {
  const cards = required<HTMLElement>(shadow, ".cards");
  cards.replaceChildren();
  for (let index = 0; index < MAX_PINS; index += 1) {
    const pin = pins[index];
    if (!pin) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "project-card empty-card";
      empty.innerHTML = "<strong>+</strong><span>Pin project</span>";
      empty.addEventListener("click", manage);
      cards.append(empty);
      continue;
    }
    const project = projects.find(
      (candidate) => candidate.project_id === pin.project_id,
    );
    if (!project) {
      const unavailable = document.createElement("button");
      unavailable.type = "button";
      unavailable.className = "project-card unavailable";
      unavailable.innerHTML = `<strong>${escapeHtml(pin.project)}</strong><span>Unavailable</span>`;
      unavailable.addEventListener("click", manage);
      cards.append(unavailable);
      continue;
    }
    const card = document.createElement("button");
    card.type = "button";
    card.className = "project-card";
    card.classList.toggle("selected", project.project_id === selectedId);
    const active = project.open_tasks + project.in_progress_tasks;
    card.innerHTML = `<strong>${escapeHtml(project.project)}</strong><span>${active} active</span><small>${relativeTime(project.latest_commit_unix)}</small>`;
    card.addEventListener("click", () => select(project));
    cards.append(card);
  }
}

function renderManager(
  shadow: ShadowRoot,
  projects: ProjectSummary[],
  pins: ProjectPin[],
  query: string,
  toggle: (pin: ProjectPin) => void,
  reorder: (projectId: string, direction: -1 | 1) => void,
): void {
  required<HTMLElement>(shadow, ".limit").textContent =
    pins.length >= MAX_PINS
      ? `${pins.length} of ${MAX_PINS} pinned - limit reached`
      : `${pins.length} of ${MAX_PINS} pinned`;
  const pinnedList = required<HTMLElement>(shadow, ".pinned-list");
  pinnedList.replaceChildren();
  for (const [index, pin] of pins.entries()) {
    const row = document.createElement("div");
    row.className = "manage-row pinned-row";
    const name = document.createElement("strong");
    name.textContent = pin.project;
    const controls = document.createElement("span");
    controls.className = "row-controls";
    controls.append(
      moveButton("Earlier", index === 0, () => reorder(pin.project_id, -1)),
      moveButton("Later", index === pins.length - 1, () =>
        reorder(pin.project_id, 1),
      ),
      createPinButton(pin, true, false, () => toggle(pin)),
    );
    row.append(name, controls);
    pinnedList.append(row);
  }

  const normalized = query.trim();
  const available = projects
    .filter(
      (project) => !pins.some((pin) => pin.project_id === project.project_id),
    )
    .map((project) => ({
      project,
      score: fuzzyScore(project.project, normalized),
    }))
    .filter(
      (value): value is { project: ProjectSummary; score: number } =>
        value.score !== null,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.project.project.localeCompare(right.project.project, undefined, {
          sensitivity: "base",
        }),
    );
  const projectList = required<HTMLElement>(shadow, ".project-list");
  projectList.replaceChildren();
  if (available.length === 0) {
    const empty = document.createElement("p");
    empty.className = "manager-empty";
    empty.textContent = "No matching projects";
    projectList.append(empty);
    return;
  }
  for (const { project } of available) {
    const row = document.createElement("div");
    row.className = "manage-row";
    const name = document.createElement("strong");
    name.textContent = project.project;
    row.append(
      name,
      createPinButton(project, false, pins.length >= MAX_PINS, () =>
        toggle(project),
      ),
    );
    projectList.append(row);
  }
}

function moveButton(
  label: string,
  disabled: boolean,
  activate: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "move-button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", activate);
  return button;
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (
    !isRecord(value) ||
    typeof value.view_id !== "string" ||
    !Array.isArray(value.projects)
  )
    return null;
  const projects = value.projects.map(parseSummary);
  return projects.every(
    (project): project is ProjectSummary => project !== null,
  )
    ? { view_id: value.view_id, projects }
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing Pinned Projects element: ${selector}`);
  return element;
}
