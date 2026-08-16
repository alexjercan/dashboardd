import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./styles.css";

const DEFAULT_HISTORY_LENGTH = 40;
const GRAPH_WIDTH = 600;
const GRAPH_TOP = 5;
const GRAPH_BOTTOM = 75;

type CoreSnapshot = {
  name: string;
  usagePercent: number;
  frequencyMhz: number;
  temperature: number | null;
};

type CpuSnapshot = {
  usagePercent: number;
  cores: CoreSnapshot[];
  load: { one: number; five: number; fifteen: number };
  packageTemperature: number | null;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const historyLength = integerOption(
    context.options.history_points,
    DEFAULT_HISTORY_LENGTH,
  );
  const showCoreTemperatures = context.options.show_core_temperatures !== false;
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <header>
      <div class="title"><h2>CPU</h2><span class="eyebrow">${historyLength} second history</span></div>
      <div class="headline">
        <span class="usage">--.-%</span>
        <span class="temperature">-- C</span>
      </div>
    </header>
    <div class="body">
      <div class="graph-shell">
        <svg viewBox="0 0 600 80" role="img" aria-label="CPU usage history">
          <line class="grid" x1="0" y1="5" x2="600" y2="5"></line>
          <line class="grid" x1="0" y1="40" x2="600" y2="40"></line>
          <line class="grid" x1="0" y1="75" x2="600" y2="75"></line>
          <text class="axis-label" x="6" y="14">100</text>
          <text class="axis-label" x="6" y="38">50</text>
          <path class="area"></path>
          <path class="line"></path>
        </svg>
      </div>
      <div class="loads" aria-label="Load averages">
        <span>Load 1m <b class="load-value" data-load="one">--</b></span>
        <span>5m <b class="load-value" data-load="five">--</b></span>
        <span>15m <b class="load-value" data-load="fifteen">--</b></span>
      </div>
      <div class="cores"><div class="waiting">Waiting for CPU telemetry...</div></div>
    </div>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `CPU telemetry for ${context.instanceId}`,
  );

  const history: number[] = [];
  const usageElement = required<HTMLElement>(shadow, ".usage");
  const temperatureElement = required<HTMLElement>(shadow, ".temperature");
  const lineElement = required<SVGPathElement>(shadow, ".line");
  const areaElement = required<SVGPathElement>(shadow, ".area");
  const coresElement = required<HTMLElement>(shadow, ".cores");

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) {
        coresElement.innerHTML =
          '<div class="waiting error">Invalid CPU telemetry</div>';
        return;
      }

      history.push(snapshot.usagePercent);
      if (history.length > historyLength) history.shift();

      usageElement.textContent = `${snapshot.usagePercent.toFixed(1)}%`;
      temperatureElement.textContent = formatTemperature(
        snapshot.packageTemperature,
      );
      required<HTMLElement>(shadow, '[data-load="one"]').textContent =
        snapshot.load.one.toFixed(2);
      required<HTMLElement>(shadow, '[data-load="five"]').textContent =
        snapshot.load.five.toFixed(2);
      required<HTMLElement>(shadow, '[data-load="fifteen"]').textContent =
        snapshot.load.fifteen.toFixed(2);

      renderGraph(history, historyLength, lineElement, areaElement);
      renderCores(snapshot.cores, coresElement, showCoreTemperatures);
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function renderGraph(
  history: number[],
  historyLength: number,
  lineElement: SVGPathElement,
  areaElement: SVGPathElement,
): void {
  const points = history.map((value, index) => {
    const offset = historyLength - history.length + index;
    const x = (offset / (historyLength - 1)) * GRAPH_WIDTH;
    const y = GRAPH_BOTTOM - (value / 100) * (GRAPH_BOTTOM - GRAPH_TOP);
    return [x, y] as const;
  });
  const line = points
    .map(
      ([x, y], index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
    )
    .join(" ");
  const first = points[0];
  const last = points.at(-1);

  lineElement.setAttribute("d", line);
  areaElement.setAttribute(
    "d",
    first && last
      ? `${line} L${last[0].toFixed(1)},${GRAPH_BOTTOM} L${first[0].toFixed(1)},${GRAPH_BOTTOM} Z`
      : "",
  );
}

function renderCores(
  cores: CoreSnapshot[],
  container: HTMLElement,
  showTemperatures: boolean,
): void {
  container.replaceChildren();
  container.style.setProperty(
    "--core-columns",
    String(coreColumns(cores.length)),
  );

  for (const core of cores) {
    const element = document.createElement("div");
    const fillClass =
      core.usagePercent >= 90 ? "hot" : core.usagePercent >= 70 ? "warm" : "";
    element.className = "core";
    element.title = `${core.name}: ${core.usagePercent.toFixed(1)}%, ${formatFrequency(core.frequencyMhz)}, ${formatTemperature(core.temperature)}`;
    element.innerHTML = `
      <div class="core-fill ${fillClass}"></div>
      <span class="core-temperature"></span>
    `;
    required<HTMLElement>(element, ".core-fill").style.setProperty(
      "--usage",
      `${core.usagePercent}%`,
    );
    const coreTemperature = required<HTMLElement>(element, ".core-temperature");
    coreTemperature.textContent = formatTemperature(core.temperature);
    coreTemperature.hidden = !showTemperatures;
    container.append(element);
  }
}

function coreColumns(count: number): number {
  if (count >= 18) return 6;
  if (count >= 10) return 5;
  if (count >= 7) return 4;
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function parseSnapshot(value: unknown): CpuSnapshot | null {
  if (!isRecord(value)) return null;
  const usagePercent = percentage(value.usage_percent);
  const load = value.load_average;
  if (
    usagePercent === null ||
    !Array.isArray(value.cores) ||
    !isRecord(load) ||
    !isFiniteNumber(load.one) ||
    !isFiniteNumber(load.five) ||
    !isFiniteNumber(load.fifteen)
  ) {
    return null;
  }

  const cores = value.cores.map(parseCore);
  if (cores.some((core) => core === null)) return null;

  return {
    usagePercent,
    cores: cores as CoreSnapshot[],
    load: { one: load.one, five: load.five, fifteen: load.fifteen },
    packageTemperature: optionalNumber(value.package_temperature_celsius),
  };
}

function parseCore(value: unknown): CoreSnapshot | null {
  if (!isRecord(value)) return null;
  const usagePercent = percentage(value.usage_percent);
  if (
    typeof value.name !== "string" ||
    usagePercent === null ||
    !isFiniteNumber(value.frequency_mhz)
  ) {
    return null;
  }

  return {
    name: value.name,
    usagePercent,
    frequencyMhz: value.frequency_mhz,
    temperature: optionalNumber(value.temperature_celsius),
  };
}

function percentage(value: unknown): number | null {
  return isFiniteNumber(value) ? Math.min(100, Math.max(0, value)) : null;
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : isFiniteNumber(value)
      ? value
      : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatTemperature(value: number | null): string {
  return value === null ? "-- C" : `${value.toFixed(0)} C`;
}

function formatFrequency(mhz: number): string {
  return mhz >= 1000
    ? `${(mhz / 1000).toFixed(2)} GHz`
    : `${Math.round(mhz)} MHz`;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
