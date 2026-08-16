import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./compact.css";

type DiskSnapshot = {
  usagePercent: number;
  availableBytes: number;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <h2>Disk</h2>
      <strong class="usage">--.-%</strong>
      <div class="bar"><div class="fill"></div></div>
      <span class="amount">-- free</span>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Compact disk telemetry for ${context.instanceId}`,
  );

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      required<HTMLElement>(shadow, ".usage").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      required<HTMLElement>(shadow, ".amount").textContent =
        `${formatBytes(snapshot.availableBytes)} free`;
      const fill = required<HTMLElement>(shadow, ".fill");
      fill.style.setProperty("--usage", `${snapshot.usagePercent}%`);
      fill.className = `fill ${severity(snapshot.usagePercent)}`.trim();
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function parseSnapshot(value: unknown): DiskSnapshot | null {
  if (
    !isRecord(value) ||
    !isNonnegativeNumber(value.usage_percent) ||
    !isNonnegativeNumber(value.available_bytes)
  )
    return null;
  return {
    usagePercent: Math.min(100, value.usage_percent),
    availableBytes: value.available_bytes,
  };
}

function severity(percent: number): string {
  if (percent >= 90) return "hot";
  if (percent >= 70) return "warm";
  return "";
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
