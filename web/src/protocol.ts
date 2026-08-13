export const EVENT_VERSION = 1;

export type DashboardLayout = { columns: number };

export type WidgetVariant = {
  id: string;
  name: string;
  width: number;
  height: number;
  frontend_url: string;
};

export type WidgetDescriptor = {
  id: string;
  name: string;
  variants: WidgetVariant[];
};

export type InstanceLayout = {
  column: number;
  row: number;
  width: number;
  height: number;
};

export type Instance = {
  id: string;
  widget_id: string;
  variant_id: string;
  layout: InstanceLayout;
};

export type WidgetList = { widgets: WidgetDescriptor[] };
export type InstanceList = { instances: Instance[] };
export type ErrorResponse = { error: { code: string; message: string } };

type InstanceCreatedEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_created";
  data: { instance: Instance };
};
type InstanceUpdatedEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_updated";
  data: { instance: Instance };
};
type InstanceDestroyedEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_destroyed";
  data: { instance_id: string };
};
type InstanceErrorEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_error";
  data: {
    instance_id: string | null;
    error: { code: string; message: string };
  };
};
type WidgetUpdateEvent = {
  version: typeof EVENT_VERSION;
  kind: "widget_update";
  data: { instance_id: string; payload: unknown };
};

export type DashboardEvent =
  | InstanceCreatedEvent
  | InstanceUpdatedEvent
  | InstanceDestroyedEvent
  | InstanceErrorEvent
  | WidgetUpdateEvent;

export function parseDashboardLayout(value: unknown): DashboardLayout {
  if (!isRecord(value) || !isPositiveInteger(value.columns))
    throw new Error("invalid dashboard layout");
  return { columns: value.columns };
}

export function parseWidgetList(value: unknown): WidgetList {
  if (!isRecord(value) || !Array.isArray(value.widgets))
    throw new Error("invalid widget list");
  return { widgets: value.widgets.map(parseWidget) };
}

export function parseInstanceList(value: unknown): InstanceList {
  if (!isRecord(value) || !Array.isArray(value.instances))
    throw new Error("invalid instance list");
  return { instances: value.instances.map(parseInstance) };
}

export function parseInstance(value: unknown): Instance {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.widget_id !== "string" ||
    typeof value.variant_id !== "string" ||
    !isRecord(value.layout) ||
    !isNumber(value.layout.column) ||
    !isNumber(value.layout.row) ||
    !isNumber(value.layout.width) ||
    !isNumber(value.layout.height)
  )
    throw new Error("invalid instance");
  return {
    id: value.id,
    widget_id: value.widget_id,
    variant_id: value.variant_id,
    layout: {
      column: value.layout.column,
      row: value.layout.row,
      width: value.layout.width,
      height: value.layout.height,
    },
  };
}

export function parseDashboardEvent(value: unknown): DashboardEvent {
  if (
    !isRecord(value) ||
    value.version !== EVENT_VERSION ||
    typeof value.kind !== "string" ||
    !isRecord(value.data)
  )
    throw new Error("invalid dashboard event");
  switch (value.kind) {
    case "instance_created":
    case "instance_updated":
      return {
        version: EVENT_VERSION,
        kind: value.kind,
        data: { instance: parseInstance(value.data.instance) },
      };
    case "instance_destroyed":
      if (typeof value.data.instance_id === "string")
        return {
          version: EVENT_VERSION,
          kind: value.kind,
          data: { instance_id: value.data.instance_id },
        };
      break;
    case "instance_error":
      if (
        (value.data.instance_id === null ||
          typeof value.data.instance_id === "string") &&
        isError(value.data.error)
      )
        return {
          version: EVENT_VERSION,
          kind: value.kind,
          data: {
            instance_id: value.data.instance_id,
            error: value.data.error,
          },
        };
      break;
    case "widget_update":
      if (typeof value.data.instance_id === "string")
        return {
          version: EVENT_VERSION,
          kind: value.kind,
          data: {
            instance_id: value.data.instance_id,
            payload: value.data.payload,
          },
        };
      break;
  }
  throw new Error("unknown dashboard event");
}

function parseWidget(value: unknown): WidgetDescriptor {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.variants)
  )
    throw new Error("invalid widget descriptor");
  return {
    id: value.id,
    name: value.name,
    variants: value.variants.map(parseVariant),
  };
}

function parseVariant(value: unknown): WidgetVariant {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    typeof value.frontend_url !== "string"
  )
    throw new Error("invalid widget variant");
  return {
    id: value.id,
    name: value.name,
    width: value.width,
    height: value.height,
    frontend_url: value.frontend_url,
  };
}

function isError(value: unknown): value is ErrorResponse["error"] {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
