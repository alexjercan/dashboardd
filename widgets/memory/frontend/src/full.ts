import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./styles.css";

const HISTORY_LENGTH = 60;
const GRAPH_WIDTH = 600;
const GRAPH_TOP = 5;
const GRAPH_BOTTOM = 75;

interface SwapSnapshot {
  usagePercent: number;
  usedBytes: number;
  totalBytes: number;
}

interface MemorySnapshot {
  usagePercent: number;
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  swap: SwapSnapshot;
}

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const showSwap = context.options.show_swap !== false;
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <header>
      <div class="title"><h2>RAM</h2><span class="eyebrow">60 second history</span></div>
      <div class="headline">
        <span class="usage">--.-%</span>
        <span class="total">-- GiB</span>
      </div>
    </header>
    <div class="body">
      <div class="error" role="alert" hidden>Invalid memory telemetry</div>
      <div class="graph-shell">
        <svg viewBox="0 0 600 80" role="img" aria-label="Memory usage history">
          <line class="grid" x1="0" y1="5" x2="600" y2="5"></line>
          <line class="grid" x1="0" y1="40" x2="600" y2="40"></line>
          <line class="grid" x1="0" y1="75" x2="600" y2="75"></line>
          <text class="axis-label" x="6" y="14">100</text>
          <text class="axis-label" x="6" y="38">50</text>
          <path class="area"></path>
          <path class="line"></path>
        </svg>
      </div>
      <section class="resource ram" aria-label="RAM usage">
        <div class="resource-heading"><span>RAM</span><span class="resource-percent">--.-%</span></div>
        <div class="bar"><div class="bar-fill"></div></div>
        <div class="metrics">
          <div class="metric-row"><span>Used</span><span class="metric-value" data-memory="used">--</span></div>
          <div class="metric-row"><span>Available</span><span class="metric-value" data-memory="available">--</span></div>
        </div>
      </section>
      <section class="resource swap" aria-label="Swap usage">
        <div class="resource-heading"><span>Swap</span><span class="resource-percent">--.-%</span></div>
        <div class="bar"><div class="bar-fill"></div></div>
        <div class="metrics">
          <div class="metric-row"><span>Used</span><span class="metric-value" data-swap="used">--</span></div>
        </div>
      </section>
    </div>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `RAM telemetry for ${context.instanceId}`,
  );
  required<HTMLElement>(shadow, ".swap").hidden = !showSwap;

  const history: number[] = [];
  const lineElement = required<SVGPathElement>(shadow, ".line");
  const areaElement = required<SVGPathElement>(shadow, ".area");

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      const error = required<HTMLElement>(shadow, ".error");
      if (!snapshot) {
        error.hidden = false;
        return;
      }
      error.hidden = true;

      history.push(snapshot.usagePercent);
      if (history.length > HISTORY_LENGTH) history.shift();

      required<HTMLElement>(shadow, ".usage").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      required<HTMLElement>(shadow, ".total").textContent = formatBytes(
        snapshot.totalBytes,
      );
      required<HTMLElement>(shadow, ".ram .resource-percent").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      updateBar(
        required<HTMLElement>(shadow, ".ram .bar-fill"),
        snapshot.usagePercent,
      );
      required<HTMLElement>(shadow, '[data-memory="used"]').textContent =
        `${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.totalBytes)}`;
      required<HTMLElement>(shadow, '[data-memory="available"]').textContent =
        formatBytes(snapshot.availableBytes);

      if (showSwap) renderSwap(shadow, snapshot.swap);
      renderGraph(history, lineElement, areaElement);
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function renderSwap(shadow: ShadowRoot, swap: SwapSnapshot): void {
  const percent = required<HTMLElement>(shadow, ".swap .resource-percent");
  const used = required<HTMLElement>(shadow, '[data-swap="used"]');
  if (swap.totalBytes === 0) {
    percent.textContent = "Not configured";
    used.textContent = "0 B / 0 B";
    updateBar(required<HTMLElement>(shadow, ".swap .bar-fill"), 0);
    return;
  }

  percent.textContent = `${swap.usagePercent.toFixed(1)}%`;
  used.textContent = `${formatBytes(swap.usedBytes)} / ${formatBytes(swap.totalBytes)}`;
  updateBar(
    required<HTMLElement>(shadow, ".swap .bar-fill"),
    swap.usagePercent,
  );
}

function updateBar(element: HTMLElement, usagePercent: number): void {
  element.className = `bar-fill ${severity(usagePercent)}`.trim();
  element.style.setProperty("--usage", `${usagePercent}%`);
}

function severity(usagePercent: number): string {
  if (usagePercent >= 90) return "hot";
  if (usagePercent >= 70) return "warm";
  return "";
}

function renderGraph(
  history: number[],
  lineElement: SVGPathElement,
  areaElement: SVGPathElement,
): void {
  const points = history.map((value, index) => {
    const offset = HISTORY_LENGTH - history.length + index;
    const x = (offset / (HISTORY_LENGTH - 1)) * GRAPH_WIDTH;
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

function parseSnapshot(value: unknown): MemorySnapshot | null {
  if (!isRecord(value) || !isRecord(value.swap)) return null;
  const usagePercent = percentage(value.usage_percent);
  const swapUsagePercent = percentage(value.swap.usage_percent);
  if (
    usagePercent === null ||
    swapUsagePercent === null ||
    !isNonnegativeNumber(value.used_bytes) ||
    !isNonnegativeNumber(value.total_bytes) ||
    !isNonnegativeNumber(value.available_bytes) ||
    !isNonnegativeNumber(value.swap.used_bytes) ||
    !isNonnegativeNumber(value.swap.total_bytes) ||
    value.used_bytes > value.total_bytes ||
    value.available_bytes > value.total_bytes ||
    value.swap.used_bytes > value.swap.total_bytes
  ) {
    return null;
  }

  return {
    usagePercent,
    usedBytes: value.used_bytes,
    totalBytes: value.total_bytes,
    availableBytes: value.available_bytes,
    swap: {
      usagePercent: swapUsagePercent,
      usedBytes: value.swap.used_bytes,
      totalBytes: value.swap.total_bytes,
    },
  };
}

function percentage(value: unknown): number | null {
  return isNonnegativeNumber(value) ? Math.min(100, value) : null;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing widget element: ${selector}`);
  return element;
}
