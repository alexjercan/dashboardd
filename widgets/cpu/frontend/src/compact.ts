import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./compact.css";

type CpuSnapshot = {
  usagePercent: number;
  loadOne: number;
  packageTemperature: number | null;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <article>
      <h2>CPU</h2>
      <strong class="usage">--.-%</strong>
      <div class="details"><span class="temperature">-- C</span><span>Load <b class="load">--</b></span></div>
    </article>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Compact CPU telemetry for ${context.instanceId}`,
  );

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      required<HTMLElement>(shadow, ".usage").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      required<HTMLElement>(shadow, ".temperature").textContent =
        snapshot.packageTemperature === null
          ? "-- C"
          : `${snapshot.packageTemperature.toFixed(0)} C`;
      required<HTMLElement>(shadow, ".load").textContent =
        snapshot.loadOne.toFixed(2);
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function parseSnapshot(value: unknown): CpuSnapshot | null {
  if (!isRecord(value) || !isRecord(value.load_average)) return null;
  if (
    !isFiniteNumber(value.usage_percent) ||
    !isFiniteNumber(value.load_average.one) ||
    !(
      value.package_temperature_celsius === null ||
      isFiniteNumber(value.package_temperature_celsius)
    )
  )
    return null;
  return {
    usagePercent: Math.min(100, Math.max(0, value.usage_percent)),
    loadOne: value.load_average.one,
    packageTemperature: value.package_temperature_celsius,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
