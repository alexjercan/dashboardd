import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import type {
  WidgetContext,
  WidgetFrontend,
  WidgetPresentation,
} from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./details.css";

type TaskSelection = {
  project_id: string;
  project: string;
  worktree_id: string;
  worktree: string;
  task_id: string;
};
type ArtifactKind = "markdown" | "html" | "text" | "image";
type ArtifactDescriptor = { path: string; kind: ArtifactKind };
type ArtifactDetails = TaskSelection & {
  artifact: string;
  artifacts: ArtifactDescriptor[];
  kind: ArtifactKind;
  content: string;
  mediaType: string | null;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article class="artifact-shell">
      <header class="artifact-header">
        <h2>Task Artifact</h2>
        <details class="picker" hidden>
          <summary class="identity"></summary>
          <div class="artifact-menu" role="menu" aria-label="Task artifacts"></div>
        </details>
      </header>
      <div class="content state">Select a task</div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Tatr task artifact viewer for ${context.instanceId}`,
  );
  const viewId = createViewId();
  let hasDetails = false;
  let selection: TaskSelection | null = null;
  let requestedArtifact = "TASK.md";

  const requestArtifact = (artifact: string): void => {
    required<HTMLDetailsElement>(shadow, ".picker").open = false;
    if (!selection || artifact === requestedArtifact) return;
    requestedArtifact = artifact;
    renderIdentity(shadow, selection, artifact);
    void context
      .send({
        command: "select_artifact",
        view_id: viewId,
        ...selection,
        artifact,
      })
      .catch(() => {
        if (!hasDetails) renderState(shadow, "Task artifact unavailable");
      });
  };

  const unsubscribe = context.links.subscribe("task", (payload) => {
    if (payload === null) {
      selection = null;
      hasDetails = false;
      requestedArtifact = "TASK.md";
      required<HTMLDetailsElement>(shadow, ".picker").hidden = true;
      renderState(shadow, "Select a task");
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      return;
    }
    const next = parseSelection(payload);
    if (!next) return;
    selection = next;
    requestedArtifact = "TASK.md";
    hasDetails = false;
    renderLoading(shadow, next);
    void context
      .send({ command: "select_task", view_id: viewId, ...next })
      .catch(() => renderState(shadow, "Task artifact unavailable"));
  });

  shadow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLButtonElement>("[data-artifact]");
    if (option?.dataset.artifact) requestArtifact(option.dataset.artifact);
  });
  shadow.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Escape")
      required<HTMLDetailsElement>(shadow, ".picker").open = false;
  });

  return {
    update(payload: unknown): void {
      if (!isRecord(payload) || payload.view_id !== viewId) return;
      const details = parseDetails(payload);
      if (details && details.artifact === requestedArtifact) {
        hasDetails = true;
        selection = {
          project_id: details.project_id,
          project: details.project,
          worktree_id: details.worktree_id,
          worktree: details.worktree,
          task_id: details.task_id,
        };
        renderDetails(shadow, details, requestArtifact);
      } else if (!hasDetails && isRecord(payload.error)) {
        renderState(shadow, "Task artifact unavailable");
      }
    },
    setPresentation(presentation: WidgetPresentation): void {
      shadow.host.setAttribute("data-presentation", presentation);
    },
    destroy(): void {
      void context
        .send({ command: "release_view", view_id: viewId })
        .catch(() => {});
      unsubscribe();
      shadow.replaceChildren();
    },
  };
}

function renderLoading(shadow: ShadowRoot, selection: TaskSelection): void {
  const picker = required<HTMLDetailsElement>(shadow, ".picker");
  picker.hidden = false;
  picker.open = false;
  renderIdentity(shadow, selection, "TASK.md");
  required<HTMLElement>(shadow, ".artifact-menu").replaceChildren();
  renderState(shadow, "Loading TASK.md...");
}

function renderIdentity(
  shadow: ShadowRoot,
  selection: TaskSelection,
  artifact: string,
): void {
  const project =
    selection.worktree === "Primary"
      ? selection.project
      : `${selection.project} // ${selection.worktree}`;
  required<HTMLElement>(shadow, ".identity").textContent =
    `${project} // ${selection.task_id}/${artifact}`;
}

function renderState(shadow: ShadowRoot, message: string): void {
  const content = required<HTMLElement>(shadow, ".content");
  content.className = "content state";
  content.textContent = message;
}

function renderDetails(
  shadow: ShadowRoot,
  details: ArtifactDetails,
  selectArtifact: (artifact: string) => void,
): void {
  renderIdentity(shadow, details, details.artifact);
  renderArtifactMenu(shadow, details.artifacts, details.artifact);
  const content = required<HTMLElement>(shadow, ".content");
  switch (details.kind) {
    case "markdown":
      renderMarkdown(content, details, selectArtifact);
      break;
    case "html":
      renderHtml(content, details, selectArtifact);
      break;
    case "text":
      content.className = "content text-artifact";
      content.replaceChildren(
        Object.assign(document.createElement("pre"), {
          textContent: details.content,
        }),
      );
      break;
    case "image": {
      content.className = "content image-artifact";
      const image = document.createElement("img");
      image.alt = details.artifact;
      image.src = `data:${details.mediaType ?? "application/octet-stream"};base64,${details.content}`;
      content.replaceChildren(image);
      break;
    }
  }
}

function renderArtifactMenu(
  shadow: ShadowRoot,
  artifacts: ArtifactDescriptor[],
  selected: string,
): void {
  const picker = required<HTMLDetailsElement>(shadow, ".picker");
  picker.hidden = false;
  const menu = required<HTMLElement>(shadow, ".artifact-menu");
  menu.replaceChildren(
    ...artifacts.map((artifact) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.artifact = artifact.path;
      button.dataset.kind = artifact.kind;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(artifact.path === selected));
      button.className = artifact.path === selected ? "selected" : "";
      button.textContent = artifact.path;
      return button;
    }),
  );
}

function renderMarkdown(
  content: HTMLElement,
  details: ArtifactDetails,
  selectArtifact: (artifact: string) => void,
): void {
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.image = () => "";
  const rendered = marked.parse(details.content, {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  });
  content.className = "content document-artifact markdown";
  content.innerHTML = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["img", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["class", "id", "style"],
  });
  secureLinks(content, details, selectArtifact);
}

function renderHtml(
  content: HTMLElement,
  details: ArtifactDetails,
  selectArtifact: (artifact: string) => void,
): void {
  content.className = "content document-artifact html-artifact";
  content.innerHTML = DOMPurify.sanitize(details.content, {
    FORBID_TAGS: [
      "script",
      "style",
      "form",
      "input",
      "button",
      "select",
      "textarea",
      "iframe",
      "object",
      "embed",
      "img",
      "audio",
      "video",
      "source",
      "link",
      "meta",
      "base",
    ],
    FORBID_ATTR: ["class", "id", "style"],
  });
  secureLinks(content, details, selectArtifact);
}

function secureLinks(
  content: HTMLElement,
  details: ArtifactDetails,
  selectArtifact: (artifact: string) => void,
): void {
  const available = new Set(details.artifacts.map((artifact) => artifact.path));
  for (const link of content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      continue;
    }
    if (href.startsWith("#")) continue;
    const artifact = resolveRelativeArtifact(details.artifact, href);
    if (!artifact || !available.has(artifact)) {
      link.removeAttribute("href");
      continue;
    }
    link.href = "#";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      selectArtifact(artifact);
    });
  }
}

function resolveRelativeArtifact(current: string, href: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded)
  )
    return null;
  const parts = current.split("/");
  parts.pop();
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
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

function parseSelection(value: unknown): TaskSelection | null {
  if (
    !isRecord(value) ||
    typeof value.project_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.worktree_id !== "string" ||
    typeof value.worktree !== "string" ||
    typeof value.task_id !== "string"
  )
    return null;
  return {
    project_id: value.project_id,
    project: value.project,
    worktree_id: value.worktree_id,
    worktree: value.worktree,
    task_id: value.task_id,
  };
}

function parseDetails(value: unknown): ArtifactDetails | null {
  const selection = parseSelection(value);
  if (
    !selection ||
    !isRecord(value) ||
    typeof value.artifact !== "string" ||
    !Array.isArray(value.artifacts) ||
    !isArtifactKind(value.kind) ||
    typeof value.content !== "string" ||
    (value.media_type !== null && typeof value.media_type !== "string")
  )
    return null;
  const artifacts = value.artifacts.map(parseArtifactDescriptor);
  if (artifacts.some((artifact) => artifact === null)) return null;
  return {
    ...selection,
    artifact: value.artifact,
    artifacts: artifacts as ArtifactDescriptor[],
    kind: value.kind,
    content: value.content,
    mediaType: value.media_type,
  };
}

function parseArtifactDescriptor(value: unknown): ArtifactDescriptor | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isArtifactKind(value.kind)
  )
    return null;
  return { path: value.path, kind: value.kind };
}
function isArtifactKind(value: unknown): value is ArtifactKind {
  return ["markdown", "html", "text", "image"].includes(value as string);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
