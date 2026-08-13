const HISTORY_LENGTH = 60;
const GRAPH_WIDTH = 600;
const GRAPH_TOP = 5;
const GRAPH_BOTTOM = 75;

const styles = `
  :host {
    display: block;
    min-width: 0;
    color: var(--dashboard-foreground, #e4e4ef);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  .widget {
    overflow: hidden;
    border: 1px solid var(--dashboard-border, #96a6c8);
    border-radius: 7px;
    background: var(--dashboard-raised, #282828);
    box-shadow: 0 14px 36px rgb(0 0 0 / 22%);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--dashboard-border, #96a6c8) 28%, transparent);
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .eyebrow {
    color: var(--dashboard-muted, #65737e);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    color: var(--dashboard-bright, #f4f4ff);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 17px;
    font-weight: 650;
  }

  .headline {
    display: flex;
    align-items: baseline;
    gap: 9px;
    white-space: nowrap;
  }

  .usage {
    color: var(--dashboard-accent, #ffdd33);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 24px;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    line-height: 1;
  }

  .temperature {
    color: var(--dashboard-secondary, #9e95c7);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .body { padding: 10px 12px 12px; }

  .graph-shell {
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--dashboard-border, #96a6c8) 22%, transparent);
    border-radius: 4px;
    background: var(--dashboard-background, #181818);
  }

  svg { display: block; width: 100%; height: 82px; }
  .grid { stroke: color-mix(in srgb, var(--dashboard-muted, #65737e) 20%, transparent); stroke-width: 1; }
  .area { fill: color-mix(in srgb, var(--dashboard-accent, #ffdd33) 13%, transparent); }
  .line { fill: none; stroke: var(--dashboard-accent, #ffdd33); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.2; }
  .axis-label { fill: var(--dashboard-dim, #535057); font-size: 9px; }

  .loads {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin: 8px 1px 9px;
    color: var(--dashboard-muted, #65737e);
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .load-value {
    margin-left: 3px;
    color: var(--dashboard-foreground, #e4e4ef);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }

  .cores {
    display: grid;
    grid-template-columns: repeat(var(--core-columns, 6), 38px);
    justify-content: space-between;
    gap: 5px;
  }

  .core {
    position: relative;
    min-width: 0;
    overflow: hidden;
    aspect-ratio: 1;
    border: 1px solid color-mix(in srgb, var(--dashboard-border, #96a6c8) 26%, transparent);
    border-radius: 3px;
    background: var(--dashboard-background, #181818);
  }

  .core-fill {
    position: absolute;
    inset: auto 0 0;
    height: var(--usage, 0%);
    background: color-mix(in srgb, var(--dashboard-success, #73c936) 64%, transparent);
    transition: height 180ms linear;
  }

  .core-fill.warm { background: color-mix(in srgb, var(--dashboard-accent, #ffdd33) 68%, transparent); }
  .core-fill.hot { background: color-mix(in srgb, var(--dashboard-error, #f43841) 72%, transparent); }

  .core-temperature {
    position: absolute;
    z-index: 1;
    text-shadow: 0 1px 2px var(--dashboard-background, #181818);
    inset: 50% 2px auto;
    transform: translateY(-42%);
    color: var(--dashboard-bright, #f4f4ff);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    text-align: center;
    white-space: nowrap;
  }

  .waiting {
    grid-column: 1 / -1;
    padding: 36px 12px;
    color: var(--dashboard-muted, #65737e);
    font-size: 11px;
    text-align: center;
  }

  .error { color: var(--dashboard-error, #f43841); }

  @media (max-width: 420px) {
    header { padding-inline: 11px; }
    .body { padding-inline: 9px; }
    .usage { font-size: 21px; }
    .eyebrow { display: none; }
  }
`;

/**
 * @param {HTMLElement} container
 * @param {{ widgetId: string, instanceId: string, send: (payload: unknown) => void }} context
 */
export function mount(container, context) {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${styles}</style>
    <article class="widget" aria-label="CPU telemetry for ${context.instanceId}">
      <header>
        <div class="title"><h2>CPU</h2><span class="eyebrow">60 second history</span></div>
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
    </article>
  `;

  const history = [];
  const usageElement = shadow.querySelector(".usage");
  const temperatureElement = shadow.querySelector(".temperature");
  const lineElement = shadow.querySelector(".line");
  const areaElement = shadow.querySelector(".area");
  const coresElement = shadow.querySelector(".cores");

  return {
    update(payload) {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) {
        coresElement.innerHTML =
          '<div class="waiting error">Invalid CPU telemetry</div>';
        return;
      }

      history.push(snapshot.usagePercent);
      if (history.length > HISTORY_LENGTH) history.shift();

      usageElement.textContent = `${snapshot.usagePercent.toFixed(1)}%`;
      temperatureElement.textContent = formatTemperature(
        snapshot.packageTemperature,
      );
      shadow.querySelector('[data-load="one"]').textContent =
        snapshot.load.one.toFixed(2);
      shadow.querySelector('[data-load="five"]').textContent =
        snapshot.load.five.toFixed(2);
      shadow.querySelector('[data-load="fifteen"]').textContent =
        snapshot.load.fifteen.toFixed(2);

      renderGraph(history, lineElement, areaElement);
      renderCores(snapshot.cores, coresElement);
    },
    destroy() {
      shadow.replaceChildren();
    },
  };
}

function renderGraph(history, lineElement, areaElement) {
  const points = history.map((value, index) => {
    const offset = HISTORY_LENGTH - history.length + index;
    const x = (offset / (HISTORY_LENGTH - 1)) * GRAPH_WIDTH;
    const y = GRAPH_BOTTOM - (value / 100) * (GRAPH_BOTTOM - GRAPH_TOP);
    return [x, y];
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

function renderCores(cores, container) {
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
    element
      .querySelector(".core-fill")
      .style.setProperty("--usage", `${core.usagePercent}%`);
    element.querySelector(".core-temperature").textContent = formatTemperature(
      core.temperature,
    );
    container.append(element);
  }
}

function coreColumns(count) {
  if (count >= 18) return 6;
  if (count >= 10) return 5;
  if (count >= 7) return 4;
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function parseSnapshot(value) {
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
    cores,
    load: { one: load.one, five: load.five, fifteen: load.fifteen },
    packageTemperature: optionalNumber(value.package_temperature_celsius),
  };
}

function parseCore(value) {
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

function percentage(value) {
  return isFiniteNumber(value) ? Math.min(100, Math.max(0, value)) : null;
}

function optionalNumber(value) {
  return value === null || value === undefined
    ? null
    : isFiniteNumber(value)
      ? value
      : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function formatTemperature(value) {
  return value === null ? "-- C" : `${value.toFixed(0)} C`;
}

function formatFrequency(mhz) {
  return mhz >= 1000
    ? `${(mhz / 1000).toFixed(2)} GHz`
    : `${Math.round(mhz)} MHz`;
}
