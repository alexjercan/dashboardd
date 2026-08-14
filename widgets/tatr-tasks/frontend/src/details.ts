import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./details.css";

type TaskSelection = { project: string; task_id: string };
type Details = TaskSelection & { markdown: string };

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${widgetReset}\n${styles}</style><article><header><h2>Task Details</h2><span class="identity"></span></header><div class="content state">Select a task</div></article>`;
  shadow.host.setAttribute(
    "aria-label",
    `Tatr task details for ${context.instanceId}`,
  );
  let hasDetails = false;
  const viewId = crypto.randomUUID();

  const unsubscribe = context.links.subscribe("task", (payload) => {
    const selection = parseSelection(payload);
    if (!selection) return;
    if (hasDetails)
      required<HTMLElement>(shadow, ".identity").textContent =
        `${selection.project} / ${selection.task_id}`;
    else renderLoading(shadow, selection);
    void context
      .send({ command: "select_task", view_id: viewId, ...selection })
      .catch(() => renderState(shadow, "Task details unavailable"));
  });

  return {
    update(payload: unknown): void {
      if (!isRecord(payload) || payload.view_id !== viewId) return;
      const details = parseDetails(payload);
      if (details) {
        hasDetails = true;
        renderDetails(shadow, details);
      } else if (!hasDetails && isRecord(payload.error)) {
        renderState(shadow, "Task details unavailable");
      }
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
  required<HTMLElement>(shadow, ".identity").textContent =
    `${selection.project} / ${selection.task_id}`;
  renderState(shadow, "Loading TASK.md...");
}

function renderState(shadow: ShadowRoot, message: string): void {
  const content = required<HTMLElement>(shadow, ".content");
  content.className = "content state";
  content.textContent = message;
}

function renderDetails(shadow: ShadowRoot, details: Details): void {
  required<HTMLElement>(shadow, ".identity").textContent =
    `${details.project} / ${details.task_id}`;
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.image = () => "";
  const rendered = marked.parse(details.markdown, {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  });
  const content = required<HTMLElement>(shadow, ".content");
  content.className = "content markdown";
  content.innerHTML = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["img", "style", "iframe", "object", "embed"],
  });
  for (const link of content.querySelectorAll<HTMLAnchorElement>("a")) {
    if (/^https?:\/\//i.test(link.getAttribute("href") ?? "")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.removeAttribute("href");
    }
  }
}

function parseSelection(value: unknown): TaskSelection | null {
  if (
    !isRecord(value) ||
    typeof value.project !== "string" ||
    typeof value.task_id !== "string"
  )
    return null;
  return { project: value.project, task_id: value.task_id };
}

function parseDetails(value: unknown): Details | null {
  const selection = parseSelection(value);
  if (!selection || typeof value !== "object" || value === null) return null;
  const markdown = (value as Record<string, unknown>).markdown;
  return typeof markdown === "string" ? { ...selection, markdown } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
