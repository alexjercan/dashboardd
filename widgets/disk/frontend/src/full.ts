import type { WidgetContext, WidgetFrontend } from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";
import styles from "./styles.css";

const HISTORY_LENGTH = 60;
const GRAPH_WIDTH = 600;
const GRAPH_BOTTOM = 54;

type DiskSnapshot = {
  usagePercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
  readBytesPerSecond: number;
  writtenBytesPerSecond: number;
  fileSystem: string;
  readOnly: boolean;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <header>
      <div><h2>Disk</h2><span class="eyebrow">Root filesystem</span></div>
      <strong class="usage">--.-%</strong>
    </header>
    <div class="body">
      <div class="graph-heading"><span>I/O - 60 second history</span><span class="scale">--</span></div>
      <svg viewBox="0 0 600 56" role="img" aria-label="Disk read and write throughput history">
        <line class="grid" x1="0" y1="1" x2="600" y2="1"></line>
        <line class="grid" x1="0" y1="27" x2="600" y2="27"></line>
        <line class="grid" x1="0" y1="54" x2="600" y2="54"></line>
        <path class="line read"></path><path class="line write"></path>
      </svg>
      <div class="legend"><span class="read-key">Read <b class="read-rate">--</b></span><span class="write-key">Write <b class="write-rate">--</b></span></div>
      <div class="capacity"><div class="fill"></div></div>
      <div class="metrics">
        <span>Used <b class="used">--</b></span>
        <span>Free <b class="free">--</b></span>
        <span>Total <b class="total">--</b></span>
        <span class="filesystem">--</span>
      </div>
    </div>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Disk telemetry for ${context.instanceId}`,
  );
  const readHistory: number[] = [];
  const writeHistory: number[] = [];

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      readHistory.push(snapshot.readBytesPerSecond);
      writeHistory.push(snapshot.writtenBytesPerSecond);
      if (readHistory.length > HISTORY_LENGTH) readHistory.shift();
      if (writeHistory.length > HISTORY_LENGTH) writeHistory.shift();

      required<HTMLElement>(shadow, ".usage").textContent =
        `${snapshot.usagePercent.toFixed(1)}%`;
      required<HTMLElement>(shadow, ".read-rate").textContent = formatRate(
        snapshot.readBytesPerSecond,
      );
      required<HTMLElement>(shadow, ".write-rate").textContent = formatRate(
        snapshot.writtenBytesPerSecond,
      );
      required<HTMLElement>(shadow, ".used").textContent = formatBytes(
        snapshot.usedBytes,
      );
      required<HTMLElement>(shadow, ".free").textContent = formatBytes(
        snapshot.availableBytes,
      );
      required<HTMLElement>(shadow, ".total").textContent = formatBytes(
        snapshot.totalBytes,
      );
      required<HTMLElement>(shadow, ".filesystem").textContent =
        `${snapshot.fileSystem}${snapshot.readOnly ? " - read only" : ""}`;
      const fill = required<HTMLElement>(shadow, ".fill");
      fill.style.setProperty("--usage", `${snapshot.usagePercent}%`);
      fill.className = `fill ${severity(snapshot.usagePercent)}`.trim();
      renderHistory(shadow, readHistory, writeHistory);
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function renderHistory(
  shadow: ShadowRoot,
  reads: number[],
  writes: number[],
): void {
  const maximum = Math.max(1, ...reads, ...writes);
  required<HTMLElement>(shadow, ".scale").textContent = formatRate(maximum);
  required<SVGPathElement>(shadow, ".line.read").setAttribute(
    "d",
    historyPath(reads, maximum),
  );
  required<SVGPathElement>(shadow, ".line.write").setAttribute(
    "d",
    historyPath(writes, maximum),
  );
}

function historyPath(values: number[], maximum: number): string {
  return values
    .map((value, index) => {
      const offset = HISTORY_LENGTH - values.length + index;
      const x = (offset / (HISTORY_LENGTH - 1)) * GRAPH_WIDTH;
      const y = GRAPH_BOTTOM - (value / maximum) * (GRAPH_BOTTOM - 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function parseSnapshot(value: unknown): DiskSnapshot | null {
  if (
    !isRecord(value) ||
    !isNonnegativeNumber(value.usage_percent) ||
    !isNonnegativeNumber(value.used_bytes) ||
    !isNonnegativeNumber(value.available_bytes) ||
    !isNonnegativeNumber(value.total_bytes) ||
    !isNonnegativeNumber(value.read_bytes_per_second) ||
    !isNonnegativeNumber(value.written_bytes_per_second) ||
    typeof value.file_system !== "string" ||
    typeof value.read_only !== "boolean"
  )
    return null;
  return {
    usagePercent: Math.min(100, value.usage_percent),
    usedBytes: value.used_bytes,
    availableBytes: value.available_bytes,
    totalBytes: value.total_bytes,
    readBytesPerSecond: value.read_bytes_per_second,
    writtenBytesPerSecond: value.written_bytes_per_second,
    fileSystem: value.file_system,
    readOnly: value.read_only,
  };
}

function severity(percent: number): string {
  if (percent >= 90) return "hot";
  if (percent >= 70) return "warm";
  return "";
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
