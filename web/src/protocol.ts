export const PROTOCOL_VERSION = 1;

type EmptyData = Record<string, never>;

export type DashboardToServer = {
  version: typeof PROTOCOL_VERSION;
  kind: "hello";
  data: EmptyData;
};

type ReadyMessage = {
  version: number;
  kind: "ready";
  data: EmptyData;
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

export type ServerToDashboard = ReadyMessage | ErrorMessage;

export function helloMessage(): DashboardToServer {
  return {
    version: PROTOCOL_VERSION,
    kind: "hello",
    data: {},
  };
}

export function parseServerMessage(value: unknown): ServerToDashboard {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    throw new Error("unsupported dashboard protocol version");
  }

  if (value.kind === "ready" && isRecord(value.data)) {
    return value as unknown as ReadyMessage;
  }

  if (value.kind === "error" && isRecord(value.data)) {
    return value as unknown as ErrorMessage;
  }

  throw new Error("unknown dashboard message");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
