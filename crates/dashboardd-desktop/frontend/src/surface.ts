import { Channel, invoke } from "@tauri-apps/api/core";
import {
  isWidgetModule,
  type WidgetFrontend,
  type WidgetInputs,
  type WidgetOutputs,
  type WidgetSharedState,
} from "@dashboardd/widget-sdk";
import "./surface.css";

type Presentation = "focus" | "tile";
type TypedInput = { type: string; value: unknown };
type Health = {
  instance_id: string;
  status: "starting" | "healthy" | "stale" | "degraded" | "failed";
  last_error: { message: string } | null;
};
type Theme = Record<string, string | { sans: string; mono: string }> & {
  fonts: { sans: string; mono: string };
};
type Snapshot = {
  instance: {
    id: string;
    widget_id: string;
    variant_id: string;
    options: Record<string, boolean | number | string>;
    inputs: Record<string, TypedInput>;
  };
  widget_name: string;
  frontend_url: string;
  presentation: Presentation;
  theme: Theme;
  health: Health;
  state: StateSnapshot;
};
type StateSnapshot = { revision: number; value: unknown };
type StateMutation =
  | { status: "updated"; state: StateSnapshot }
  | { status: "conflict"; state: StateSnapshot };
type SurfaceEvent = { kind: string; data: Record<string, unknown> };

const widgetElement = required<HTMLElement>("#widget");
const healthElement = required<HTMLElement>("#health");
const healthMessage = required<HTMLElement>("#health-message");
const restartButton = required<HTMLButtonElement>("#restart");
const unavailableElement = required<HTMLElement>("#unavailable");
const unavailableMessage = required<HTMLElement>("#unavailable-message");
const noOutputs: WidgetOutputs = { publish() {} };

let snapshot: Snapshot | undefined;
let frontend: WidgetFrontend | undefined;
let pendingUpdate: unknown;
let hasPendingUpdate = false;
let terminal = false;

async function start(): Promise<void> {
  try {
    snapshot = await invoke<Snapshot>("surface_initialize");
    const events = new Channel<SurfaceEvent>();
    events.onmessage = handleEvent;
    await invoke("surface_subscribe", { onEvent: events });
    snapshot = await invoke<Snapshot>("surface_initialize");
    inputBus.set(snapshot.instance.inputs);
    stateBus.set(snapshot.state);
    applyTheme(snapshot.theme);
    renderHealth(snapshot.health);
    widgetElement.dataset.presentation = snapshot.presentation;

    const module: unknown = await import(
      /* webpackIgnore: true */ snapshot.frontend_url
    );
    if (!isWidgetModule(module)) throw new Error("invalid widget module");
    if (terminal) return;
    frontend = module.mount(widgetElement, {
      widgetId: snapshot.instance.widget_id,
      variantId: snapshot.instance.variant_id,
      instanceId: snapshot.instance.id,
      options: snapshot.instance.options,
      inputs: inputBus.capability(),
      outputs: noOutputs,
      sharedState: stateBus.capability(),
      send: (payload) => invoke("surface_send", { payload }),
    });
    frontend.setPresentation?.(snapshot.presentation);
    document.title = `${snapshot.widget_name} - dashboardd`;
    if (hasPendingUpdate) {
      frontend.update(pendingUpdate);
      pendingUpdate = undefined;
      hasPendingUpdate = false;
    }
    restartButton.addEventListener("click", () => void restart());
  } catch (error) {
    showUnavailable(errorMessage(error));
  }
}

function handleEvent(event: SurfaceEvent): void {
  if (terminal) return;
  switch (event.kind) {
    case "instance_inputs_updated": {
      const inputs = event.data.inputs as Record<string, TypedInput>;
      if (snapshot) snapshot.instance.inputs = inputs;
      inputBus.set(inputs);
      break;
    }
    case "instance_health_updated":
      renderHealth(event.data.health as Health);
      break;
    case "widget_update":
      if (frontend) frontend.update(event.data.payload);
      else {
        pendingUpdate = event.data.payload;
        hasPendingUpdate = true;
      }
      break;
    case "widget_state_updated":
      stateBus.set({
        revision: event.data.revision as number,
        value: event.data.value,
      });
      break;
    case "theme_updated":
      applyTheme(event.data.theme as Theme);
      break;
    case "presentation_updated": {
      const presentation = event.data.presentation as Presentation;
      if (snapshot) snapshot.presentation = presentation;
      widgetElement.dataset.presentation = presentation;
      frontend?.setPresentation?.(presentation);
      break;
    }
    case "instance_destroyed":
      showUnavailable("The runtime instance was deleted.");
      break;
    case "instance_error": {
      const error = event.data.error as { message: string };
      showHealthMessage(error.message);
      break;
    }
    case "configuration_error": {
      const error = event.data.error as { message: string };
      showHealthMessage(error.message);
      break;
    }
  }
}

async function restart(): Promise<void> {
  restartButton.disabled = true;
  try {
    renderHealth(await invoke<Health>("surface_restart"));
  } catch (error) {
    showHealthMessage(errorMessage(error));
  } finally {
    restartButton.disabled = false;
  }
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

class SharedStateBus {
  private state: StateSnapshot = { revision: 0, value: {} };
  private handlers = new Set<(value: unknown) => void>();
  private mutations = Promise.resolve();

  capability(): WidgetSharedState {
    return {
      get: () => this.state.value,
      subscribe: (handler) => {
        this.handlers.add(handler);
        handler(this.state.value);
        return () => this.handlers.delete(handler);
      },
      mutate: (update) => {
        const operation = this.mutations.then(() => this.mutate(update));
        this.mutations = operation.catch(() => undefined);
        return operation;
      },
    };
  }

  set(state: StateSnapshot): void {
    if (state.revision < this.state.revision) return;
    const changed = !sameValue(this.state.value, state.value);
    this.state = state;
    if (changed) for (const handler of this.handlers) handler(state.value);
  }

  private async mutate(update: (current: unknown) => unknown): Promise<void> {
    for (;;) {
      const value = update(this.state.value);
      const result = await invoke<StateMutation>("surface_mutate_state", {
        revision: this.state.revision,
        value,
      });
      this.set(result.state);
      if (result.status === "updated") return;
    }
  }
}

const inputBus = new DirectInputBus();
const stateBus = new SharedStateBus();
void start();

function renderHealth(health: Health): void {
  if (!["degraded", "stale", "failed"].includes(health.status)) {
    healthElement.hidden = true;
    return;
  }
  healthMessage.textContent = health.last_error?.message
    ? `${health.status}: ${health.last_error.message}`
    : `Widget backend is ${health.status}`;
  healthElement.hidden = false;
}

function showHealthMessage(message: string): void {
  healthMessage.textContent = message;
  healthElement.hidden = false;
}

function showUnavailable(message: string): void {
  if (terminal) return;
  terminal = true;
  frontend?.destroy();
  frontend = undefined;
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

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element ${selector}`);
  return element;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
