export type WidgetOptionValue = boolean | number | string;
export type WidgetOptions = Readonly<Record<string, WidgetOptionValue>>;

export interface WidgetContext {
  widgetId: string;
  variantId: string;
  instanceId: string;
  options: WidgetOptions;
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
