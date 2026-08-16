import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import type {
  WidgetContext,
  WidgetFrontend,
  WidgetPresentation,
} from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./brief.css";
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

type Tab = "document" | "changes" | "branches";

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <header><div><h2>Project Brief</h2><span class="identity">Select a project</span></div><button class="refresh" type="button" hidden>Refresh</button></header>
      <div class="content state">Select a project</div>
    </article>`;
  shadow.host.setAttribute(
    "aria-label",
    `Project brief for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let presentation: WidgetPresentation = "tile";
  let selection: ProjectSelection | null = null;
  let details: ProjectDetails | null = null;
  let tab: Tab = "document";
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
      renderState(
        shadow,
        "Select a project",
        "Select a project from Project Pulse",
      );
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      return;
    }
    const next = parseSelection(payload);
    if (next) requestSelection(next);
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
    const documentButton = target.closest<HTMLButtonElement>("[data-document]");
    if (documentButton?.dataset.document) {
      void context
        .send({
          command: "select_document",
          view_id: viewId,
          document: documentButton.dataset.document,
        })
        .catch(() => {});
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
      if (details) rerenderWithFocus(shadow, details, tab, query, changeKind);
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
      if (selection)
        void context
          .send({
            command: "set_focus",
            view_id: viewId,
            focused: next === "focus",
          })
          .catch(() => {});
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
  if (shadow.host.getAttribute("data-presentation") === "focus") {
    renderFocus(content, details, tab, query, changeKind);
    if (tab === "document") secureDocumentLinks(content);
  } else renderTile(content, details);
}

function renderTile(content: HTMLElement, details: ProjectDetails): void {
  const status =
    details.clean === true
      ? "Clean"
      : details.clean === false
        ? `${details.change_count} ${details.change_count === 1 ? "change" : "changes"}`
        : "Directory";
  const task = details.in_progress_tasks
    ? `${details.in_progress_tasks} active ${details.in_progress_tasks === 1 ? "task" : "tasks"}`
    : details.open_tasks
      ? `${details.open_tasks} open ${details.open_tasks === 1 ? "task" : "tasks"}`
      : "No active tasks";
  const excerpt = documentExcerpt(details.document?.content ?? "");
  content.innerHTML = `
    <section class="tile-view">
      <div class="hero"><strong>${escapeHtml(details.branch ?? "No Git branch")}</strong><span data-state="${details.clean === false ? "dirty" : "clean"}">${status}</span></div>
      <p class="excerpt">${escapeHtml(excerpt || details.latest_commit_summary || "No project document")}</p>
      <div class="facts"><span>${task}</span><span>${relativeTime(details.latest_commit_unix)}</span></div>
    </section>`;
}

function renderFocus(
  content: HTMLElement,
  details: ProjectDetails,
  tab: Tab,
  query: string,
  changeKind: string,
): void {
  content.innerHTML = `
    <nav class="tabs" aria-label="Project research">
      ${tabButton("document", "Document", tab)}
      ${tabButton("changes", `Changes ${details.change_count}`, tab)}
      ${tabButton("branches", `Branches ${details.branches.length}`, tab)}
    </nav>
    <section class="focus-content">
      ${tab === "document" ? documentView(details) : tab === "changes" ? changes(details.changes, query, changeKind) : branches(details.branches, query)}
    </section>`;
}

function documentView(details: ProjectDetails): string {
  const picker = details.documents.length
    ? `<div class="document-picker">${details.documents
        .map(
          (path) =>
            `<button type="button" data-document="${escapeAttribute(path)}" class="${details.document?.path === path ? "active" : ""}">${escapeHtml(path)}</button>`,
        )
        .join("")}</div>`
    : "";
  return `${picker}<div class="document">${renderMarkdown(details.document?.content ?? "No readable project document")}</div>`;
}

function secureDocumentLinks(content: HTMLElement): void {
  for (const link of Array.from(
    content.querySelectorAll<HTMLAnchorElement>(".document a"),
  )) {
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else if (!href.startsWith("#")) {
      link.removeAttribute("href");
    }
  }
}

function renderMarkdown(source: string): string {
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.image = () => "";
  return DOMPurify.sanitize(
    marked.parse(source, { async: false, gfm: true, renderer }),
    {
      FORBID_TAGS: ["img", "style", "iframe", "object", "embed"],
      FORBID_ATTR: ["class", "id", "style"],
    },
  );
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
  return `<div class="section-controls"><input class="search" type="search" aria-label="Search changes" placeholder="Search changed paths" value="${escapeAttribute(query)}"><select class="change-kind" aria-label="Filter changes"><option value="all">All changes</option>${["staged", "unstaged", "added", "modified", "deleted", "renamed", "untracked"].map((value) => `<option value="${value}"${kind === value ? " selected" : ""}>${capitalize(value)}</option>`).join("")}</select></div><div class="detail-list changes-list">${filtered.map((change) => `<div><b>${changeCode(change)}</b><code>${escapeHtml(change.path)}</code><span>${change.staged ? "staged" : ""}${change.staged && change.unstaged ? " + " : ""}${change.unstaged ? "unstaged" : ""}</span><small>${lineStats(change)}</small></div>`).join("") || "<p>No matching changes</p>"}</div>`;
}

function branches(values: Branch[], query: string): string {
  const normalized = query.trim().toLowerCase();
  const filtered = values.filter((branch) =>
    branch.name.toLowerCase().includes(normalized),
  );
  return `<div class="section-controls"><input class="search" type="search" aria-label="Search branches" placeholder="Search local branches" value="${escapeAttribute(query)}"></div><div class="detail-list branches-list">${filtered.map((branch) => `<div class="${branch.current ? "current" : ""}"><strong>${escapeHtml(branch.name)}</strong><span>${escapeHtml(branch.upstream ?? "No upstream")}</span><small>${branch.ahead || branch.behind ? `${branch.ahead} ahead / ${branch.behind} behind` : relativeTime(branch.latest_commit_unix)}</small><em>${escapeHtml(branch.latest_commit_summary ?? "")}</em></div>`).join("") || "<p>No matching branches</p>"}</div>`;
}

function rerenderWithFocus(
  shadow: ShadowRoot,
  details: ProjectDetails,
  tab: Tab,
  query: string,
  changeKind: string,
): void {
  renderDetails(shadow, details, tab, query, changeKind);
  const search = shadow.querySelector<HTMLInputElement>(".search");
  search?.focus();
  search?.setSelectionRange(query.length, query.length);
}

function documentExcerpt(source: string): string {
  return (
    source
      .replace(/^---[\s\S]*?---\s*/u, "")
      .split(/\n\s*\n/u)
      .map((part) =>
        part
          .replace(/^#{1,6}\s+/u, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
          .replace(/[*_`>#-]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .find((part) => part.length > 20)
      ?.slice(0, 180) ?? ""
  );
}

function selectionLabel(selection: ProjectSelection): string {
  return selection.worktree === "Primary"
    ? selection.project
    : `${selection.project} // ${selection.worktree}`;
}

function tabButton(value: Tab, label: string, active: Tab): string {
  return `<button type="button" data-tab="${value}" class="${value === active ? "active" : ""}" aria-pressed="${value === active}">${label}</button>`;
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
  return value === "document" || value === "changes" || value === "branches";
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
  if (!element) throw new Error(`missing Project Brief element: ${selector}`);
  return element;
}
