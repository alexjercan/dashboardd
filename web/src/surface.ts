import {
  isWidgetModule,
  type WidgetFrontend,
  type WidgetInputs,
  type WidgetOutputs,
} from "@dashboardd/widget-sdk";
import { connectRuntime, type RuntimeConnection } from "./dashboard";
import {
  parseInstanceHealth,
  parseRuntimeInstance,
  parseTheme,
  parseWidgetDescriptor,
  type InstanceHealth,
  type RuntimeInstance,
  type Theme,
  type TypedInput,
} from "./protocol";
import { WidgetStateBus } from "./state";

const widgetElement = required<HTMLElement>("#widget");
const healthElement = required<HTMLElement>("#health");
const healthMessage = required<HTMLElement>("#health-message");
const restartButton = required<HTMLButtonElement>("#restart");
const unavailableElement = required<HTMLElement>("#unavailable");
const unavailableMessage = required<HTMLElement>("#unavailable-message");
const stateBus = new WidgetStateBus();

let instanceId: string;
let presentation: "focus" | "tile";
let connection: RuntimeConnection | undefined;
let resource: RuntimeInstance | null = null;
let frontend: WidgetFrontend | null = null;
let pendingUpdate: unknown;
let hasPendingUpdate = false;
let terminal = false;
let loadGeneration = 0;

try {
  instanceId = parseInstanceId(location.pathname);
  presentation = parsePresentation(new URL(location.href).searchParams);
  widgetElement.dataset.presentation = presentation;
  connection = connectRuntime({
    onStatus() {},
    onReconnect: loadSurface,
    onTheme: applyTheme,
    onConfigurationError() {},
    onInstanceCreated() {},
    onInstanceDestroyed(destroyedId) {
      if (destroyedId === instanceId)
        showUnavailable("The runtime instance was deleted.");
    },
    onInstanceInputsUpdated(updatedId, inputs) {
      if (updatedId !== instanceId || terminal) return;
      if (resource) resource.inputs = inputs;
      inputBus.set(inputs);
    },
    onInstanceHealth(health) {
      if (health.instance_id === instanceId && !terminal) renderHealth(health);
    },
    onWidgetUpdate(updatedId, payload) {
      if (updatedId !== instanceId || terminal) return;
      if (frontend) frontend.update(payload);
      else {
        pendingUpdate = payload;
        hasPendingUpdate = true;
      }
    },
    onWidgetStateUpdated(state) {
      if (state.widget_id === resource?.widget_id) stateBus.update(state);
    },
    onError(updatedId, message) {
      if (updatedId === null && !resource) showUnavailable(message);
    },
  });
  restartButton.addEventListener("click", () => void restart());
} catch (error) {
  instanceId = "";
  presentation = "focus";
  showUnavailable(errorMessage(error));
}

async function loadSurface(): Promise<void> {
  if (terminal) return;
  const generation = ++loadGeneration;
  const instanceResponse = await fetch(
    `/api/v1/instances/${encodeURIComponent(instanceId)}`,
  );
  if (instanceResponse.status === 404) {
    showUnavailable("The runtime instance was not found.");
    return;
  }
  if (!instanceResponse.ok) throw await responseError(instanceResponse);
  const next = parseRuntimeInstance(await instanceResponse.json());
  const [widgetResponse, themeResponse, healthResponse] = await Promise.all([
    fetch(`/api/v1/widgets/${encodeURIComponent(next.widget_id)}`),
    fetch("/api/v1/theme"),
    fetch(`/api/v1/instances/${encodeURIComponent(instanceId)}/health`),
  ]);
  for (const response of [widgetResponse, themeResponse, healthResponse])
    if (!response.ok) throw await responseError(response);
  const descriptor = parseWidgetDescriptor(await widgetResponse.json());
  const theme = parseTheme(await themeResponse.json());
  const health = parseInstanceHealth(await healthResponse.json());
  const variant = descriptor.variants.find(({ id }) => id === next.variant_id);
  if (!variant) throw new Error("widget variant was not found");
  if (terminal || generation !== loadGeneration) return;

  resource = next;
  inputBus.set(next.inputs);
  applyTheme(theme);
  renderHealth(health);
  await stateBus.reconcile([next.widget_id]);
  if (frontend || terminal || generation !== loadGeneration) return;

  const module: unknown = await import(
    /* webpackIgnore: true */ variant.frontend_url
  );
  if (!isWidgetModule(module)) throw new Error("invalid widget module");
  if (terminal || generation !== loadGeneration) return;
  frontend = module.mount(widgetElement, {
    widgetId: next.widget_id,
    variantId: next.variant_id,
    instanceId: next.id,
    options: next.options,
    inputs: inputBus.capability(),
    outputs: noOutputs,
    sharedState: stateBus.context(next.widget_id),
    send: (payload) =>
      connection
        ? connection.sendWidget(next.id, payload)
        : Promise.reject(new Error("runtime connection is unavailable")),
  });
  frontend.setPresentation?.(presentation);
  document.title = `${descriptor.name} - dashboardd`;
  if (hasPendingUpdate) {
    frontend.update(pendingUpdate);
    pendingUpdate = undefined;
    hasPendingUpdate = false;
  }
}

async function restart(): Promise<void> {
  if (terminal || !resource || !connection) return;
  restartButton.disabled = true;
  try {
    renderHealth(await connection.restartWidget(resource.id));
  } catch (error) {
    showHealthMessage(errorMessage(error));
  } finally {
    restartButton.disabled = false;
  }
}

function renderHealth(health: InstanceHealth): void {
  if (!["degraded", "stale", "failed"].includes(health.status)) {
    healthElement.hidden = true;
    return;
  }
  const detail = health.last_error?.message;
  healthMessage.textContent = detail
    ? `${health.status}: ${detail}`
    : `Widget backend is ${health.status}`;
  healthElement.hidden = false;
}

function showHealthMessage(message: string): void {
  if (terminal) return;
  healthMessage.textContent = message;
  healthElement.hidden = false;
}

function showUnavailable(message: string): void {
  terminal = true;
  loadGeneration += 1;
  connection?.close();
  frontend?.destroy();
  frontend = null;
  resource = null;
  widgetElement.replaceChildren();
  widgetElement.hidden = true;
  healthElement.hidden = true;
  unavailableMessage.textContent = message;
  unavailableElement.hidden = false;
}

function applyTheme(theme: Theme): void {
  for (const [name, value] of Object.entries(theme)) {
    if (name === "fonts") continue;
    document.documentElement.style.setProperty(
      `--dashboardd-color-${name.replaceAll("_", "-")}`,
      value as string,
    );
  }
  document.documentElement.style.setProperty(
    "--dashboardd-font-sans",
    `"${theme.fonts.sans}", ui-sans-serif, system-ui, sans-serif`,
  );
  document.documentElement.style.setProperty(
    "--dashboardd-font-mono",
    `"${theme.fonts.mono}", ui-monospace, monospace`,
  );
}

function parseInstanceId(pathname: string): string {
  const match = /^\/surface\/([^/]+)$/.exec(pathname);
  if (!match) throw new Error("Invalid standalone surface route.");
  const id = decodeURIComponent(match[1]);
  if (!/^instance-[0-9a-f-]+$/.test(id))
    throw new Error("Invalid runtime instance ID.");
  return id;
}

function parsePresentation(params: URLSearchParams): "focus" | "tile" {
  const values = params.getAll("presentation");
  if (values.length === 0) return "focus";
  if (values.length !== 1 || !["focus", "tile"].includes(values[0]))
    throw new Error("Invalid widget presentation.");
  return values[0] as "focus" | "tile";
}

class DirectInputBus {
  private inputs: Record<string, TypedInput> = {};
  private handlers = new Map<
    string,
    Set<(value: unknown | undefined) => void>
  >();

  capability(): WidgetInputs {
    return {
      get: (input) => this.inputs[input]?.value,
      subscribe: (input, handler) => {
        let handlers = this.handlers.get(input);
        if (!handlers) {
          handlers = new Set();
          this.handlers.set(input, handlers);
        }
        handlers.add(handler);
        handler(this.inputs[input]?.value);
        return () => {
          handlers?.delete(handler);
          if (handlers?.size === 0) this.handlers.delete(input);
        };
      },
    };
  }

  set(inputs: Record<string, TypedInput>): void {
    const previous = this.inputs;
    this.inputs = inputs;
    for (const input of new Set([
      ...Object.keys(previous),
      ...Object.keys(inputs),
    ])) {
      if (sameValue(previous[input]?.value, inputs[input]?.value)) continue;
      for (const handler of this.handlers.get(input) ?? [])
        handler(inputs[input]?.value);
    }
  }
}

const inputBus = new DirectInputBus();
const noOutputs: WidgetOutputs = { publish() {} };

async function responseError(response: Response): Promise<Error> {
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(
    value?.error?.message ?? `${response.status} ${response.statusText}`,
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

window.addEventListener("beforeunload", () => {
  frontend?.destroy();
  connection?.close();
});
