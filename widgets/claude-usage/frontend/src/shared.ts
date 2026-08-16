import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./styles.css";

export type Variant = "full" | "compact" | "minimal";
type Limit = {
  label: string;
  remaining_percent: number;
  resets_at: string | number | null;
};
type Snapshot =
  | {
      status: "ok";
      subscription_type: string | null;
      updated_at: number;
      stale: boolean;
      important: Limit;
      all_models?: Limit | null;
    }
  | { status: "unavailable"; reason: "sign_in" | "service" };

export function mountUsage(
  container: HTMLElement,
  context: WidgetContext,
  variant: Variant,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  const displayMode =
    context.options.display_mode === "usage" ? "usage" : "remaining";
  let snapshot: Snapshot | null = null;
  let refreshing = false;
  shadow.innerHTML = `<style>${widgetReset}\n${styles}</style><article class="${variant}"><div class="state">Waiting for usage...</div></article>`;
  shadow.host.setAttribute(
    "aria-label",
    `Claude subscription usage for ${context.instanceId}`,
  );
  const requestRefresh = async (force: boolean): Promise<void> => {
    if (force) {
      refreshing = true;
      if (snapshot)
        render(
          shadow,
          snapshot,
          variant,
          displayMode,
          refreshing,
          () => void requestRefresh(true),
        );
    }
    try {
      await context.send({ command: "refresh", force });
    } catch {
      refreshing = false;
      if (snapshot)
        render(
          shadow,
          snapshot,
          variant,
          displayMode,
          refreshing,
          () => void requestRefresh(true),
        );
    }
  };
  const timer = window.setInterval(
    () =>
      snapshot &&
      render(
        shadow,
        snapshot,
        variant,
        displayMode,
        refreshing,
        () => void requestRefresh(true),
      ),
    60_000,
  );
  void requestRefresh(false);
  return {
    update(payload: unknown): void {
      snapshot = parse(payload);
      refreshing = false;
      render(
        shadow,
        snapshot,
        variant,
        displayMode,
        refreshing,
        () => void requestRefresh(true),
      );
    },
    destroy(): void {
      clearInterval(timer);
      shadow.replaceChildren();
    },
  };
}

function render(
  shadow: ShadowRoot,
  snapshot: Snapshot,
  variant: Variant,
  displayMode: "usage" | "remaining",
  refreshing: boolean,
  onRefresh: () => void,
): void {
  const article = required<HTMLElement>(shadow, "article");
  if (snapshot.status === "unavailable") {
    article.innerHTML = `<div class="state">${snapshot.reason === "sign_in" ? "Sign in with Claude Code" : "Usage unavailable"}</div>${variant === "minimal" ? "" : refreshButton(refreshing)}`;
    article.removeAttribute("data-severity");
    bindRefresh(article, onRefresh);
    return;
  }
  const important = snapshot.important;
  article.dataset.severity = severity(important.remaining_percent);
  article.classList.toggle("stale", snapshot.stale);
  if (variant === "minimal") {
    article.innerHTML = `<strong class="minimal-value">${important.remaining_percent}%</strong>`;
    shadow.host.setAttribute(
      "aria-label",
      `Claude ${important.label} weekly usage, ${important.remaining_percent} percent remaining`,
    );
    return;
  }
  const secondary =
    variant === "full" && snapshot.all_models
      ? limitMarkup(snapshot.all_models, false, false, displayMode)
      : "";
  article.innerHTML = `<header><h2>Claude Usage</h2><span class="meta">${titleCase(snapshot.subscription_type)}</span>${refreshButton(refreshing)}<span class="updated">Updated ${relative(snapshot.updated_at, variant === "compact")}${snapshot.stale ? " - Stale" : ""}</span></header><div class="limits">${limitMarkup(important, true, variant === "compact", displayMode)}${secondary}</div>`;
  bindRefresh(article, onRefresh);
}

function refreshButton(refreshing: boolean): string {
  return `<button class="refresh" type="button" ${refreshing ? "disabled" : ""}>${refreshing ? "Refreshing..." : "Refresh"}</button>`;
}

function bindRefresh(article: HTMLElement, onRefresh: () => void): void {
  article
    .querySelector<HTMLButtonElement>(".refresh")
    ?.addEventListener("click", onRefresh);
}

function limitMarkup(
  limit: Limit,
  primary: boolean,
  short: boolean,
  displayMode: "usage" | "remaining",
): string {
  const percent =
    displayMode === "usage"
      ? 100 - limit.remaining_percent
      : limit.remaining_percent;
  return `<section class="limit ${primary ? "primary" : ""}" data-severity="${severity(limit.remaining_percent)}"><div class="line"><strong>${escapeHtml(limit.label)}</strong><span>${percent}% ${displayMode === "usage" ? "used" : "remaining"}</span></div><div class="bar"><div class="fill" style="--remaining:${percent}%"></div></div><span class="reset">${resetLabel(limit.resets_at, short)}</span></section>`;
}

function parse(value: unknown): Snapshot {
  if (
    !isRecord(value) ||
    (value.status !== "ok" && value.status !== "unavailable")
  )
    return { status: "unavailable", reason: "service" };
  if (value.status === "unavailable")
    return {
      status: "unavailable",
      reason: value.reason === "sign_in" ? "sign_in" : "service",
    };
  const important = parseLimit(value.important);
  const all = value.all_models == null ? null : parseLimit(value.all_models);
  if (!important || typeof value.updated_at !== "number")
    return { status: "unavailable", reason: "service" };
  return {
    status: "ok",
    subscription_type:
      typeof value.subscription_type === "string"
        ? value.subscription_type
        : null,
    updated_at: value.updated_at,
    stale: value.stale === true,
    important,
    all_models: all,
  };
}
function parseLimit(value: unknown): Limit | null {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    typeof value.remaining_percent !== "number"
  )
    return null;
  return {
    label: value.label,
    remaining_percent: Math.round(
      Math.min(100, Math.max(0, value.remaining_percent)),
    ),
    resets_at:
      typeof value.resets_at === "string" || typeof value.resets_at === "number"
        ? value.resets_at
        : null,
  };
}
function resetLabel(value: string | number | null, short: boolean): string {
  if (value === null) return "Reset time unavailable";
  const seconds = Math.floor(
    (new Date(typeof value === "number" ? value * 1000 : value).getTime() -
      Date.now()) /
      1000,
  );
  if (seconds <= 0) return "Reset pending";
  return `Resets in ${duration(seconds, short)}`;
}
function relative(timestamp: number, short: boolean): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  return seconds < 60 ? "just now" : `${duration(seconds, short)} ago`;
}
function duration(seconds: number, short: boolean): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.max(1, Math.floor((seconds % 3600) / 60));
  const values = days
    ? [
        [days, short ? "d" : days === 1 ? "day" : "days"],
        [hours, short ? "h" : hours === 1 ? "hour" : "hours"],
      ]
    : hours
      ? [
          [hours, short ? "h" : hours === 1 ? "hour" : "hours"],
          [mins, short ? "m" : mins === 1 ? "min" : "mins"],
        ]
      : [[mins, short ? "m" : mins === 1 ? "min" : "mins"]];
  return values
    .filter(([n]) => n)
    .map(([n, u]) => (short ? `${n}${u}` : `${n} ${u}`))
    .join(" ");
}
function severity(value: number): string {
  return value < 10 ? "danger" : value <= 30 ? "warning" : "normal";
}
function titleCase(value: string | null): string {
  return value
    ? value
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "";
}
function escapeHtml(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
