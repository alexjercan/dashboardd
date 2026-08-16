# @dashboardd/widget-sdk

Frontend types, lifecycle helpers, and shared styles for dashboardd widgets.

## Install

```bash
npm install ./dashboardd-widget-sdk-0.1.0.tgz
```

## Use

```ts
import type {
  WidgetContext,
  WidgetFrontend,
} from "@dashboardd/widget-sdk";
import widgetReset from "@dashboardd/widget-sdk/widget.css";

export function mount(
  container: HTMLElement,
  context: WidgetContext,
): WidgetFrontend {
  const shadow = container.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${widgetReset}</style><p>Waiting...</p>`;
  return {
    update(payload: unknown) {
      shadow.querySelector("p")!.textContent = JSON.stringify(payload);
    },
    destroy() {
      shadow.replaceChildren();
    },
  };
}
```

See the [frontend contract](https://alexjercan.github.io/dashboardd/widget-authoring/frontend.html) for lifecycle, options, links, shared state, Focus, and bundling rules.
