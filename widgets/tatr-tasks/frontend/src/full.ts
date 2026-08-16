import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
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
    tasks: [] as Task[],
    statuses: new Set<Status>(),
    tags: new Set<string>(),
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
  shadow.innerHTML = `<style>${widgetReset}\n${styles}</style><article><header><div><h2>Tatr Tasks</h2><span class="summary">Waiting for tasks...</span></div><label class="mobile-sort">Sort<select aria-label="Sort tasks"><option value="priority">Priority</option><option value="created">Created</option><option value="title">Title</option></select></label></header><div class="filters" hidden><span class="filter-list"></span><button class="clear" type="button">Clear</button></div><div class="table"><div class="table-head"><span>Status</span><span>Project</span><span>Task ID</span><button type="button" data-sort="title">Title</button><span>Tags</span><button type="button" data-sort="priority">Priority</button></div><div class="rows"><div class="empty">Waiting for tasks...</div></div></div></article>`;
  shadow.host.setAttribute(
    "aria-label",
    `Tatr tasks for ${context.instanceId}`,
  );

  for (const button of shadow.querySelectorAll<HTMLButtonElement>(
    "[data-sort]",
  ))
    button.addEventListener("click", () => {
      const sort = parseSort(button.dataset.sort);
      if (state.sort === sort)
        state.direction =
          state.direction === "ascending" ? "descending" : "ascending";
      else {
        state.sort = sort;
        state.direction = defaultDirection(sort);
      }
      render(shadow, state);
    });
  const select = required<HTMLSelectElement>(shadow, ".mobile-sort select");
  select.value = state.sort;
  select.addEventListener("change", () => {
    state.sort = parseSort(select.value);
    state.direction = defaultDirection(state.sort);
    render(shadow, state);
  });
  required<HTMLButtonElement>(shadow, ".clear").addEventListener(
    "click",
    () => {
      state.statuses.clear();
      state.tags.clear();
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
  const filtered = state.tasks.filter(
    (task) =>
      (state.project === null ||
        task.worktree_id === state.project.worktree_id) &&
      (state.statuses.size === 0 || state.statuses.has(task.status)) &&
      [...state.tags].every((tag) => task.tags.includes(tag)),
  );
  const tasks = [...filtered].sort((left, right) => {
    const order = compare(left, right, state.sort);
    return state.direction === "ascending" ? order : -order;
  });
  required<HTMLElement>(shadow, ".summary").textContent = summary(
    filtered.length,
    state.tasks.length,
  );
  const select = required<HTMLSelectElement>(shadow, ".mobile-sort select");
  select.value = state.sort;
  for (const button of shadow.querySelectorAll<HTMLButtonElement>(
    "[data-sort]",
  )) {
    const active = button.dataset.sort === state.sort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-sort", active ? state.direction : "none");
  }
  renderFilters(shadow, state);
  const rows = required<HTMLElement>(shadow, ".rows");
  rows.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      state.tasks.length === 0
        ? "No tasks"
        : state.project
          ? `No tasks for ${selectionLabel(state.project)}`
          : "No matching tasks";
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

  const project = document.createElement("span");
  project.className = "project";
  project.textContent = task.project;
  project.title = task.project;

  const taskId = document.createElement("span");
  taskId.className = "task-id";
  taskId.textContent = task.id;

  const title = document.createElement("button");
  title.type = "button";
  title.className = "title";
  title.textContent = task.title;
  title.title = `Show details for ${task.title}`;
  title.addEventListener("click", (event) => {
    event.stopPropagation();
    select();
  });

  const metadata = document.createElement("span");
  metadata.className = "metadata";

  const tags = document.createElement("span");
  tags.className = "tags";
  for (const value of task.tags) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.textContent = value;
    tag.classList.toggle("selected", state.tags.has(value));
    tag.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(state.tags, value);
      render(shadow, state);
    });
    tags.append(tag);
  }

  const priority = document.createElement("span");
  priority.className = "priority";
  priority.textContent = `P${task.priority}`;

  metadata.append(taskId, tags);
  row.append(status, project, metadata, title, priority);
  return row;
}

function renderFilters(
  shadow: ShadowRoot,
  state: {
    project: ProjectSelection | null;
    statuses: Set<Status>;
    tags: Set<string>;
  },
): void {
  const filters = required<HTMLElement>(shadow, ".filters");
  const list = required<HTMLElement>(shadow, ".filter-list");
  list.replaceChildren();
  if (state.project) {
    const chip = document.createElement("span");
    chip.className = "project-filter";
    chip.textContent = `Project: ${selectionLabel(state.project)}`;
    list.append(chip);
  }
  for (const status of state.statuses) {
    const chip = document.createElement("span");
    chip.textContent = statusLabel(status);
    list.append(chip);
  }
  for (const tag of state.tags) {
    const chip = document.createElement("span");
    chip.textContent = `#${tag}`;
    list.append(chip);
  }
  const hasLocalFilters = state.statuses.size > 0 || state.tags.size > 0;
  required<HTMLButtonElement>(shadow, ".clear").hidden = !hasLocalFilters;
  filters.hidden = state.project === null && !hasLocalFilters;
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
