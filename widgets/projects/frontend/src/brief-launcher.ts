import type {
  WidgetFrontend,
  WidgetLaunchContext,
} from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./brief-launcher.css";

type Worktree = {
  worktree_id: string;
  worktree: string;
  primary: boolean;
};

type Project = {
  project_id: string;
  project: string;
  worktrees: Worktree[];
};

type LaunchCatalog = {
  kind: "launch_catalog";
  projects: Project[];
};

export function mount(
  container: HTMLElement,
  context: WidgetLaunchContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${widgetReset}\n${styles}</style><form><label>Project search<input class="search" type="search" placeholder="Search projects" disabled></label><label>Project<select class="projects" size="8" disabled></select></label><label>Worktree<select class="worktrees" disabled><option value="">Select a worktree</option></select></label><p class="hint">Project identities and local paths are resolved automatically.</p><p class="error" role="alert" hidden></p><footer><button class="cancel" type="button">Cancel</button><button class="primary" type="submit" disabled>Open</button></footer></form>`;
  const form = required<HTMLFormElement>(shadow, "form");
  const search = required<HTMLInputElement>(shadow, ".search");
  const projectSelect = required<HTMLSelectElement>(shadow, ".projects");
  const worktreeSelect = required<HTMLSelectElement>(shadow, ".worktrees");
  const cancel = required<HTMLButtonElement>(shadow, ".cancel");
  const open = required<HTMLButtonElement>(shadow, ".primary");
  const error = required<HTMLElement>(shadow, ".error");
  let projects: Project[] = [];
  let visibleProjects: Project[] = [];
  let destroyed = false;

  search.addEventListener("input", renderProjects);
  projectSelect.addEventListener("change", renderWorktrees);
  worktreeSelect.addEventListener("change", updateOpen);
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
    const catalog = parseCatalog(payload);
    if (!catalog || destroyed) return;
    projects = catalog.projects;
    search.disabled = false;
    renderProjects();
    search.focus();
  }

  function renderProjects(): void {
    const previousId = selectedProject()?.project_id;
    const query = search.value.trim().toLowerCase();
    visibleProjects = projects.filter(
      (project) => !query || project.project.toLowerCase().includes(query),
    );
    projectSelect.replaceChildren(
      ...visibleProjects.map((project, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = project.project;
        return option;
      }),
    );
    projectSelect.disabled = visibleProjects.length === 0;
    const previousIndex = visibleProjects.findIndex(
      (project) => project.project_id === previousId,
    );
    projectSelect.value =
      previousIndex >= 0
        ? String(previousIndex)
        : visibleProjects.length === 1
          ? "0"
          : "";
    renderWorktrees();
  }

  function renderWorktrees(): void {
    const project = selectedProject();
    const previousId = selectedWorktree()?.worktree_id;
    const worktrees = project?.worktrees ?? [];
    worktreeSelect.replaceChildren(
      new Option("Select a worktree", ""),
      ...worktrees.map(
        (worktree, index) => new Option(worktree.worktree, String(index)),
      ),
    );
    const previousIndex = worktrees.findIndex(
      (worktree) => worktree.worktree_id === previousId,
    );
    const primaryIndex = worktrees.findIndex((worktree) => worktree.primary);
    worktreeSelect.value =
      previousIndex >= 0
        ? String(previousIndex)
        : primaryIndex >= 0
          ? String(primaryIndex)
          : worktrees.length === 1
            ? "0"
            : "";
    worktreeSelect.disabled = worktrees.length === 0;
    updateOpen();
  }

  function updateOpen(): void {
    open.disabled = !selectedProject() || !selectedWorktree();
  }

  async function complete(): Promise<void> {
    const project = selectedProject();
    const worktree = selectedWorktree();
    if (!project || !worktree) return;
    cancel.disabled = true;
    open.disabled = true;
    hideError();
    try {
      await context.complete({
        project: {
          type: "dashboardd.project-selection/v1",
          value: {
            project_id: project.project_id,
            project: project.project,
            worktree_id: worktree.worktree_id,
            worktree: worktree.worktree,
          },
        },
      });
    } catch (failure) {
      showError(message(failure));
      cancel.disabled = false;
    }
  }

  function selectedProject(): Project | undefined {
    if (!projectSelect.value) return undefined;
    const index = Number(projectSelect.value);
    return Number.isInteger(index) ? visibleProjects[index] : undefined;
  }

  function selectedWorktree(): Worktree | undefined {
    const project = selectedProject();
    if (!project || !worktreeSelect.value) return undefined;
    const index = Number(worktreeSelect.value);
    return Number.isInteger(index) ? project.worktrees[index] : undefined;
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

function parseCatalog(value: unknown): LaunchCatalog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "launch_catalog" || !Array.isArray(record.projects))
    return undefined;
  return value as LaunchCatalog;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}
