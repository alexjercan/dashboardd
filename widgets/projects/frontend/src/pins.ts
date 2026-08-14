import type { WidgetSharedState } from "@scufris/widget-sdk";

export const MAX_PINS = 3;

export type ProjectPin = {
  project_id: string;
  project: string;
};

export function parsePins(value: unknown): ProjectPin[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.pins) ||
    value.pins.length > MAX_PINS
  )
    return [];
  const pins: ProjectPin[] = [];
  for (const candidate of value.pins) {
    if (
      !isRecord(candidate) ||
      typeof candidate.project_id !== "string" ||
      !candidate.project_id.startsWith("project-") ||
      candidate.project_id.length > 128 ||
      typeof candidate.project !== "string" ||
      candidate.project.length === 0 ||
      candidate.project.length > 256 ||
      pins.some((pin) => pin.project_id === candidate.project_id)
    )
      return [];
    pins.push({
      project_id: candidate.project_id,
      project: candidate.project,
    });
  }
  return pins;
}

export function togglePin(
  sharedState: WidgetSharedState,
  project: ProjectPin,
): Promise<void> {
  return sharedState.mutate((value) => {
    const pins = parsePins(value);
    const existing = pins.findIndex(
      (pin) => pin.project_id === project.project_id,
    );
    if (existing >= 0) pins.splice(existing, 1);
    else if (pins.length < MAX_PINS) pins.push(project);
    return { pins };
  });
}

export function movePin(
  sharedState: WidgetSharedState,
  projectId: string,
  direction: -1 | 1,
): Promise<void> {
  return sharedState.mutate((value) => {
    const pins = parsePins(value);
    const source = pins.findIndex((pin) => pin.project_id === projectId);
    const target = source + direction;
    if (source >= 0 && target >= 0 && target < pins.length)
      [pins[source], pins[target]] = [pins[target], pins[source]];
    return { pins };
  });
}

export function createPinButton(
  pin: ProjectPin,
  pinned: boolean,
  disabled: boolean,
  activate: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pin-button";
  button.classList.toggle("pinned", pinned);
  button.disabled = disabled;
  button.setAttribute(
    "aria-label",
    `${pinned ? "Unpin" : "Pin"} ${pin.project}`,
  );
  button.title = disabled
    ? "Pinned project limit reached"
    : `${pinned ? "Unpin" : "Pin"} ${pin.project}`;
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9Z"></path></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    activate();
  });
  return button;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
