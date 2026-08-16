/** Public value types accepted by manifest options. */
export type WidgetOptionValue = boolean | number | string;
/** Effective options validated for one widget variant. */
export type WidgetOptions = Readonly<Record<string, WidgetOptionValue>>;

/** Page-local typed links between placed widget instances. */
export interface WidgetLinks {
  /** Publishes the current value of a declared output port. */
  publish(output: string, payload: unknown): void;
  /** Subscribes to a declared input port and returns its cleanup function. */
  subscribe(input: string, handler: (payload: unknown) => void): () => void;
}

/** Persisted package-wide public JSON state. */
export interface WidgetSharedState {
  /** Returns the current value. */
  get(): unknown;
  /** Subscribes to synchronized values and returns its cleanup function. */
  subscribe(handler: (value: unknown) => void): () => void;
  /** Applies a deterministic update and retries revision conflicts. */
  mutate(update: (current: unknown) => unknown): Promise<void>;
}

/** Immutable host capabilities supplied to one frontend mount. */
export interface WidgetContext {
  widgetId: string;
  variantId: string;
  instanceId: string;
  options: WidgetOptions;
  links: WidgetLinks;
  sharedState: WidgetSharedState;
  /** Sends widget-owned JSON to the backend without waiting for backend work. */
  send(payload: unknown): Promise<void>;
}

/** Current host surface used by an existing frontend mount. */
export type WidgetPresentation = "tile" | "focus";

/** Lifecycle returned by a mounted widget frontend. */
export interface WidgetFrontend {
  /** Receives widget-owned JSON published by the backend. */
  update(payload: unknown): void;
  /** Updates the host surface without remounting the frontend. */
  setPresentation?(presentation: WidgetPresentation): void;
  /** Releases every listener, subscription, timer, and owned DOM node. */
  destroy(): void;
}

/** ES module shape loaded for one installed frontend variant. */
export interface WidgetModule {
  mount(container: HTMLElement, context: WidgetContext): WidgetFrontend;
}

/** Checks the runtime shape required from a loaded frontend module. */
export function isWidgetModule(value: unknown): value is WidgetModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "mount" in value &&
    typeof value.mount === "function"
  );
}
