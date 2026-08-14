import type { WidgetSharedState } from "@scufris/widget-sdk";
import {
  parseWidgetStateResource,
  type ErrorResponse,
  type WidgetStateResource,
} from "./protocol";

const MAX_MUTATION_ATTEMPTS = 3;

export class WidgetStateBus {
  private readonly resources = new Map<string, WidgetStateResource>();
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private readonly loads = new Map<string, Promise<WidgetStateResource>>();
  private readonly mutations = new Map<string, Promise<void>>();

  context(widgetId: string): WidgetSharedState {
    return {
      get: () => this.resources.get(widgetId)?.value ?? {},
      subscribe: (handler) => {
        let listeners = this.listeners.get(widgetId);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(widgetId, listeners);
        }
        listeners.add(handler);
        handler(this.resources.get(widgetId)?.value ?? {});
        void this.load(widgetId).catch(() => {});
        return () => listeners?.delete(handler);
      },
      mutate: (update) => this.enqueueMutation(widgetId, update),
    };
  }

  update(resource: WidgetStateResource): void {
    const current = this.resources.get(resource.widget_id);
    if (current && current.revision > resource.revision) return;
    this.resources.set(resource.widget_id, resource);
    if (
      current?.revision === resource.revision &&
      JSON.stringify(current.value) === JSON.stringify(resource.value)
    )
      return;
    for (const listener of this.listeners.get(resource.widget_id) ?? [])
      listener(resource.value);
  }

  async reconcile(widgetIds: Iterable<string>): Promise<void> {
    await Promise.all(
      [...new Set(widgetIds)].map((widgetId) =>
        this.load(widgetId, true).catch(() => {}),
      ),
    );
  }

  private enqueueMutation(
    widgetId: string,
    update: (current: unknown) => unknown,
  ): Promise<void> {
    const previous = this.mutations.get(widgetId) ?? Promise.resolve();
    const mutation = previous
      .catch(() => {})
      .then(() => this.runMutation(widgetId, update));
    this.mutations.set(widgetId, mutation);
    const cleanup = (): void => {
      if (this.mutations.get(widgetId) === mutation)
        this.mutations.delete(widgetId);
    };
    void mutation.then(cleanup, cleanup);
    return mutation;
  }

  private async runMutation(
    widgetId: string,
    update: (current: unknown) => unknown,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const current = await this.load(widgetId, attempt > 0);
      const response = await fetch(
        `/api/v1/widget-state/${encodeURIComponent(widgetId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revision: current.revision,
            value: update(current.value),
          }),
        },
      );
      if (response.status === 409) {
        await this.load(widgetId, true);
        continue;
      }
      if (!response.ok) throw await apiError(response);
      this.update(parseWidgetStateResource(await response.json()));
      return;
    }
    throw new Error("Widget state changed too many times; try again");
  }

  private load(widgetId: string, force = false): Promise<WidgetStateResource> {
    const current = this.resources.get(widgetId);
    if (current && !force) return Promise.resolve(current);
    const pending = this.loads.get(widgetId);
    if (pending && !force) return pending;
    const load = fetch(`/api/v1/widget-state/${encodeURIComponent(widgetId)}`)
      .then(async (response) => {
        if (!response.ok) throw await apiError(response);
        const resource = parseWidgetStateResource(await response.json());
        this.update(resource);
        return this.resources.get(widgetId) ?? resource;
      })
      .finally(() => {
        if (this.loads.get(widgetId) === load) this.loads.delete(widgetId);
      });
    this.loads.set(widgetId, load);
    return load;
  }
}

async function apiError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as ErrorResponse;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the HTTP status when the response has no API error body.
  }
  return new Error(message);
}
