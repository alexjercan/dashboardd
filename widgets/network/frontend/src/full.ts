import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import widgetReset from "@scufris/widget-sdk/widget.css";
import styles from "./styles.css";

const HISTORY_LENGTH = 60;
const GRAPH_WIDTH = 600;
const GRAPH_BOTTOM = 70;

type NetworkSnapshot = {
  received: number;
  transmitted: number;
  totalReceived: number;
  totalTransmitted: number;
  receiveErrors: number;
  transmitErrors: number;
  activeInterfaces: number;
};

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${widgetReset}\n${styles}</style>
    <header>
      <div><h2>Network</h2><span class="eyebrow">Aggregate throughput</span></div>
      <span class="interfaces">-- interfaces</span>
    </header>
    <div class="body">
      <div class="graph-heading"><span>60 second history</span><span class="scale">--</span></div>
      <svg viewBox="0 0 600 72" role="img" aria-label="Network receive and transmit throughput history">
        <line class="grid" x1="0" y1="1" x2="600" y2="1"></line>
        <line class="grid" x1="0" y1="35" x2="600" y2="35"></line>
        <line class="grid" x1="0" y1="70" x2="600" y2="70"></line>
        <path class="line down"></path><path class="line up"></path>
      </svg>
      <div class="rates"><span class="down-key">Down <b class="down-rate">--</b></span><span class="up-key">Up <b class="up-rate">--</b></span></div>
      <div class="metrics">
        <span>Received <b class="received-total">--</b></span>
        <span>Sent <b class="sent-total">--</b></span>
        <span class="errors">Errors <b>0</b></span>
      </div>
    </div>
  `;
  shadow.host.setAttribute(
    "aria-label",
    `Network telemetry for ${context.instanceId}`,
  );
  const receivedHistory: number[] = [];
  const transmittedHistory: number[] = [];

  return {
    update(payload: unknown): void {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) return;
      receivedHistory.push(snapshot.received);
      transmittedHistory.push(snapshot.transmitted);
      if (receivedHistory.length > HISTORY_LENGTH) receivedHistory.shift();
      if (transmittedHistory.length > HISTORY_LENGTH)
        transmittedHistory.shift();
      required<HTMLElement>(shadow, ".interfaces").textContent =
        `${snapshot.activeInterfaces} ${snapshot.activeInterfaces === 1 ? "interface" : "interfaces"}`;
      required<HTMLElement>(shadow, ".down-rate").textContent = formatRate(
        snapshot.received,
      );
      required<HTMLElement>(shadow, ".up-rate").textContent = formatRate(
        snapshot.transmitted,
      );
      required<HTMLElement>(shadow, ".received-total").textContent =
        formatBytes(snapshot.totalReceived);
      required<HTMLElement>(shadow, ".sent-total").textContent = formatBytes(
        snapshot.totalTransmitted,
      );
      const errors = snapshot.receiveErrors + snapshot.transmitErrors;
      const errorElement = required<HTMLElement>(shadow, ".errors");
      errorElement.classList.toggle("active", errors > 0);
      required<HTMLElement>(shadow, ".errors b").textContent = String(errors);
      renderHistory(shadow, receivedHistory, transmittedHistory);
    },
    destroy(): void {
      shadow.replaceChildren();
    },
  };
}

function renderHistory(
  shadow: ShadowRoot,
  received: number[],
  transmitted: number[],
): void {
  const maximum = Math.max(1, ...received, ...transmitted);
  required<HTMLElement>(shadow, ".scale").textContent = formatRate(maximum);
  required<SVGPathElement>(shadow, ".line.down").setAttribute(
    "d",
    historyPath(received, maximum),
  );
  required<SVGPathElement>(shadow, ".line.up").setAttribute(
    "d",
    historyPath(transmitted, maximum),
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

function parseSnapshot(value: unknown): NetworkSnapshot | null {
  if (!isRecord(value)) return null;
  const keys = [
    "received_bytes_per_second",
    "transmitted_bytes_per_second",
    "total_received_bytes",
    "total_transmitted_bytes",
    "receive_errors",
    "transmit_errors",
    "active_interfaces",
  ] as const;
  if (!keys.every((key) => isNonnegativeNumber(value[key]))) return null;
  return {
    received: value.received_bytes_per_second as number,
    transmitted: value.transmitted_bytes_per_second as number,
    totalReceived: value.total_received_bytes as number,
    totalTransmitted: value.total_transmitted_bytes as number,
    receiveErrors: value.receive_errors as number,
    transmitErrors: value.transmit_errors as number,
    activeInterfaces: value.active_interfaces as number,
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
