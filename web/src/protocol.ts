export const EVENT_VERSION = 1;

export type DashboardLayout = { columns: number };

export type Theme = {
  fonts: { sans: string; mono: string };
  canvas: string;
  surface: string;
  selection: string;
  text: string;
  text_bright: string;
  text_muted: string;
  text_dim: string;
  accent: string;
  border: string;
  success: string;
  danger: string;
  secondary: string;
};

export type WidgetVariant = {
  id: string;
  name: string;
  width: number;
  height: number;
  frontend_url: string;
  focus: boolean;
};

export type WidgetOptionChoice = { value: string; name: string };
export type WidgetOption = {
  id: string;
  name: string;
  description: string;
  variants: string[];
  default: boolean | number | string;
} & (
  | { type: "boolean" }
  | { type: "text" }
  | { type: "integer"; minimum: number; maximum: number; step: number }
  | { type: "select"; choices: WidgetOptionChoice[] }
);

export type WidgetLinkPort = {
  id: string;
  name: string;
  type: string;
  variants: string[];
  required: boolean;
};

export type WidgetDescriptor = {
  id: string;
  name: string;
  description: string;
  variants: WidgetVariant[];
  options: WidgetOption[];
  inputs: WidgetLinkPort[];
  outputs: WidgetLinkPort[];
};

export type InstanceLayout = {
  column: number;
  row: number;
  width: number;
  height: number;
};

export type HealthStatus =
  "starting" | "healthy" | "stale" | "degraded" | "failed";

export type InstanceHealth = {
  instance_id: string;
  status: HealthStatus;
  started_at: string;
  last_update_at: string | null;
  last_error: { code: string; message: string; at: string } | null;
  restart_count: number;
};

export type DashboardLink = {
  source_instance_id: string;
  source_port: string;
  target_instance_id: string;
  target_port: string;
};

export type Instance = {
  id: string;
  widget_id: string;
  variant_id: string;
  layout: InstanceLayout;
  options: Record<string, boolean | number | string>;
};

export type WidgetList = { widgets: WidgetDescriptor[] };
export type InstanceList = { instances: Instance[] };
export type InstanceHealthList = { instances: InstanceHealth[] };
export type LinkList = { links: DashboardLink[] };
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
type LinkUpdatedEvent = {
  version: typeof EVENT_VERSION;
  kind: "link_updated";
  data: { link: DashboardLink };
};
type LinkDestroyedEvent = {
  version: typeof EVENT_VERSION;
  kind: "link_destroyed";
  data: { target_instance_id: string; target_port: string };
};
type InstanceErrorEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_error";
  data: {
    instance_id: string | null;
    error: { code: string; message: string };
  };
};
type InstanceHealthUpdatedEvent = {
  version: typeof EVENT_VERSION;
  kind: "instance_health_updated";
  data: { health: InstanceHealth };
};
type WidgetUpdateEvent = {
  version: typeof EVENT_VERSION;
  kind: "widget_update";
  data: { instance_id: string; payload: unknown };
};
type ThemeUpdatedEvent = {
  version: typeof EVENT_VERSION;
  kind: "theme_updated";
  data: { theme: Theme };
};
type ConfigurationErrorEvent = {
  version: typeof EVENT_VERSION;
  kind: "configuration_error";
  data: { error: ErrorResponse["error"] };
};

export type DashboardEvent =
  | InstanceCreatedEvent
  | InstanceUpdatedEvent
  | InstanceDestroyedEvent
  | LinkUpdatedEvent
  | LinkDestroyedEvent
  | InstanceErrorEvent
  | InstanceHealthUpdatedEvent
  | WidgetUpdateEvent
  | ThemeUpdatedEvent
  | ConfigurationErrorEvent;

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

export function parseInstanceHealthList(value: unknown): InstanceHealthList {
  if (!isRecord(value) || !Array.isArray(value.instances))
    throw new Error("invalid instance health list");
  return { instances: value.instances.map(parseInstanceHealth) };
}

export function parseInstanceHealth(value: unknown): InstanceHealth {
  if (
    !isRecord(value) ||
    typeof value.instance_id !== "string" ||
    !isHealthStatus(value.status) ||
    typeof value.started_at !== "string" ||
    (value.last_update_at !== null &&
      typeof value.last_update_at !== "string") ||
    (value.last_error !== null && !isHealthError(value.last_error)) ||
    !Number.isSafeInteger(value.restart_count) ||
    (value.restart_count as number) < 0
  )
    throw new Error("invalid instance health");
  return value as InstanceHealth;
}

export function parseLinkList(value: unknown): LinkList {
  if (!isRecord(value) || !Array.isArray(value.links))
    throw new Error("invalid link list");
  return { links: value.links.map(parseLink) };
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
    !isNumber(value.layout.height) ||
    !isOptions(value.options)
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
    options: value.options,
  };
}

export function parseTheme(value: unknown): Theme {
  if (!isRecord(value)) throw new Error("invalid theme");
  const keys: Exclude<keyof Theme, "fonts">[] = [
    "canvas",
    "surface",
    "selection",
    "text",
    "text_bright",
    "text_muted",
    "text_dim",
    "accent",
    "border",
    "success",
    "danger",
    "secondary",
  ];
  if (
    !keys.every((key) => typeof value[key] === "string") ||
    !isRecord(value.fonts) ||
    typeof value.fonts.sans !== "string" ||
    typeof value.fonts.mono !== "string"
  )
    throw new Error("invalid theme");
  return {
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    fonts: { sans: value.fonts.sans, mono: value.fonts.mono },
  } as Theme;
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
    case "link_updated":
      return {
        version: EVENT_VERSION,
        kind: value.kind,
        data: { link: parseLink(value.data.link) },
      };
    case "link_destroyed":
      if (
        typeof value.data.target_instance_id === "string" &&
        typeof value.data.target_port === "string"
      )
        return {
          version: EVENT_VERSION,
          kind: value.kind,
          data: {
            target_instance_id: value.data.target_instance_id,
            target_port: value.data.target_port,
          },
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
    case "instance_health_updated":
      return {
        version: EVENT_VERSION,
        kind: value.kind,
        data: { health: parseInstanceHealth(value.data.health) },
      };
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
    case "theme_updated":
      return {
        version: EVENT_VERSION,
        kind: value.kind,
        data: { theme: parseTheme(value.data.theme) },
      };
    case "configuration_error":
      if (isError(value.data.error))
        return {
          version: EVENT_VERSION,
          kind: value.kind,
          data: { error: value.data.error },
        };
      break;
  }
  throw new Error("unknown dashboard event");
}

function parseLink(value: unknown): DashboardLink {
  if (
    !isRecord(value) ||
    typeof value.source_instance_id !== "string" ||
    typeof value.source_port !== "string" ||
    typeof value.target_instance_id !== "string" ||
    typeof value.target_port !== "string"
  )
    throw new Error("invalid dashboard link");
  return {
    source_instance_id: value.source_instance_id,
    source_port: value.source_port,
    target_instance_id: value.target_instance_id,
    target_port: value.target_port,
  };
}

function parseWidget(value: unknown): WidgetDescriptor {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.variants) ||
    !Array.isArray(value.options) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.outputs)
  )
    throw new Error("invalid widget descriptor");
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    variants: value.variants.map(parseVariant),
    options: value.options.map(parseOption),
    inputs: value.inputs.map(parseLinkPort),
    outputs: value.outputs.map(parseLinkPort),
  };
}

function parseLinkPort(value: unknown): WidgetLinkPort {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !Array.isArray(value.variants) ||
    !value.variants.every((variant) => typeof variant === "string") ||
    typeof value.required !== "boolean"
  )
    throw new Error("invalid widget link port");
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    variants: value.variants,
    required: value.required,
  };
}

function parseVariant(value: unknown): WidgetVariant {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    typeof value.frontend_url !== "string" ||
    typeof value.focus !== "boolean"
  )
    throw new Error("invalid widget variant");
  return {
    id: value.id,
    name: value.name,
    width: value.width,
    height: value.height,
    frontend_url: value.frontend_url,
    focus: value.focus,
  };
}

function parseOption(value: unknown): WidgetOption {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.variants) ||
    !value.variants.every((variant) => typeof variant === "string")
  )
    throw new Error("invalid widget option");
  const common = {
    id: value.id,
    name: value.name,
    description: value.description,
    variants: value.variants,
    default: value.default as boolean | number | string,
  };
  if (value.type === "boolean" && typeof value.default === "boolean")
    return { ...common, default: value.default, type: "boolean" };
  if (value.type === "text" && typeof value.default === "string")
    return { ...common, default: value.default, type: "text" };
  if (
    value.type === "integer" &&
    Number.isInteger(value.default) &&
    Number.isInteger(value.minimum) &&
    Number.isInteger(value.maximum) &&
    Number.isInteger(value.step)
  )
    return {
      ...common,
      default: value.default as number,
      type: "integer",
      minimum: value.minimum as number,
      maximum: value.maximum as number,
      step: value.step as number,
    };
  if (
    value.type === "select" &&
    typeof value.default === "string" &&
    Array.isArray(value.choices) &&
    value.choices.every(
      (choice) =>
        isRecord(choice) &&
        typeof choice.value === "string" &&
        typeof choice.name === "string",
    )
  )
    return {
      ...common,
      default: value.default,
      type: "select",
      choices: value.choices as WidgetOptionChoice[],
    };
  throw new Error("invalid widget option");
}

function isOptions(
  value: unknown,
): value is Record<string, boolean | number | string> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (option) =>
        typeof option === "boolean" ||
        typeof option === "string" ||
        (typeof option === "number" && Number.isFinite(option)),
    )
  );
}

function isHealthStatus(value: unknown): value is HealthStatus {
  return ["starting", "healthy", "stale", "degraded", "failed"].includes(
    value as string,
  );
}

function isHealthError(
  value: unknown,
): value is NonNullable<InstanceHealth["last_error"]> {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.at === "string"
  );
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
