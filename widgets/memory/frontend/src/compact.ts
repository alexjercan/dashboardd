import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./compact.css";

type MemorySnapshot = {
  usagePercent: number;
  usedBytes: number;
  totalBytes: number;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <h2>Memory</h2>
      <strong class="usage">--.-%</strong>
      <div class="bar"><div class="fill"></div></div>
      <span class="amount">-- / --</span>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Compact Memory telemetry for ${context.instanceId}`,
  );

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      required<HTMLElement>(shadow, ".usage").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      required<HTMLElement>(shadow, ".amount").textContent =
        `${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.totalBytes)}`;
      const fill = required<HTMLElement>(shadow, ".fill");
      fill.style.setProperty("--usage", `${snapshot.usagePercent}%`);
      fill.className =
        `fill ${snapshot.usagePercent >= 90 ? "hot" : snapshot.usagePercent >= 70 ? "warm" : ""}`.trim();
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function parseSnapshot(value: unknown): MemorySnapshot | null {
  if (
    !isRecord(value) ||
    !isNonnegativeNumber(value.usage_percent) ||
    !isNonnegativeNumber(value.used_bytes) ||
    !isNonnegativeNumber(value.total_bytes)
  )
    return null;
  return {
    usagePercent: Math.min(100, value.usage_percent),
    usedBytes: value.used_bytes,
    totalBytes: value.total_bytes,
  };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
