export const PROTOCOL_VERSION = 1;

type EmptyData = Record<string, never>;

type HelloMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: "hello";
  data: EmptyData;
};

type ListWidgetsMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: "list_widgets";
  data: { request_id: string };
};

type CreateInstanceMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: "create_instance";
  data: { request_id: string; widget_id: string };
};

type WidgetMessageToServer = {
  version: typeof PROTOCOL_VERSION;
  kind: "widget_message";
  data: { instance_id: string; payload: unknown };
};

export type DashboardToServer =
  | HelloMessage
  | ListWidgetsMessage
  | CreateInstanceMessage
  | WidgetMessageToServer;

export type WidgetDescriptor = {
  id: string;
  name: string;
  frontend_url: string;
};

type ReadyMessage = {
  version: number;
  kind: "ready";
  data: EmptyData;
};

type WidgetsMessage = {
  version: number;
  kind: "widgets";
  data: { request_id: string; widgets: WidgetDescriptor[] };
};

type InstanceCreatedMessage = {
  version: number;
  kind: "instance_created";
  data: { request_id: string; instance_id: string; widget_id: string };
};

type WidgetMessage = {
  version: number;
  kind: "widget_message";
  data: { instance_id: string; payload: unknown };
};

type ErrorMessage = {
  version: number;
  kind: "error";
  data: {
    request_id: string | null;
    error: {
      code: string;
      message: string;
    };
  };
};

export type ServerToDashboard =
  | ReadyMessage
  | WidgetsMessage
  | InstanceCreatedMessage
  | WidgetMessage
  | ErrorMessage;

export function helloMessage(): DashboardToServer {
  return envelope("hello", {});
}

export function listWidgetsMessage(requestId: string): DashboardToServer {
  return envelope("list_widgets", { request_id: requestId });
}

export function createInstanceMessage(
  requestId: string,
  widgetId: string,
): DashboardToServer {
  return envelope("create_instance", {
    request_id: requestId,
    widget_id: widgetId,
  });
}

export function widgetMessage(
  instanceId: string,
  payload: unknown,
): DashboardToServer {
  return envelope("widget_message", {
    instance_id: instanceId,
    payload,
  });
}

export function parseServerMessage(value: unknown): ServerToDashboard {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    throw new Error("unsupported dashboard protocol version");
  }

  if (
    [
      "ready",
      "widgets",
      "instance_created",
      "widget_message",
      "error",
    ].includes(String(value.kind)) &&
    isRecord(value.data)
  ) {
    return value as unknown as ServerToDashboard;
  }

  throw new Error("unknown dashboard message");
}

function envelope<K extends string, D>(
  kind: K,
  data: D,
): { version: typeof PROTOCOL_VERSION; kind: K; data: D } {
  return { version: PROTOCOL_VERSION, kind, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
