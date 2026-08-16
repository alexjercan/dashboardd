# Frontend contract

A frontend variant is a self-contained browser ES module that exports `mount`:

```ts
export interface WidgetModule {
  mount(container: HTMLElement, context: WidgetContext): WidgetFrontend;
}
```

The supported TypeScript API is provided by `@dashboardd/widget-sdk`. The package is currently workspace-local. A built release artifact is required before external frontend publication.

## Context

```ts
export interface WidgetContext {
  widgetId: string;
  variantId: string;
  instanceId: string;
  options: Readonly<Record<string, boolean | number | string>>;
  links: WidgetLinks;
  sharedState: WidgetSharedState;
  send(payload: unknown): Promise<void>;
}
```

- IDs and options do not change during a mount.
- `send()` accepts widget-owned JSON and resolves after dashboardd accepts it. It does not wait for backend work.
- Frontends must validate backend payloads at runtime. TypeScript types do not validate JSON.

## Lifecycle

`mount()` returns:

```ts
export interface WidgetFrontend {
  update(payload: unknown): void;
  setPresentation?(presentation: "tile" | "focus"): void;
  destroy(): void;
}
```

- `update()` can run many times and receives backend-owned JSON.
- `setPresentation()` switches an existing mount between tile and Focus. It must not discard primary state.
- `destroy()` removes listeners, subscriptions, timers, observers, and other owned resources.
- A mount owns only the supplied container. Current bundled widgets attach one Shadow root for style isolation.

## Options

`context.options` contains dashboardd-validated effective values. It includes defaults for all options applicable to the active variant.

Options and frontend state are visible browser data. Do not place secrets or sensitive paths in either.

## Links

```ts
interface WidgetLinks {
  publish(output: string, payload: unknown): void;
  subscribe(input: string, handler: (payload: unknown) => void): () => void;
}
```

Links are typed in the runtime manifest. Payloads are page-local and reset on reload. `subscribe()` immediately supplies current state when available. Call the returned cleanup function from `destroy()`.

## Shared state

```ts
interface WidgetSharedState {
  get(): unknown;
  subscribe(handler: (value: unknown) => void): () => void;
  mutate(update: (current: unknown) => unknown): Promise<void>;
}
```

Shared state is package-wide persisted JSON. `mutate()` retries revision conflicts, so its callback must be deterministic and free of side effects. Shared state is public and must not contain credentials or filesystem paths.

## Bundling

Each variant URL serves one JavaScript file. Bundle all dependencies into it. Do not emit unresolved relative chunks, source paths, or runtime imports that dashboardd does not serve.

Use the SDK reset and theme CSS rather than copying dashboard internals. Keep important tile text readable and reserve detailed controls for Focus.
