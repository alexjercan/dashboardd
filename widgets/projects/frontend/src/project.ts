import type {
  WidgetContext,
  WidgetFrontend,
  WidgetPresentation,
} from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./project.css";
import {
  createViewId,
  isRecord,
  parseDetails,
  parseSelection,
  relativeTime,
  type Branch,
  type Change,
  type ProjectDetails,
  type ProjectSelection,
} from "./shared";

type Tab = "overview" | "changes" | "branches";

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article class="shell">
      <header class="project-header">
        <div><h2>Project</h2><span class="identity">Select a project</span></div>
        <button class="refresh" type="button" hidden>Refresh</button>
      </header>
      <div class="content state">Select a project</div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Project details for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let presentation: WidgetPresentation = "tile";
  let selection: ProjectSelection | null = null;
  let details: ProjectDetails | null = null;
  let tab: Tab = "overview";
  let query = "";
  let changeKind = "all";

  const requestSelection = (next: ProjectSelection): void => {
    selection = next;
    details = null;
    renderState(shadow, selectionLabel(next), "Loading project...");
    void context
      .send({
        command: "select_project",
        view_id: viewId,
        ...next,
        focused: presentation === "focus",
      })
      .catch(() => renderState(shadow, next.project, "Project unavailable"));
  };

  const unsubscribe = context.links.subscribe("project", (payload) => {
    if (payload === null) {
      selection = null;
      details = null;
      renderState(shadow, "Select a project", "Select a project");
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      return;
    }
    const next = parseSelection(payload);
    if (!next) return;
    requestSelection(next);
  });

  shadow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tabButton = target.closest<HTMLButtonElement>("[data-tab]");
    if (tabButton?.dataset.tab && isTab(tabButton.dataset.tab)) {
      tab = tabButton.dataset.tab;
      query = "";
      if (details) renderDetails(shadow, details, tab, query, changeKind);
      return;
    }
    if (target.closest(".refresh"))
      void context
        .send({ command: "refresh", view_id: viewId })
        .catch(() => {});
  });
  shadow.addEventListener("input", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement &&
      target.classList.contains("search")
    ) {
      query = target.value;
      if (details) {
        renderDetails(shadow, details, tab, query, changeKind);
        const search = shadow.querySelector<HTMLInputElement>(".search");
        search?.focus();
        search?.setSelectionRange(query.length, query.length);
      }
    } else if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("change-kind")
    ) {
      changeKind = target.value;
      if (details) renderDetails(shadow, details, tab, query, changeKind);
    }
  });

  return {
    update(payload: unknown): void {
      if (!isRecord(payload) || payload.view_id !== viewId) return;
      const parsed = isRecord(payload.details)
        ? parseDetails(payload.details)
        : null;
      if (
        parsed &&
        selection?.project_id === parsed.project_id &&
        selection.worktree_id === parsed.worktree_id
      ) {
        details = parsed;
        renderDetails(shadow, parsed, tab, query, changeKind);
      } else if (!details && isRecord(payload.error)) {
        renderState(
          shadow,
          selection ? selectionLabel(selection) : "Project",
          "Project unavailable",
        );
      }
    },
    setPresentation(next: WidgetPresentation): void {
      presentation = next;
      shadow.host.setAttribute("data-presentation", next);
      required<HTMLButtonElement>(shadow, ".refresh").hidden = next !== "focus";
      if (selection) {
        void context
          .send({
            command: "set_focus",
            view_id: viewId,
            focused: next === "focus",
          })
          .catch(() => {});
      }
      if (details) renderDetails(shadow, details, tab, query, changeKind);
    },
    destroy(): void {
      unsubscribe();
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      shadow.replaceChildren();
    },
  };
}

function renderState(
  shadow: ShadowRoot,
  identity: string,
  message: string,
): void {
  required<HTMLElement>(shadow, ".identity").textContent = identity;
  const content = required<HTMLElement>(shadow, ".content");
  content.className = "content state";
  content.textContent = message;
}

function renderDetails(
  shadow: ShadowRoot,
  details: ProjectDetails,
  tab: Tab,
  query: string,
  changeKind: string,
): void {
  required<HTMLElement>(shadow, ".identity").textContent =
    selectionLabel(details);
  const content = required<HTMLElement>(shadow, ".content");
  content.className = "content";
  if (shadow.host.getAttribute("data-presentation") === "focus")
    renderFocus(content, details, tab, query, changeKind);
  else renderTile(content, details);
}

function selectionLabel(selection: ProjectSelection): string {
  return selection.worktree === "Primary"
    ? selection.project
    : `${selection.project} // ${selection.worktree}`;
}

function renderTile(content: HTMLElement, details: ProjectDetails): void {
  const status =
    details.clean === true
      ? "Clean"
      : details.clean === false
        ? `${details.change_count} changes`
        : "Directory";
  content.innerHTML = `
    <section class="tile-view">
      <div class="hero"><strong>${escapeHtml(details.branch ?? "No Git branch")}</strong><span data-state="${details.clean === false ? "dirty" : "clean"}">${status}</span></div>
      <div class="metrics">
        <div><span>Tasks</span><strong>${details.open_tasks} open / ${details.in_progress_tasks} active</strong></div>
        <div><span>Sync</span><strong>${syncLabel(details)}</strong></div>
        <div><span>Activity</span><strong>${relativeTime(details.latest_commit_unix)}</strong></div>
      </div>
      <div class="recent-changes"><span>Recent changes</span>${
        details.changes
          .slice(0, 3)
          .map(
            (change) =>
              `<div><b>${changeCode(change)}</b><code>${escapeHtml(change.path)}</code></div>`,
          )
          .join("") || "<em>No working tree changes</em>"
      }</div>
    </section>
  `;
}

function renderFocus(
  content: HTMLElement,
  details: ProjectDetails,
  tab: Tab,
  query: string,
  changeKind: string,
): void {
  content.innerHTML = `
    <nav class="tabs" aria-label="Project details">
      ${tabButton("overview", "Overview", tab)}
      ${tabButton("changes", `Changes ${details.change_count}`, tab)}
      ${tabButton("branches", `Branches ${details.branches.length}`, tab)}
    </nav>
    <section class="focus-content">
      ${tab === "overview" ? overview(details) : tab === "changes" ? changes(details.changes, query, changeKind) : branches(details.branches, query)}
    </section>
  `;
}

function overview(details: ProjectDetails): string {
  return `
    <div class="overview-grid">
      <section><span>Worktree</span><strong>${escapeHtml(details.worktree)}</strong><small>${escapeHtml(details.branch ?? "No Git branch")}</small></section>
      <section><span>Working tree</span><strong>${details.clean === null ? "Not a Git repository" : details.clean ? "Clean" : `${details.change_count} changed files`}</strong><small>${details.changes.filter((change) => change.staged).length} staged</small></section>
      <section><span>Tatr tasks</span><strong>${details.open_tasks} open</strong><small>${details.in_progress_tasks} in progress</small></section>
      <section><span>Latest commit</span><strong>${relativeTime(details.latest_commit_unix)}</strong><small>${escapeHtml(details.latest_commit_summary ?? "No local commit")}</small></section>
    </div>
    <div class="capabilities"><span class="${details.git ? "active" : ""}">Git</span><span class="${details.tatr ? "active" : ""}">Tatr</span></div>
  `;
}

function changes(values: Change[], query: string, kind: string): string {
  const normalized = query.trim().toLowerCase();
  const filtered = values.filter(
    (change) =>
      (kind === "all" ||
        change.kind === kind ||
        (kind === "staged" && change.staged) ||
        (kind === "unstaged" && change.unstaged)) &&
      (!normalized || change.path.toLowerCase().includes(normalized)),
  );
  return `
    <div class="section-controls"><input class="search" type="search" aria-label="Search changes" placeholder="Search changed paths" value="${escapeAttribute(query)}"><select class="change-kind" aria-label="Filter changes"><option value="all">All changes</option>${["staged", "unstaged", "added", "modified", "deleted", "renamed", "untracked"].map((value) => `<option value="${value}"${kind === value ? " selected" : ""}>${capitalize(value)}</option>`).join("")}</select></div>
    <div class="detail-list changes-list">${filtered.map((change) => `<div><b>${changeCode(change)}</b><code>${escapeHtml(change.path)}</code><span>${change.staged ? "staged" : ""}${change.staged && change.unstaged ? " + " : ""}${change.unstaged ? "unstaged" : ""}</span><small>${lineStats(change)}</small></div>`).join("") || "<p>No matching changes</p>"}</div>
  `;
}

function branches(values: Branch[], query: string): string {
  const normalized = query.trim().toLowerCase();
  const filtered = values.filter((branch) =>
    branch.name.toLowerCase().includes(normalized),
  );
  return `
    <div class="section-controls"><input class="search" type="search" aria-label="Search branches" placeholder="Search local branches" value="${escapeAttribute(query)}"></div>
    <div class="detail-list branches-list">${filtered.map((branch) => `<div class="${branch.current ? "current" : ""}"><strong>${escapeHtml(branch.name)}</strong><span>${escapeHtml(branch.upstream ?? "No upstream")}</span><small>${branch.ahead || branch.behind ? `${branch.ahead} ahead / ${branch.behind} behind` : relativeTime(branch.latest_commit_unix)}</small><em>${escapeHtml(branch.latest_commit_summary ?? "")}</em></div>`).join("") || "<p>No matching branches</p>"}</div>
  `;
}

function tabButton(value: Tab, label: string, active: Tab): string {
  return `<button type="button" data-tab="${value}" class="${value === active ? "active" : ""}" aria-pressed="${value === active}">${label}</button>`;
}

function syncLabel(details: ProjectDetails): string {
  if (!details.git) return "Not tracked";
  if (details.ahead || details.behind)
    return `${details.ahead} ahead / ${details.behind} behind`;
  return "Up to date locally";
}

function changeCode(change: Change): string {
  if (change.kind === "untracked") return "?";
  if (change.kind === "added") return "+";
  if (change.kind === "deleted") return "D";
  if (change.kind === "renamed") return "R";
  return "M";
}

function lineStats(change: Change): string {
  if (change.additions === null && change.deletions === null) return "";
  return `+${change.additions ?? 0} / -${change.deletions ?? 0}`;
}

function capitalize(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

function isTab(value: string): value is Tab {
  return value === "overview" || value === "changes" || value === "branches";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing Project element: ${selector}`);
  return element;
}
