import {
  parseInstanceList,
  parseRuntimeInstance,
  type RuntimeInstance,
  type WidgetDescriptor,
} from "./protocol";

export const DASHBOARD_STORAGE_KEY = "dashboardd.dashboards/v1";
export const BINDING_STORAGE_KEY = "dashboardd.instance-bindings/v1";
const STORE_VERSION = 1;
const MAX_DASHBOARDS = 32;

export type Position = { column: number; row: number };
export type InstanceLayout = Position & { width: number; height: number };

export type DashboardLink = {
  source_instance_id: string;
  source_port: string;
  target_instance_id: string;
  target_port: string;
};

export type DashboardPlacement = {
  id: string;
  widget_id: string;
  variant_id: string;
  position: Position;
  options: Record<string, boolean | number | string>;
};

export type DashboardDocument = {
  id: string;
  name: string;
  columns: number;
  placements: DashboardPlacement[];
  links: DashboardLink[];
};

export type Instance = {
  id: string;
  runtime_id: string;
  widget_id: string;
  variant_id: string;
  layout: InstanceLayout;
  options: Record<string, boolean | number | string>;
};

export type RuntimeSnapshot = {
  dashboards: DashboardDocument[];
  bindings: Map<string, string>;
  runtimeInstances: Map<string, RuntimeInstance>;
};

type DashboardStoreFile = {
  version: typeof STORE_VERSION;
  dashboards: DashboardDocument[];
};

type BindingStoreFile = {
  version: typeof STORE_VERSION;
  bindings: Record<string, string>;
};

let fallbackLock = Promise.resolve();
let idSequence = 0;

export function loadDashboards(): DashboardDocument[] {
  return loadDashboardStore().dashboards;
}

export function getDashboard(id: string): DashboardDocument | undefined {
  return loadDashboards().find((dashboard) => dashboard.id === id);
}

export async function createDashboard(
  name: string,
  columns: number,
): Promise<DashboardDocument> {
  return withStoreLock(async () => {
    const store = loadDashboardStore();
    if (store.dashboards.length >= MAX_DASHBOARDS)
      throw new Error("dashboard limit reached");
    const dashboard: DashboardDocument = {
      id: localId("dashboard"),
      name: normalizeName(name),
      columns: validateColumns(columns),
      placements: [],
      links: [],
    };
    store.dashboards.push(dashboard);
    saveDashboardStore(store);
    return dashboard;
  });
}

export async function updateDashboard(
  dashboardId: string,
  update: (dashboard: DashboardDocument) => void,
): Promise<DashboardDocument> {
  return withStoreLock(async () => {
    const store = loadDashboardStore();
    const dashboard = store.dashboards.find(
      (candidate) => candidate.id === dashboardId,
    );
    if (!dashboard) throw new Error("dashboard was not found");
    update(dashboard);
    dashboard.name = normalizeName(dashboard.name);
    dashboard.columns = validateColumns(dashboard.columns);
    saveDashboardStore(store);
    return structuredClone(dashboard);
  });
}

export async function duplicateDashboard(
  dashboardId: string,
): Promise<DashboardDocument> {
  return withStoreLock(async () => {
    const store = loadDashboardStore();
    if (store.dashboards.length >= MAX_DASHBOARDS)
      throw new Error("dashboard limit reached");
    const source = store.dashboards.find(
      (dashboard) => dashboard.id === dashboardId,
    );
    if (!source) throw new Error("dashboard was not found");
    const idMap = new Map<string, string>();
    const placements = source.placements.map((placement) => {
      const id = localId("placement");
      idMap.set(placement.id, id);
      return { ...structuredClone(placement), id };
    });
    const dashboard: DashboardDocument = {
      id: localId("dashboard"),
      name: duplicateName(
        source.name,
        store.dashboards.map(({ name }) => name),
      ),
      columns: source.columns,
      placements,
      links: source.links.map((link) => ({
        ...link,
        source_instance_id: idMap.get(link.source_instance_id)!,
        target_instance_id: idMap.get(link.target_instance_id)!,
      })),
    };
    store.dashboards.push(dashboard);
    saveDashboardStore(store);
    return dashboard;
  });
}

export async function deleteDashboard(dashboardId: string): Promise<void> {
  const runtimeIds = await withStoreLock(async () => {
    const store = loadDashboardStore();
    const dashboard = store.dashboards.find(
      (candidate) => candidate.id === dashboardId,
    );
    if (!dashboard) throw new Error("dashboard was not found");
    const bindings = loadBindingStore();
    const runtimeIds = dashboard.placements.flatMap((placement) => {
      const runtimeId = bindings.bindings[placement.id];
      delete bindings.bindings[placement.id];
      return runtimeId ? [runtimeId] : [];
    });
    store.dashboards = store.dashboards.filter(
      (candidate) => candidate.id !== dashboardId,
    );
    saveDashboardStore(store);
    saveBindingStore(bindings);
    return runtimeIds;
  });
  await Promise.all(runtimeIds.map(deleteRuntimeInstance));
}

export async function addPlacement(
  dashboardId: string,
  placement: Omit<DashboardPlacement, "id">,
  links: Array<Omit<DashboardLink, "target_instance_id">>,
): Promise<DashboardPlacement> {
  const created: DashboardPlacement = {
    ...placement,
    id: localId("placement"),
  };
  await updateDashboard(dashboardId, (dashboard) => {
    dashboard.placements.push(created);
    dashboard.links.push(
      ...links.map((link) => ({
        ...link,
        target_instance_id: created.id,
      })),
    );
  });
  return created;
}

export async function removePlacement(
  dashboardId: string,
  placementId: string,
): Promise<void> {
  const runtimeId = await withStoreLock(async () => {
    const store = loadDashboardStore();
    const dashboard = store.dashboards.find(
      (candidate) => candidate.id === dashboardId,
    );
    if (!dashboard) throw new Error("dashboard was not found");
    if (!dashboard.placements.some(({ id }) => id === placementId))
      throw new Error("widget placement was not found");
    dashboard.placements = dashboard.placements.filter(
      ({ id }) => id !== placementId,
    );
    dashboard.links = dashboard.links.filter(
      (link) =>
        link.source_instance_id !== placementId &&
        link.target_instance_id !== placementId,
    );
    const bindings = loadBindingStore();
    const runtimeId = bindings.bindings[placementId];
    delete bindings.bindings[placementId];
    saveDashboardStore(store);
    saveBindingStore(bindings);
    return runtimeId;
  });
  if (runtimeId) await deleteRuntimeInstance(runtimeId);
}

export async function reconcileRuntime(): Promise<RuntimeSnapshot> {
  return withStoreLock(async () => {
    const store = loadDashboardStore();
    let bindingStore = loadBindingStore();
    const response = await fetch("/api/v1/instances");
    if (!response.ok) throw await responseError(response);
    const runtimeInstances = new Map(
      parseInstanceList(await response.json()).instances.map((instance) => [
        instance.id,
        instance,
      ]),
    );
    const placements = store.dashboards.flatMap(
      (dashboard) => dashboard.placements,
    );
    const placementIds = new Set(placements.map(({ id }) => id));
    const staleRuntimeIds: string[] = [];
    for (const placementId of Object.keys(bindingStore.bindings)) {
      if (placementIds.has(placementId)) continue;
      const current = loadBindingStore();
      const runtimeId = current.bindings[placementId];
      if (runtimeId && !runtimeId.startsWith("pending:"))
        staleRuntimeIds.push(runtimeId);
      delete current.bindings[placementId];
      saveBindingStore(current);
      bindingStore = current;
    }
    for (const placement of placements)
      await ensureRuntimeBinding(placement, runtimeInstances);
    bindingStore = loadBindingStore();
    await Promise.all(staleRuntimeIds.map(deleteRuntimeInstance));
    return {
      dashboards: store.dashboards,
      bindings: new Map(
        Object.entries(bindingStore.bindings).filter(
          ([, runtimeId]) => !runtimeId.startsWith("pending:"),
        ),
      ),
      runtimeInstances,
    };
  });
}

export function materializeDashboard(
  dashboard: DashboardDocument,
  snapshot: RuntimeSnapshot,
  descriptors: Map<string, WidgetDescriptor>,
): Instance[] {
  return dashboard.placements.flatMap((placement) => {
    const runtimeId = snapshot.bindings.get(placement.id);
    const runtime = runtimeId && snapshot.runtimeInstances.get(runtimeId);
    const descriptor = descriptors.get(placement.widget_id);
    const variant = descriptor?.variants.find(
      ({ id }) => id === placement.variant_id,
    );
    if (!runtime || !variant) return [];
    return [
      {
        id: placement.id,
        runtime_id: runtime.id,
        widget_id: runtime.widget_id,
        variant_id: runtime.variant_id,
        options: runtime.options,
        layout: {
          ...placement.position,
          width: variant.width,
          height: variant.height,
        },
      },
    ];
  });
}

export function runtimeIdForPlacement(placementId: string): string | undefined {
  return loadBindingStore().bindings[placementId];
}

export function placementIdForRuntime(runtimeId: string): string | undefined {
  return Object.entries(loadBindingStore().bindings).find(
    ([, candidate]) => candidate === runtimeId,
  )?.[0];
}

export function onDashboardStorageChange(handler: () => void): () => void {
  const listener = (event: StorageEvent): void => {
    if (
      event.storageArea === localStorage &&
      (event.key === DASHBOARD_STORAGE_KEY || event.key === BINDING_STORAGE_KEY)
    )
      handler();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

async function ensureRuntimeBinding(
  placement: DashboardPlacement,
  runtimeInstances: Map<string, RuntimeInstance>,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const bindings = loadBindingStore();
    const runtimeId = bindings.bindings[placement.id];
    if (runtimeId?.startsWith("pending:")) {
      if (attempt < 200) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const current = loadBindingStore();
      if (current.bindings[placement.id] === runtimeId) {
        delete current.bindings[placement.id];
        saveBindingStore(current);
      }
      continue;
    }
    let runtime: RuntimeInstance | undefined = runtimeId
      ? runtimeInstances.get(runtimeId)
      : undefined;
    if (runtimeId && !runtime) {
      runtime = (await getRuntimeInstance(runtimeId)) ?? undefined;
      if (runtime) runtimeInstances.set(runtime.id, runtime);
    }
    if (runtime && matches(placement, runtime)) return;

    const claim = `pending:${localId("binding")}`;
    bindings.bindings[placement.id] = claim;
    saveBindingStore(bindings);
    if (loadBindingStore().bindings[placement.id] !== claim) continue;

    const created = await createRuntimeInstance(placement);
    const current = loadBindingStore();
    if (current.bindings[placement.id] !== claim) {
      await deleteRuntimeInstance(created.id);
      continue;
    }
    current.bindings[placement.id] = created.id;
    saveBindingStore(current);
    runtimeInstances.set(created.id, created);
    return;
  }
  throw new Error("could not acquire a runtime binding");
}

async function getRuntimeInstance(
  runtimeId: string,
): Promise<RuntimeInstance | null> {
  const response = await fetch(
    `/api/v1/instances/${encodeURIComponent(runtimeId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);
  return parseRuntimeInstance(await response.json());
}

async function createRuntimeInstance(
  placement: DashboardPlacement,
): Promise<RuntimeInstance> {
  const response = await fetch("/api/v1/instances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      widget_id: placement.widget_id,
      variant_id: placement.variant_id,
      options: placement.options,
    }),
  });
  if (!response.ok) throw await responseError(response);
  return parseRuntimeInstance(await response.json());
}

async function deleteRuntimeInstance(runtimeId: string): Promise<void> {
  const response = await fetch(
    `/api/v1/instances/${encodeURIComponent(runtimeId)}`,
    { method: "DELETE" },
  ).catch(() => null);
  if (response && !response.ok && response.status !== 404)
    throw await responseError(response);
}

function matches(
  placement: DashboardPlacement,
  runtime: RuntimeInstance,
): boolean {
  return (
    placement.widget_id === runtime.widget_id &&
    placement.variant_id === runtime.variant_id &&
    JSON.stringify(Object.entries(placement.options).sort()) ===
      JSON.stringify(Object.entries(runtime.options).sort())
  );
}

function loadDashboardStore(): DashboardStoreFile {
  const source = localStorage.getItem(DASHBOARD_STORAGE_KEY);
  if (source === null) return { version: STORE_VERSION, dashboards: [] };
  return parseDashboardStore(JSON.parse(source));
}

function loadBindingStore(): BindingStoreFile {
  const source = localStorage.getItem(BINDING_STORAGE_KEY);
  if (source === null) return { version: STORE_VERSION, bindings: {} };
  const value: unknown = JSON.parse(source);
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    !isRecord(value.bindings) ||
    !Object.values(value.bindings).every(
      (runtimeId) => typeof runtimeId === "string",
    )
  )
    throw new Error("invalid dashboard runtime bindings");
  return value as BindingStoreFile;
}

function saveDashboardStore(store: DashboardStoreFile): void {
  localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(store));
}

function saveBindingStore(store: BindingStoreFile): void {
  localStorage.setItem(BINDING_STORAGE_KEY, JSON.stringify(store));
}

function parseDashboardStore(value: unknown): DashboardStoreFile {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    !Array.isArray(value.dashboards)
  )
    throw new Error("invalid local dashboard store");
  const dashboards = value.dashboards.map(parseDashboard);
  if (dashboards.length > MAX_DASHBOARDS)
    throw new Error("dashboard limit exceeded");
  const dashboardIds = new Set<string>();
  const placementIds = new Set<string>();
  for (const dashboard of dashboards) {
    if (dashboardIds.has(dashboard.id))
      throw new Error("duplicate dashboard ID");
    dashboardIds.add(dashboard.id);
    for (const placement of dashboard.placements) {
      if (placementIds.has(placement.id))
        throw new Error("duplicate placement ID");
      placementIds.add(placement.id);
    }
  }
  return { version: STORE_VERSION, dashboards };
}

function parseDashboard(value: unknown): DashboardDocument {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.columns) ||
    !Array.isArray(value.placements) ||
    !Array.isArray(value.links)
  )
    throw new Error("invalid local dashboard");
  const dashboard: DashboardDocument = {
    id: value.id,
    name: normalizeName(value.name),
    columns: validateColumns(value.columns as number),
    placements: value.placements.map(parsePlacement),
    links: value.links.map(parseLink),
  };
  if (
    dashboard.placements.some(
      ({ position }) =>
        position.column >= dashboard.columns || position.row >= 24,
    )
  )
    throw new Error("dashboard placement is outside the grid");
  const ids = new Set(dashboard.placements.map(({ id }) => id));
  if (
    dashboard.links.some(
      (link) =>
        !ids.has(link.source_instance_id) || !ids.has(link.target_instance_id),
    )
  )
    throw new Error("dashboard link references an unknown placement");
  return dashboard;
}

function parsePlacement(value: unknown): DashboardPlacement {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.widget_id !== "string" ||
    typeof value.variant_id !== "string" ||
    !isRecord(value.position) ||
    !isNonNegativeInteger(value.position.column) ||
    !isNonNegativeInteger(value.position.row) ||
    !isOptions(value.options)
  )
    throw new Error("invalid dashboard placement");
  return value as DashboardPlacement;
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
  return value as DashboardLink;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > 64 ||
    [...normalized].some((character) => /[\u0000-\u001f\u007f]/.test(character))
  )
    throw new Error("dashboard name must contain 1 to 64 characters");
  return normalized;
}

function validateColumns(columns: number): number {
  if (!Number.isInteger(columns) || columns < 3 || columns > 24)
    throw new Error("dashboard columns must be between 3 and 24");
  return columns;
}

function duplicateName(source: string, names: string[]): string {
  const existing = new Set(names);
  for (let index = 1; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${[...source].slice(0, 64 - suffix.length).join("")}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function localId(prefix: string): string {
  if (typeof crypto.randomUUID === "function")
    return `${prefix}-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  idSequence += 1;
  return `${prefix}-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}-${idSequence}`;
}

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks)
    return navigator.locks.request<T>(
      "dashboardd-dashboard-store",
      // The installed Web Locks types omit promise-returning callbacks.
      () => operation() as unknown as T,
    );
  const result = fallbackLock.then(operation, operation);
  fallbackLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function responseError(response: Response): Promise<Error> {
  const value = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(
    value?.error?.message ?? `${response.status} ${response.statusText}`,
  );
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
