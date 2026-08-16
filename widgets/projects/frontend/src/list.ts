import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./list.css";
import {
  createViewId,
  fuzzyScore,
  parseSummary,
  type ProjectSelection,
  type ProjectSummary,
} from "./shared";
import {
  createPinButton,
  MAX_PINS,
  parsePins,
  togglePin,
  type ProjectPin,
} from "./pins";

type Snapshot = { view_id: string; projects: ProjectSummary[] };
type ProjectSort = "name" | "recent";
type ListControls = {
  query: string;
  sort: ProjectSort;
  dirty: boolean;
  activeTasks: boolean;
};
type RankedProject = { project: ProjectSummary; score: number };

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header><h2>Projects</h2><span class="summary">Waiting...</span></header>
      <div class="controls">
        <input class="search" type="search" aria-label="Search projects" placeholder="Search projects">
        <select class="sort" aria-label="Sort projects"><option value="name">Name</option><option value="recent">Recent</option></select>
        <details class="filters"><summary>Filters</summary><div class="filter-menu">
          <label><input type="checkbox" value="dirty"> Dirty</label>
          <label><input type="checkbox" value="active-tasks"> Active tasks</label>
        </div></details>
      </div>
      <div class="hidden-selection" hidden><span></span><button type="button">Clear</button></div>
      <div class="rows"><div class="empty">Waiting for projects...</div></div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Project list for ${context.instanceId}`,
  );
  const viewId = createViewId();
  const controls: ListControls = {
    query: "",
    sort: "name",
    dirty: false,
    activeTasks: false,
  };
  let projects: ProjectSummary[] = [];
  let pins: ProjectPin[] = parsePins(context.sharedState.get());
  let selectedId: string | null = null;

  const publish = (project: ProjectSelection | null): void => {
    context.links.publish("selected_project", project);
  };
  const renderCurrent = (): void => {
    render(
      shadow,
      projects,
      selectedId,
      controls,
      pins,
      select,
      chooseWorktree,
      pinProject,
    );
  };
  const select = (project: ProjectSummary): void => {
    if (selectedId === project.project_id) {
      selectedId = null;
      publish(null);
    } else {
      selectedId = project.project_id;
      publish(project);
    }
    renderCurrent();
  };
  const pinProject = (project: ProjectSummary): void => {
    void togglePin(context.sharedState, project).catch(() => {});
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

  required<HTMLInputElement>(shadow, ".search").addEventListener(
    "input",
    (event) => {
      controls.query = (event.currentTarget as HTMLInputElement).value;
      renderCurrent();
    },
  );
  required<HTMLSelectElement>(shadow, ".sort").addEventListener(
    "change",
    (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      controls.sort = value === "recent" ? "recent" : "name";
      renderCurrent();
    },
  );
  shadow
    .querySelectorAll<HTMLInputElement>('.filter-menu input[type="checkbox"]')
    .forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.value === "dirty") controls.dirty = checkbox.checked;
        else controls.activeTasks = checkbox.checked;
        renderCurrent();
      });
    });
  required<HTMLButtonElement>(
    shadow,
    ".hidden-selection button",
  ).addEventListener("click", () => {
    selectedId = null;
    publish(null);
    renderCurrent();
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
      if (selectedId && !selected) {
        selectedId = null;
        publish(null);
      } else if (selected) {
        publish(selected);
      }
      renderCurrent();
    },
    destroy(): void {
      unsubscribeState();
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
  controls: ListControls,
  pins: ProjectPin[],
  select: (project: ProjectSummary) => void,
  chooseWorktree: (projectId: string, worktreeId: string) => void,
  pinProject: (project: ProjectSummary) => void,
): void {
  const visible = visibleProjects(projects, controls);
  const filtering =
    controls.query.trim() !== "" || controls.dirty || controls.activeTasks;
  required<HTMLElement>(shadow, ".summary").textContent = filtering
    ? `${visible.length} of ${projects.length} projects`
    : `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
  const activeFilterCount =
    Number(controls.dirty) + Number(controls.activeTasks);
  required<HTMLElement>(shadow, ".filters summary").textContent =
    activeFilterCount === 0 ? "Filters" : `Filters (${activeFilterCount})`;

  const hiddenSelection = required<HTMLElement>(shadow, ".hidden-selection");
  const selected = selectedId
    ? projects.find((project) => project.project_id === selectedId)
    : undefined;
  const selectedIsHidden =
    selected !== undefined &&
    !visible.some((project) => project.project_id === selected.project_id);
  hiddenSelection.hidden = !selectedIsHidden;
  required<HTMLElement>(hiddenSelection, "span").textContent = selected
    ? `Selected: ${selected.project}`
    : "";

  const rows = required<HTMLElement>(shadow, ".rows");
  rows.replaceChildren();
  if (projects.length === 0) {
    rows.append(emptyState("No projects"));
    return;
  }
  if (visible.length === 0) {
    rows.append(emptyState("No matching projects"));
    return;
  }
  for (const project of visible) {
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

    const pinned = pins.some((pin) => pin.project_id === project.project_id);
    row.append(
      createPinButton(project, pinned, !pinned && pins.length >= MAX_PINS, () =>
        pinProject(project),
      ),
    );

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

function visibleProjects(
  projects: ProjectSummary[],
  controls: ListControls,
): ProjectSummary[] {
  const query = controls.query.trim();
  const ranked = projects
    .filter(
      (project) =>
        (!controls.dirty || project.clean === false) &&
        (!controls.activeTasks ||
          project.open_tasks > 0 ||
          project.in_progress_tasks > 0),
    )
    .map((project): RankedProject | null => {
      const score = fuzzyScore(project.project, query);
      return score === null ? null : { project, score };
    })
    .filter((value): value is RankedProject => value !== null);
  ranked.sort((left, right) => {
    if (query && left.score !== right.score) return right.score - left.score;
    return compareProjects(left.project, right.project, controls.sort);
  });
  return ranked.map(({ project }) => project);
}

function compareProjects(
  left: ProjectSummary,
  right: ProjectSummary,
  sort: ProjectSort,
): number {
  if (sort === "recent") {
    const leftTime = left.latest_commit_unix;
    const rightTime = right.latest_commit_unix;
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return rightTime - leftTime;
    }
  }
  return (
    left.project.localeCompare(right.project, undefined, {
      sensitivity: "base",
    }) || left.project_id.localeCompare(right.project_id)
  );
}

function emptyState(message: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
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
