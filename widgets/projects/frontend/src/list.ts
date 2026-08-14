import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./list.css";
import {
  createViewId,
  parseSummary,
  type ProjectSelection,
  type ProjectSummary,
} from "./shared";

type Snapshot = { view_id: string; projects: ProjectSummary[] };

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header><h2>Projects</h2><span class="summary">Waiting...</span></header>
      <div class="rows"><div class="empty">Waiting for projects...</div></div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Project list for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let projects: ProjectSummary[] = [];
  let selectedId: string | null = null;

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
    render(shadow, projects, selectedId, select, chooseWorktree);
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

  void context.send({ command: "open_view", view_id: viewId }).catch(() => {});
  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot || snapshot.view_id !== viewId) return;
      projects = snapshot.projects;
      const selected = projects.find(
        (project) => project.project_id === selectedId,
      );
      if (selectedId && !selected) {
        selectedId = null;
        publish(null);
      } else if (selected) {
        publish(selected);
      }
      render(shadow, projects, selectedId, select, chooseWorktree);
    },
    destroy(): void {
      publish(null);
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      shadow.replaceChildren();
    },
  };
}

function render(
  shadow: ShadowRoot,
  projects: ProjectSummary[],
  selectedId: string | null,
  select: (project: ProjectSummary) => void,
  chooseWorktree: (projectId: string, worktreeId: string) => void,
): void {
  required<HTMLElement>(shadow, ".summary").textContent =
    `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
  const rows = required<HTMLElement>(shadow, ".rows");
  rows.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No projects";
    rows.append(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement("div");
    row.className = "project-row";
    row.classList.toggle("selected", project.project_id === selectedId);
    row.dataset.projectId = project.project_id;

    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "project-choice";
    const name = document.createElement("strong");
    name.textContent = project.project;
    name.title = project.project;
    const branch = document.createElement("span");
    branch.className = "branch";
    branch.textContent =
      project.branch ?? (project.git ? "Detached" : "Directory");
    const state = document.createElement("span");
    state.className = "git-state";
    state.dataset.state =
      project.clean === true
        ? "clean"
        : project.clean === false
          ? "dirty"
          : "plain";
    state.textContent =
      project.clean === true
        ? "Clean"
        : project.clean === false
          ? `${project.change_count} ${project.change_count === 1 ? "change" : "changes"}`
          : project.tatr
            ? "Tatr"
            : "Directory";
    choice.append(name, branch, state);
    choice.addEventListener("click", () => select(project));
    row.append(choice);

    if ((project.worktrees?.length ?? 0) > 1) {
      const worktree = document.createElement("select");
      worktree.className = "worktree";
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
      row.append(worktree);
    }
    rows.append(row);
  }
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("view_id" in value) ||
    typeof value.view_id !== "string" ||
    !("projects" in value) ||
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

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing Projects element: ${selector}`);
  return element;
}
