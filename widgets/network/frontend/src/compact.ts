import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./compact.css";

type NetworkSnapshot = { received: number; transmitted: number };

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <h2>Network</h2>
      <div class="rate down"><span>Down</span><strong>--</strong></div>
      <div class="rate up"><span>Up</span><strong>--</strong></div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Compact network telemetry for ${context.instanceId}`,
  );
  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      required<HTMLElement>(shadow, ".down strong").textContent = formatRate(
        snapshot.received,
      );
      required<HTMLElement>(shadow, ".up strong").textContent = formatRate(
        snapshot.transmitted,
      );
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function parseSnapshot(value: unknown): NetworkSnapshot | null {
  if (
    !isRecord(value) ||
    !isNonnegativeNumber(value.received_bytes_per_second) ||
    !isNonnegativeNumber(value.transmitted_bytes_per_second)
  )
    return null;
  return {
    received: value.received_bytes_per_second,
    transmitted: value.transmitted_bytes_per_second,
  };
}

function formatRate(bytes: number): string {
  return `${formatBytes(bytes)}/s`;
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
