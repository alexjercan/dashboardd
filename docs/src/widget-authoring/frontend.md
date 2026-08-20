# Frontend contract

A frontend variant is a self-contained browser ES module that exports `mount`:

```ts
export interface WidgetModule {
  mount(container: HTMLElement, context: WidgetContext): WidgetFrontend;
}
```

The supported TypeScript API is provided by `@dashboardd/widget-sdk`. dashboardd builds it as a versioned npm tarball containing JavaScript, TypeScript declarations, and public CSS assets.

Build and install a local artifact:

```bash
nix build .#widget-sdk
npm install ./result/dashboardd-widget-sdk-0.1.0.tgz
```

Tagged dashboardd releases attach the same tested tarball to GitHub Releases. External repositories must depend on a versioned artifact, not a dashboardd source path.

## Context

```ts
export interface WidgetContext {
  widgetId: string;
  variantId: string;
  instanceId: string;
  options: Readonly<Record<string, boolean | number | string>>;
  inputs: WidgetInputs;
  outputs: WidgetOutputs;
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

## Inputs and outputs

```ts
interface WidgetInputs {
  get(input: string): unknown | undefined;
  subscribe(
    input: string,
    handler: (payload: unknown | undefined) => void,
  ): () => void;
}

interface WidgetOutputs {
  publish(output: string, payload: unknown): void;
}
```

Inputs and outputs are typed in the runtime manifest. A host can supply an input from a direct typed value or a dynamic output link. `get()` returns the effective value. `subscribe()` supplies the effective value immediately and uses `undefined` when the input is unbound or removed. Call the cleanup function from `destroy()`.

Direct values use `{ "type": "<manifest-type>", "value": <opaque-json> }`. dashboardd validates the exact type string but leaves the JSON value opaque. Values and dynamic output payloads are public browser data. Do not include secrets or filesystem paths.

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

Use the public CSS exports rather than copying dashboard internals:

```ts
import widgetReset from "@dashboardd/widget-sdk/widget.css";
```

`theme.css` defines supported dashboard custom properties for dashboard-compatible hosts and development previews. Widgets inherit those variables from dashboardd without importing the file. `widget.css` provides the Shadow DOM host and box-sizing reset. A bundler must load that import as a source string when it is inserted into a Shadow root.

`--dashboardd-focus-control-clearance` is `0px` in tiles and `52px` in Focus. A focus-capable widget must reserve this inline-end space in its top control row so the shell-owned Focus control does not cover widget controls. Do not apply it to the complete widget width.

Keep important tile text readable and reserve detailed controls for Focus.
