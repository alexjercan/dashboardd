import type {
  WidgetFrontend,
  WidgetLaunchContext,
} from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./artifact-launcher.css";

type Task = {
  id: string;
  project_id: string;
  project: string;
  worktree_id: string;
  worktree: string;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "CLOSED";
};
type Artifact = { path: string; kind: string };
type Update =
  | { kind: "launch_catalog"; tasks: Task[]; error?: BackendError }
  | {
      kind: "launch_artifacts";
      identity: { project_id: string; worktree_id: string; task_id: string };
      artifacts: Artifact[];
      error?: BackendError;
    };
type BackendError = { code: string; message: string };

export function mount(
  container: HTMLElement,
  context: WidgetLaunchContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${widgetReset}\n${styles}</style><form><div class="row"><label>Project<select class="project"><option value="">Select a project</option></select></label><label>Worktree<select class="worktree" disabled><option value="">Select a worktree</option></select></label></div><label>Task search<input class="search" type="search" placeholder="Search by task ID or title" disabled></label><label>Task<select class="task-list" size="6" disabled></select></label><label>Artifact<select class="artifact" disabled><option value="">Select an artifact</option></select></label><p class="hint">Opaque project and worktree identities are resolved automatically.</p><p class="error" role="alert" hidden></p><footer><button class="cancel" type="button">Cancel</button><button class="primary" type="submit" disabled>Open</button></footer></form>`;
  const form = required<HTMLFormElement>(shadow, "form");
  const project = required<HTMLSelectElement>(shadow, ".project");
  const worktree = required<HTMLSelectElement>(shadow, ".worktree");
  const search = required<HTMLInputElement>(shadow, ".search");
  const task = required<HTMLSelectElement>(shadow, ".task-list");
  const artifact = required<HTMLSelectElement>(shadow, ".artifact");
  const cancel = required<HTMLButtonElement>(shadow, ".cancel");
  const open = required<HTMLButtonElement>(shadow, ".primary");
  const error = required<HTMLElement>(shadow, ".error");
  let tasks: Task[] = [];
  let visibleTasks: Task[] = [];
  let pendingArtifactIdentity = "";
  let destroyed = false;

  project.addEventListener("change", () => {
    renderWorktrees();
    renderTasks();
  });
  worktree.addEventListener("change", renderTasks);
  search.addEventListener("input", renderTasks);
  task.addEventListener("change", () => void requestArtifacts());
  cancel.addEventListener("click", () => {
    cancel.disabled = true;
    open.disabled = true;
    void context.cancel().catch((failure) => showError(message(failure)));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void complete();
  });
  void context
    .send({ command: "launch_catalog" })
    .catch((failure) => showError(message(failure)));

  function update(payload: unknown): void {
    const value = parseUpdate(payload);
    if (!value || destroyed) return;
    if (value.error) {
      showError(value.error.message);
      return;
    }
    if (value.kind === "launch_catalog") {
      tasks = value.tasks;
      renderProjects();
      return;
    }
    if (identityKey(value.identity) !== pendingArtifactIdentity) return;
    renderArtifacts(value.artifacts);
  }

  function renderProjects(): void {
    const previous = project.value;
    const projects = unique(
      tasks.map((entry) => ({ id: entry.project_id, name: entry.project })),
    );
    setOptions(project, projects, "Select a project");
    project.value = projects.some((entry) => entry.id === previous)
      ? previous
      : projects.length === 1
        ? projects[0].id
        : "";
    renderWorktrees();
    renderTasks();
  }

  function renderWorktrees(): void {
    const previous = worktree.value;
    const choices = unique(
      tasks
        .filter((entry) => entry.project_id === project.value)
        .map((entry) => ({ id: entry.worktree_id, name: entry.worktree })),
    );
    setOptions(worktree, choices, "Select a worktree");
    const primary = choices.find((entry) => entry.name === "Primary")?.id;
    worktree.value = choices.some((entry) => entry.id === previous)
      ? previous
      : (primary ?? (choices.length === 1 ? choices[0].id : ""));
    worktree.disabled = choices.length === 0;
  }

  function renderTasks(): void {
    const previousId = selectedTask()?.id;
    const query = search.value.trim().toLowerCase();
    visibleTasks = tasks.filter(
      (entry) =>
        entry.project_id === project.value &&
        entry.worktree_id === worktree.value &&
        (!query ||
          entry.id.toLowerCase().includes(query) ||
          entry.title.toLowerCase().includes(query)),
    );
    task.replaceChildren(
      ...visibleTasks.map((entry, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${entry.id} - ${entry.title}`;
        return option;
      }),
    );
    task.disabled = visibleTasks.length === 0;
    search.disabled = !project.value || !worktree.value;
    const previousIndex = visibleTasks.findIndex(
      (entry) => entry.id === previousId,
    );
    task.value = previousIndex >= 0 ? String(previousIndex) : "";
    artifact.replaceChildren(new Option("Select an artifact", ""));
    artifact.disabled = true;
    open.disabled = true;
    if (visibleTasks.length === 1) {
      task.value = "0";
      void requestArtifacts();
    }
  }

  async function requestArtifacts(): Promise<void> {
    const selected = selectedTask();
    if (!selected) return;
    pendingArtifactIdentity = identityKey({
      project_id: selected.project_id,
      worktree_id: selected.worktree_id,
      task_id: selected.id,
    });
    artifact.disabled = true;
    open.disabled = true;
    hideError();
    try {
      await context.send({
        command: "launch_artifacts",
        project_id: selected.project_id,
        worktree_id: selected.worktree_id,
        task_id: selected.id,
        artifact: "TASK.md",
      });
    } catch (failure) {
      showError(message(failure));
    }
  }

  function renderArtifacts(artifacts: Artifact[]): void {
    setOptions(
      artifact,
      artifacts.map((entry) => ({ id: entry.path, name: entry.path })),
      "Select an artifact",
    );
    artifact.value = artifacts.some((entry) => entry.path === "TASK.md")
      ? "TASK.md"
      : artifacts.length === 1
        ? artifacts[0].path
        : "";
    artifact.disabled = artifacts.length === 0;
    open.disabled = !artifact.value;
  }

  async function complete(): Promise<void> {
    const selected = selectedTask();
    if (!selected || !artifact.value) return;
    cancel.disabled = true;
    open.disabled = true;
    hideError();
    try {
      await context.complete({
        artifact: {
          type: "tatr.task-artifact-reference/v1",
          value: {
            project_id: selected.project_id,
            worktree_id: selected.worktree_id,
            task_id: selected.id,
            artifact: artifact.value,
          },
        },
      });
    } catch (failure) {
      showError(message(failure));
      cancel.disabled = false;
      open.disabled = false;
    }
  }

  function selectedTask(): Task | undefined {
    if (!task.value) return undefined;
    const index = Number(task.value);
    return Number.isInteger(index) ? visibleTasks[index] : undefined;
  }

  function showError(text: string): void {
    error.textContent = text;
    error.hidden = false;
  }

  function hideError(): void {
    error.textContent = "";
    error.hidden = true;
  }

  return {
    update,
    destroy(): void {
      destroyed = true;
      shadow.replaceChildren();
    },
  };
}

function parseUpdate(value: unknown): Update | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "launch_catalog" && Array.isArray(record.tasks)) {
    return value as Update;
  }
  if (
    record.kind === "launch_artifacts" &&
    record.identity &&
    Array.isArray(record.artifacts)
  ) {
    return value as Update;
  }
  if (
    (record.kind === "launch_catalog" || record.kind === "launch_artifacts") &&
    record.error
  ) {
    return value as Update;
  }
  return undefined;
}

function unique(values: Array<{ id: string; name: string }>) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function setOptions(
  select: HTMLSelectElement,
  values: Array<{ id: string; name: string }>,
  placeholder: string,
): void {
  select.replaceChildren(
    new Option(placeholder, ""),
    ...values.map((value) => new Option(value.name, value.id)),
  );
}

function identityKey(identity: {
  project_id: string;
  worktree_id: string;
  task_id: string;
}): string {
  return `${identity.project_id}\u0000${identity.worktree_id}\u0000${identity.task_id}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}
