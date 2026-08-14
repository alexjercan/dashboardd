import type { WidgetContext, WidgetFrontend } from "@scufris/widget-sdk";
import { mountUsage } from "./shared";
export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  return mountUsage(container, context, "minimal");
}
