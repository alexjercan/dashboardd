import type {
  WidgetContext,
  WidgetFrontend,
  WidgetPresentation,
} from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./styles.css";

type Status = "OPEN" | "IN_PROGRESS" | "CLOSED";
type ProjectSelection = {
  project_id: string;
  project: string;
  worktree_id: string;
  worktree: string;
};
type Task = ProjectSelection & {
  id: string;
  title: string;
  status: Status;
  priority: number;
  tags: string[];
};
type Snapshot = { view_id: string; tasks: Task[] };
type Sort = "created" | "priority" | "title";
type Direction = "ascending" | "descending";
type ViewState = {
  tasks: Task[];
  statuses: Set<Status>;
  tags: Set<string>;
  hideClosed: boolean;
  query: string;
  sort: Sort;
  direction: Direction;
  project: ProjectSelection | null;
  selectedTaskKey: string | null;
  publishSelection(task: Task): void;
  clearSelection(): void;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  const state: ViewState = {
    tasks: [],
    statuses: new Set<Status>(),
    tags: new Set<string>(),
    hideClosed: true,
    query: "",
    sort: parseSort(context.options.sort),
    direction: defaultDirection(parseSort(context.options.sort)),
    project: null,
    selectedTaskKey: null,
    publishSelection(task: Task): void {
      context.links.publish("selected_task", {
        project_id: task.project_id,
        project: task.project,
        worktree_id: task.worktree_id,
        worktree: task.worktree,
        task_id: task.id,
      });
    },
    clearSelection(): void {
      context.links.publish("selected_task", null);
    },
  };
  const viewId = createViewId();
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header>
        <div><h2>Tasks</h2><span class="summary">Waiting for tasks...</span></div>
        <label class="hide-closed"><input type="checkbox" checked> Hide closed</label>
      </header>
      <div class="focus-controls">
        <input class="search" type="search" aria-label="Search tasks" placeholder="Search tasks">
        <select class="sort" aria-label="Sort tasks"><option value="priority">Priority</option><option value="created">Created</option><option value="title">Title</option></select>
        <button class="clear" type="button">Clear filters</button>
      </div>
      <div class="filters" hidden><span class="filter-list"></span></div>
      <div class="rows"><div class="empty">Waiting for tasks...</div></div>
    </article>`;
  shadow.host.setAttribute(
    "aria-label",
    `Tatr tasks for ${context.instanceId}`,
  );

  required<HTMLInputElement>(shadow, ".hide-closed input").addEventListener(
    "change",
    (event) => {
      state.hideClosed = (event.currentTarget as HTMLInputElement).checked;
      render(shadow, state);
    },
  );
  required<HTMLInputElement>(shadow, ".search").addEventListener(
    "input",
    (event) => {
      state.query = (event.currentTarget as HTMLInputElement).value;
      render(shadow, state);
    },
  );
  const sort = required<HTMLSelectElement>(shadow, ".sort");
  sort.value = state.sort;
  sort.addEventListener("change", () => {
    state.sort = parseSort(sort.value);
    state.direction = defaultDirection(state.sort);
    render(shadow, state);
  });
  required<HTMLButtonElement>(shadow, ".clear").addEventListener(
    "click",
    () => {
      state.statuses.clear();
      state.tags.clear();
      state.query = "";
      required<HTMLInputElement>(shadow, ".search").value = "";
      render(shadow, state);
    },
  );

  const unsubscribeProject = context.links.subscribe("project", (payload) => {
    const project = parseProjectSelection(payload);
    if (project === undefined || sameSelection(project, state.project)) return;
    state.project = project;
    void context
      .send(
        project
          ? { command: "select_project", view_id: viewId, ...project }
          : { command: "clear_project", view_id: viewId },
      )
      .catch(() => {});
    if (
      state.selectedTaskKey &&
      !state.tasks.some(
        (task) =>
          taskKey(task) === state.selectedTaskKey &&
          (project === null || task.worktree_id === project.worktree_id),
      )
    ) {
      state.selectedTaskKey = null;
      state.clearSelection();
    }
    render(shadow, state);
  });

  void context.send({ command: "open_view", view_id: viewId }).catch(() => {});

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot || snapshot.view_id !== viewId) return;
      state.tasks = snapshot.tasks;
      render(shadow, state);
    },
    setPresentation(presentation: WidgetPresentation): void {
      shadow.host.setAttribute("data-presentation", presentation);
      if (presentation === "tile") {
        state.query = "";
        state.statuses.clear();
        state.tags.clear();
        required<HTMLInputElement>(shadow, ".search").value = "";
        render(shadow, state);
      }
    },
    destroy(): void {
      unsubscribeProject();
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      shadow.replaceChildren();
    },
  };
}

function render(shadow: ShadowRoot, state: ViewState): void {
  const normalized = state.query.trim().toLocaleLowerCase();
  const filtered = state.tasks.filter(
    (task) =>
      (state.project === null ||
        task.worktree_id === state.project.worktree_id) &&
      (!state.hideClosed || task.status !== "CLOSED") &&
      (state.statuses.size === 0 || state.statuses.has(task.status)) &&
      [...state.tags].every((tag) => task.tags.includes(tag)) &&
      (!normalized ||
        `${task.title} ${task.project} ${task.id} ${task.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalized)),
  );
  const tasks = [...filtered].sort((left, right) => {
    const order = compare(left, right, state.sort);
    return state.direction === "ascending" ? order : -order;
  });
  required<HTMLElement>(shadow, ".summary").textContent = summary(
    filtered.length,
    state.tasks.length,
  );
  required<HTMLSelectElement>(shadow, ".sort").value = state.sort;
  required<HTMLInputElement>(shadow, ".hide-closed input").checked =
    state.hideClosed;
  renderFilters(shadow, state);
  const rows = required<HTMLElement>(shadow, ".rows");
  rows.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      state.tasks.length === 0 ? "No tasks" : "No matching tasks";
    rows.append(empty);
    return;
  }
  for (const task of tasks) rows.append(taskRow(task, state, shadow));
}

function taskRow(
  task: Task,
  state: ViewState,
  shadow: ShadowRoot,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "task-row";
  row.classList.toggle("selected", state.selectedTaskKey === taskKey(task));
  row.dataset.status = task.status.toLowerCase();
  row.tabIndex = 0;
  const select = () => {
    state.selectedTaskKey = taskKey(task);
    state.publishSelection(task);
    render(shadow, state);
  };
  row.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("button")) select();
  });
  row.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === row) {
      event.preventDefault();
      select();
    }
  });

  const status = document.createElement("button");
  status.type = "button";
  status.className = "status";
  status.textContent = statusLabel(task.status);
  status.title = `Filter by ${status.textContent}`;
  status.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle(state.statuses, task.status);
    render(shadow, state);
  });

  const title = document.createElement("button");
  title.type = "button";
  title.className = "title";
  title.textContent = task.title;
  title.addEventListener("click", (event) => {
    event.stopPropagation();
    select();
  });

  const project = document.createElement("span");
  project.className = "project";
  project.textContent = selectionLabel(task);

  const priority = document.createElement("span");
  priority.className = "priority";
  priority.textContent = `P${task.priority}`;

  const taskId = document.createElement("span");
  taskId.className = "task-id";
  taskId.textContent = task.id;

  const tags = document.createElement("span");
  tags.className = "tags";
  for (const value of task.tags) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.textContent = `#${value}`;
    tag.classList.toggle("selected", state.tags.has(value));
    tag.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(state.tags, value);
      render(shadow, state);
    });
    tags.append(tag);
  }

  const secondary = document.createElement("div");
  secondary.className = "secondary";
  secondary.append(project, priority);
  const metadata = document.createElement("div");
  metadata.className = "metadata";
  metadata.append(taskId, tags);
  row.append(status, title, secondary, metadata);
  return row;
}

function renderFilters(shadow: ShadowRoot, state: ViewState): void {
  const filters = required<HTMLElement>(shadow, ".filters");
  const list = required<HTMLElement>(shadow, ".filter-list");
  list.replaceChildren();
  if (state.project) {
    const project = chip(`Project: ${selectionLabel(state.project)}`);
    project.className = "project-filter";
    list.append(project);
  }
  for (const status of state.statuses) list.append(chip(statusLabel(status)));
  for (const tag of state.tags) list.append(chip(`#${tag}`));
  filters.hidden = list.childElementCount === 0;
  required<HTMLButtonElement>(shadow, ".clear").hidden =
    state.statuses.size === 0 && state.tags.size === 0 && state.query === "";
}

function chip(text: string): HTMLElement {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

function taskKey(task: Task): string {
  return `${task.worktree_id}\u0000${task.id}`;
}

function parseProjectSelection(
  value: unknown,
): ProjectSelection | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.project_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.worktree_id !== "string" ||
    typeof value.worktree !== "string"
  )
    return undefined;
  return {
    project_id: value.project_id,
    project: value.project,
    worktree_id: value.worktree_id,
    worktree: value.worktree,
  };
}

function sameSelection(
  left: ProjectSelection | null,
  right: ProjectSelection | null,
): boolean {
  return left?.worktree_id === right?.worktree_id;
}

function selectionLabel(selection: ProjectSelection): string {
  return selection.worktree === "Primary"
    ? selection.project
    : `${selection.project} // ${selection.worktree}`;
}

function compare(left: Task, right: Task, sort: Sort): number {
  if (sort === "priority") return left.priority - right.priority;
  if (sort === "title") return left.title.localeCompare(right.title);
  return left.id.localeCompare(right.id);
}

function defaultDirection(sort: Sort): Direction {
  return sort === "priority" ? "descending" : "ascending";
}

function parseSort(value: unknown): Sort {
  return value === "created" || value === "title" ? value : "priority";
}

function summary(filtered: number, total: number): string {
  if (filtered === total) return `${total} ${total === 1 ? "task" : "tasks"}`;
  return `${filtered} of ${total} tasks`;
}

function statusLabel(status: Status): string {
  if (status === "IN_PROGRESS") return "In progress";
  return status === "OPEN" ? "Open" : "Closed";
}

function toggle<T>(values: Set<T>, value: T): void {
  if (!values.delete(value)) values.add(value);
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (
    !isRecord(value) ||
    typeof value.view_id !== "string" ||
    !Array.isArray(value.tasks)
  )
    return null;
  const tasks = value.tasks.map(parseTask);
  return tasks.every((task): task is Task => task !== null)
    ? { view_id: value.view_id, tasks }
    : null;
}

function parseTask(value: unknown): Task | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.project_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.worktree_id !== "string" ||
    typeof value.worktree !== "string" ||
    typeof value.title !== "string" ||
    !isStatus(value.status) ||
    !Number.isInteger(value.priority) ||
    (value.priority as number) < 0 ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string")
  )
    return null;
  return {
    id: value.id,
    project_id: value.project_id,
    project: value.project,
    worktree_id: value.worktree_id,
    worktree: value.worktree,
    title: value.title,
    status: value.status,
    priority: value.priority as number,
    tags: value.tags as string[],
  };
}

function isStatus(value: unknown): value is Status {
  return value === "OPEN" || value === "IN_PROGRESS" || value === "CLOSED";
}

function createViewId(): string {
  const values = new Uint32Array(4);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return [...values]
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
