import { invoke } from "@tauri-apps/api/core";
import "./launcher.css";

type InputPrompt = { id: string; name: string; type: string };
type LaunchDialog = { title: string; inputs: InputPrompt[] };

const title = required<HTMLElement>("#title");
const form = required<HTMLFormElement>("#launcher-form");
const inputs = required<HTMLElement>("#inputs");
const errorElement = required<HTMLElement>("#error");
const cancel = required<HTMLButtonElement>("#cancel");
const open = required<HTMLButtonElement>("#open");

async function start(): Promise<void> {
  try {
    const dialog = await invoke<LaunchDialog>("launcher_initialize");
    title.textContent = dialog.title;
    document.title = `${dialog.title} - dashboardd`;
    for (const prompt of dialog.inputs) inputs.append(inputField(prompt));
    inputs.querySelector("textarea")?.focus();
  } catch (error) {
    showError(message(error));
    open.disabled = true;
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

void start();
