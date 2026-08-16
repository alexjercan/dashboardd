import {
  isWidgetModule,
  type WidgetContext,
  type WidgetModule,
} from "@dashboardd/widget-sdk";
import theme from "@dashboardd/widget-sdk/theme.css";
import widgetReset from "@dashboardd/widget-sdk/widget.css";

export const fixture: WidgetModule = {
  mount(container: HTMLElement, context: WidgetContext) {
    container.textContent = `${context.widgetId}:${theme.length}:${widgetReset.length}`;
    return {
      update(payload: unknown) {
        container.textContent = JSON.stringify(payload);
      },
      destroy() {
        container.replaceChildren();
      },
    };
  },
};

if (!isWidgetModule(fixture))
  throw new Error("fixture must be a widget module");
