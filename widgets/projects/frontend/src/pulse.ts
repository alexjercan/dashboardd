import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./pulse.css";
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
const MAX_VISIBLE_PROJECTS = 5;

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header><div><h2>Project Pulse</h2><span class="summary">Waiting...</span></div><button class="manage" type="button">Manage</button></header>
      <div class="rows"><div class="empty">Waiting for projects...</div></div>
    </article>
    <dialog class="manager" aria-labelledby="pulse-manager-title">
      <section>
        <header><h2 id="pulse-manager-title">Manage projects</h2><button class="done" type="button">Done</button></header>
        <input class="search" type="search" aria-label="Search projects" placeholder="Search projects">
        <div class="limit" aria-live="polite"></div>
        <div class="project-list" aria-label="Projects"></div>
      </section>
    </dialog>`;
  shadow.host.setAttribute(
    "aria-label",
    `Project pulse for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let projects: ProjectSummary[] = [];
  let pins = parsePins(context.sharedState.get());
  let selectedId: string | null = null;
  let query = "";

  const publish = (project: ProjectSelection | null): void => {
    context.outputs.publish("selected_project", project);
  };
  const select = (project: ProjectSummary): void => {
    selectedId = selectedId === project.project_id ? null : project.project_id;
    publish(selectedId ? project : null);
    renderCurrent();
  };
  const manager = required<HTMLDialogElement>(shadow, ".manager");
  const openManager = (): void => {
    renderManager();
    if (!manager.open) manager.showModal();
    required<HTMLInputElement>(shadow, ".manager .search").focus();
  };
  const closeManager = (): void => {
    if (manager.open) manager.close();
  };
  const updatePin = (pin: ProjectPin): void => {
    void togglePin(context.sharedState, pin).catch(() => {});
  };
  const reorder = (projectId: string, direction: -1 | 1): void => {
    void movePin(context.sharedState, projectId, direction).catch(() => {});
  };
  const chooseWorktree = (projectId: string, worktreeId: string): void => {
    void context
      .send({
        command: "select_worktree",
        view_id: viewId,
        project_id: projectId,
        worktree_id: worktreeId,
      })
      .catch(() => {});
  };
  const renderCurrent = (): void => {
    renderPulse(shadow, projects, pins, selectedId, select);
    if (manager.open) renderManager();
  };
  const renderManager = (): void => {
    renderProjectManager(
      shadow,
      projects,
      pins,
      query,
      updatePin,
      reorder,
      chooseWorktree,
    );
  };

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
      renderManager();
    },
  );
  manager.addEventListener("click", (event) => {
    if (event.target === manager) closeManager();
  });

  const unsubscribeState = context.sharedState.subscribe((value) => {
    pins = parsePins(value);
    renderCurrent();
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
      renderCurrent();
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

function renderPulse(
  shadow: ShadowRoot,
  projects: ProjectSummary[],
  pins: ProjectPin[],
  selectedId: string | null,
  select: (project: ProjectSummary) => void,
): void {
  const visible = rankedProjects(projects, pins).slice(0, MAX_VISIBLE_PROJECTS);
  required<HTMLElement>(shadow, ".summary").textContent =
    projects.length === 1 ? "1 project" : `${projects.length} projects`;
  const rows = required<HTMLElement>(shadow, ".rows");
  rows.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No projects";
    rows.append(empty);
    return;
  }
  for (const project of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "project-row";
    row.classList.toggle("selected", project.project_id === selectedId);
    const name = document.createElement("strong");
    name.textContent = project.project;
    const context = document.createElement("span");
    context.className = "project-context";
    context.textContent =
      project.branch ?? (project.git ? "Detached" : "Directory");
    const attention = document.createElement("span");
    attention.className = "attention";
    attention.dataset.state = attentionState(project);
    attention.textContent = attentionLabel(project);
    const activity = document.createElement("small");
    activity.textContent = relativeTime(project.latest_commit_unix);
    row.append(name, context, attention, activity);
    row.addEventListener("click", () => select(project));
    rows.append(row);
  }
}

function rankedProjects(
  projects: ProjectSummary[],
  pins: ProjectPin[],
): ProjectSummary[] {
  const pinOrder = new Map(pins.map((pin, index) => [pin.project_id, index]));
  return [...projects].sort((left, right) => {
    const leftPin = pinOrder.get(left.project_id);
    const rightPin = pinOrder.get(right.project_id);
    if (leftPin !== undefined || rightPin !== undefined)
      return (
        (leftPin ?? Number.MAX_SAFE_INTEGER) -
        (rightPin ?? Number.MAX_SAFE_INTEGER)
      );
    const attention = attentionScore(right) - attentionScore(left);
    if (attention !== 0) return attention;
    return (right.latest_commit_unix ?? 0) - (left.latest_commit_unix ?? 0);
  });
}

function attentionScore(project: ProjectSummary): number {
  return (
    project.in_progress_tasks * 1000 +
    project.open_tasks * 100 +
    (project.clean === false ? 50 + project.change_count : 0)
  );
}

function attentionState(project: ProjectSummary): string {
  if (project.in_progress_tasks > 0) return "active";
  if (project.clean === false) return "dirty";
  return "quiet";
}

function attentionLabel(project: ProjectSummary): string {
  if (project.in_progress_tasks > 0)
    return `${project.in_progress_tasks} active ${project.in_progress_tasks === 1 ? "task" : "tasks"}`;
  if (project.clean === false)
    return `${project.change_count} ${project.change_count === 1 ? "change" : "changes"}`;
  if (project.open_tasks > 0)
    return `${project.open_tasks} open ${project.open_tasks === 1 ? "task" : "tasks"}`;
  return project.clean === true ? "Clean" : "Directory";
}

function renderProjectManager(
  shadow: ShadowRoot,
  projects: ProjectSummary[],
  pins: ProjectPin[],
  query: string,
  toggle: (pin: ProjectPin) => void,
  reorder: (projectId: string, direction: -1 | 1) => void,
  chooseWorktree: (projectId: string, worktreeId: string) => void,
): void {
  required<HTMLElement>(shadow, ".limit").textContent =
    `${pins.length} of ${MAX_PINS} pinned - pinned projects appear first`;
  const normalized = query.trim();
  const visible = projects
    .map((project) => ({
      project,
      score: fuzzyScore(project.project, normalized),
    }))
    .filter(
      (value): value is { project: ProjectSummary; score: number } =>
        value.score !== null,
    )
    .sort((left, right) => {
      const leftPin = pins.findIndex(
        (pin) => pin.project_id === left.project.project_id,
      );
      const rightPin = pins.findIndex(
        (pin) => pin.project_id === right.project.project_id,
      );
      if (leftPin >= 0 || rightPin >= 0)
        return (leftPin < 0 ? 999 : leftPin) - (rightPin < 0 ? 999 : rightPin);
      return (
        right.score - left.score ||
        left.project.project.localeCompare(right.project.project)
      );
    });
  const list = required<HTMLElement>(shadow, ".project-list");
  list.replaceChildren();
  for (const pin of pins.filter(
    (candidate) =>
      !projects.some((project) => project.project_id === candidate.project_id),
  )) {
    const row = document.createElement("div");
    row.className = "manage-row unavailable";
    const name = document.createElement("strong");
    name.textContent = `${pin.project} - unavailable`;
    row.append(
      name,
      createPinButton(pin, true, false, () => toggle(pin)),
    );
    list.append(row);
  }
  for (const { project } of visible) {
    const pinned = pins.findIndex(
      (pin) => pin.project_id === project.project_id,
    );
    const row = document.createElement("div");
    row.className = "manage-row";
    const name = document.createElement("strong");
    name.textContent = project.project;
    const controls = document.createElement("span");
    controls.className = "row-controls";
    if ((project.worktrees?.length ?? 0) > 1) {
      const worktree = document.createElement("select");
      worktree.setAttribute("aria-label", `Worktree for ${project.project}`);
      for (const descriptor of project.worktrees ?? []) {
        const option = document.createElement("option");
        option.value = descriptor.worktree_id;
        option.textContent = descriptor.worktree;
        option.selected = descriptor.worktree_id === project.worktree_id;
        worktree.append(option);
      }
      worktree.addEventListener("change", () =>
        chooseWorktree(project.project_id, worktree.value),
      );
      controls.append(worktree);
    }
    if (pinned >= 0) {
      controls.append(
        moveButton("Earlier", pinned === 0, () =>
          reorder(project.project_id, -1),
        ),
        moveButton("Later", pinned === pins.length - 1, () =>
          reorder(project.project_id, 1),
        ),
      );
    }
    controls.append(
      createPinButton(
        project,
        pinned >= 0,
        pinned < 0 && pins.length >= MAX_PINS,
        () => toggle(project),
      ),
    );
    row.append(name, controls);
    list.append(row);
  }
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "manager-empty";
    empty.textContent = "No matching projects";
    list.append(empty);
  }
}

function moveButton(
  label: string,
  disabled: boolean,
  activate: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "move";
  button.textContent = label === "Earlier" ? "Up" : "Down";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing Project Pulse element: ${selector}`);
  return element;
}
