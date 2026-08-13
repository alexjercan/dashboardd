export interface WidgetContext {
  widgetId: string;
  instanceId: string;
  send(payload: unknown): Promise<void>;
}

export interface WidgetFrontend {
  update(payload: unknown): void;
  destroy(): void;
}

export interface WidgetModule {
  mount(container: HTMLElement, context: WidgetContext): WidgetFrontend;
}

export function isWidgetModule(value: unknown): value is WidgetModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "mount" in value &&
    typeof value.mount === "function"
  );
}
