import { Channel, invoke } from "@tauri-apps/api/core";
import {
  isWidgetLaunchModule,
  type WidgetFrontend,
  type WidgetLaunchInput,
} from "@dashboardd/widget-sdk";
import "./launcher.css";

type InputPrompt = { id: string; name: string; type: string };
type Theme = Record<string, string | { sans: string; mono: string }> & {
  fonts: { sans: string; mono: string };
};
type Draft = {
  instance: {
    id: string;
    widget_id: string;
    variant_id: string;
    options: Record<string, boolean | number | string>;
  };
  widget_name: string;
  frontend_url: string;
  theme: Theme;
};
type LaunchDialog =
  | { mode: "json"; title: string; inputs: InputPrompt[] }
  | { mode: "custom"; title: string; draft: Draft };
type RuntimeEvent = { kind: string; data: Record<string, unknown> };

const title = required<HTMLElement>("#title");
const form = required<HTMLFormElement>("#launcher-form");
const inputs = required<HTMLElement>("#inputs");
const custom = required<HTMLElement>("#custom-launcher");
const errorElement = required<HTMLElement>("#error");
const cancel = required<HTMLButtonElement>("#cancel");
const open = required<HTMLButtonElement>("#open");
let frontend: WidgetFrontend | undefined;
let pendingUpdate: unknown;
let hasPendingUpdate = false;

async function start(): Promise<void> {
  try {
    const dialog = await invoke<LaunchDialog>("launcher_initialize");
    title.textContent = dialog.title;
    document.title = `${dialog.title} - dashboardd`;
    if (dialog.mode === "custom") await mountCustom(dialog.draft);
    else mountJson(dialog.inputs);
  } catch (error) {
    showError(message(error));
    open.disabled = true;
  }
}

function mountJson(prompts: InputPrompt[]): void {
  for (const prompt of prompts) inputs.append(inputField(prompt));
  inputs.querySelector("textarea")?.focus();
}

async function mountCustom(draft: Draft): Promise<void> {
  form.hidden = true;
  custom.hidden = false;
  applyTheme(draft.theme);
  const events = new Channel<RuntimeEvent>();
  events.onmessage = (event) => {
    if (event.kind === "widget_update") {
      if (frontend) frontend.update(event.data.payload);
      else {
        pendingUpdate = event.data.payload;
        hasPendingUpdate = true;
      }
    }
  };
  await invoke("launcher_subscribe", { onEvent: events });
  const module: unknown = await import(
    /* webpackIgnore: true */ draft.frontend_url
  );
  if (!isWidgetLaunchModule(module)) throw new Error("invalid launch frontend");
  frontend = module.mount(custom, {
    widgetId: draft.instance.widget_id,
    variantId: draft.instance.variant_id,
    instanceId: draft.instance.id,
    options: draft.instance.options,
    send: (payload) => invoke("launcher_send", { payload }),
    complete: (completedInputs: Record<string, WidgetLaunchInput>) =>
      invoke("launcher_complete", { inputs: completedInputs }),
    cancel: () => invoke("launcher_cancel"),
  });
  if (hasPendingUpdate) {
    frontend.update(pendingUpdate);
    pendingUpdate = undefined;
    hasPendingUpdate = false;
  }
}

function inputField(prompt: InputPrompt): HTMLElement {
  const field = document.createElement("label");
  field.className = "input-field";
  const name = document.createElement("strong");
  name.textContent = prompt.name;
  const type = document.createElement("code");
  type.textContent = prompt.type;
  const value = document.createElement("textarea");
  value.name = prompt.id;
  value.dataset.inputId = prompt.id;
  value.autocomplete = "off";
  value.spellcheck = false;
  value.placeholder = "Enter a JSON value";
  value.required = true;
  field.append(name, type, value);
  return field;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

cancel.addEventListener("click", () => {
  cancel.disabled = true;
  open.disabled = true;
  void invoke("launcher_cancel").catch((error) => {
    showError(message(error));
    cancel.disabled = false;
    open.disabled = false;
  });
});

async function submit(): Promise<void> {
  hideError();
  const values: Record<string, unknown> = {};
  for (const textarea of inputs.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-input-id]",
  )) {
    try {
      const value: unknown = JSON.parse(textarea.value);
      textarea.value = JSON.stringify(value, null, 2);
      values[textarea.dataset.inputId ?? ""] = value;
      textarea.removeAttribute("aria-invalid");
    } catch {
      textarea.setAttribute("aria-invalid", "true");
      textarea.focus();
      showError("Each input must contain one valid JSON value.");
      return;
    }
  }
  cancel.disabled = true;
  open.disabled = true;
  try {
    await invoke("launcher_submit", { values });
  } catch (error) {
    showError(message(error));
    cancel.disabled = false;
    open.disabled = false;
  }
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

function showError(text: string): void {
  errorElement.textContent = text;
  errorElement.hidden = false;
}

function hideError(): void {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}

window.addEventListener("beforeunload", () => frontend?.destroy());
void start();
