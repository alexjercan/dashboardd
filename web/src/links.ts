import type { WidgetContext } from "@dashboardd/widget-sdk";
import type { DashboardLink } from "./dashboard-store";
import type { TypedInput } from "./protocol";

type Handler = (payload: unknown | undefined) => void;
type Capabilities = Pick<WidgetContext, "inputs" | "outputs">;

export class WidgetInputBus {
  private links: DashboardLink[] = [];
  private direct = new Map<string, Record<string, TypedInput>>();
  private latest = new Map<string, unknown>();
  private subscribers = new Map<string, Set<Handler>>();

  context(instanceId: string): Capabilities {
    return {
      inputs: {
        get: (input) => this.value(instanceId, input),
        subscribe: (input, handler) =>
          this.subscribe(instanceId, input, handler),
      },
      outputs: {
        publish: (output, payload) => this.publish(instanceId, output, payload),
      },
    };
  }

  setInputs(instanceId: string, inputs: Record<string, TypedInput>): void {
    const previous = this.direct.get(instanceId) ?? {};
    this.direct.set(instanceId, inputs);
    for (const input of new Set([
      ...Object.keys(previous),
      ...Object.keys(inputs),
    ])) {
      if (this.linkFor(instanceId, input)) continue;
      const before = previous[input]?.value;
      const after = inputs[input]?.value;
      if (!sameValue(before, after)) this.deliver(instanceId, input, after);
    }
  }

  replace(links: DashboardLink[]): void {
    const targets = new Set(
      [...this.links, ...links].map((link) =>
        key(link.target_instance_id, link.target_port),
      ),
    );
    const previous = new Map(
      [...targets].map((target) => {
        const [instanceId, input] = splitKey(target);
        return [target, this.value(instanceId, input)];
      }),
    );
    this.links = [...links];
    for (const target of targets) {
      const [instanceId, input] = splitKey(target);
      const value = this.value(instanceId, input);
      if (!sameValue(previous.get(target), value))
        this.deliver(instanceId, input, value);
    }
  }

  update(link: DashboardLink): void {
    this.replace([
      ...this.links.filter(
        (existing) =>
          existing.target_instance_id !== link.target_instance_id ||
          existing.target_port !== link.target_port,
      ),
      link,
    ]);
  }

  delete(targetInstanceId: string, targetPort: string): void {
    this.replace(
      this.links.filter(
        (link) =>
          link.target_instance_id !== targetInstanceId ||
          link.target_port !== targetPort,
      ),
    );
  }

  removeInstance(instanceId: string): void {
    this.replace(
      this.links.filter(
        (link) =>
          link.source_instance_id !== instanceId &&
          link.target_instance_id !== instanceId,
      ),
    );
    this.direct.delete(instanceId);
    for (const stored of this.latest.keys())
      if (stored.startsWith(`${instanceId}\u0000`)) this.latest.delete(stored);
    for (const subscription of this.subscribers.keys())
      if (subscription.startsWith(`${instanceId}\u0000`))
        this.subscribers.delete(subscription);
  }

  list(): readonly DashboardLink[] {
    return this.links;
  }

  private value(instanceId: string, input: string): unknown | undefined {
    const link = this.linkFor(instanceId, input);
    if (link)
      return this.latest.get(key(link.source_instance_id, link.source_port));
    return this.direct.get(instanceId)?.[input]?.value;
  }

  private linkFor(
    instanceId: string,
    input: string,
  ): DashboardLink | undefined {
    return this.links.find(
      (link) =>
        link.target_instance_id === instanceId && link.target_port === input,
    );
  }

  private publish(instanceId: string, output: string, payload: unknown): void {
    this.latest.set(key(instanceId, output), payload);
    for (const link of this.links)
      if (link.source_instance_id === instanceId && link.source_port === output)
        this.deliver(link.target_instance_id, link.target_port, payload);
  }

  private subscribe(
    instanceId: string,
    input: string,
    handler: Handler,
  ): () => void {
    const subscription = key(instanceId, input);
    let handlers = this.subscribers.get(subscription);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(subscription, handlers);
    }
    handlers.add(handler);
    queueMicrotask(() => {
      if (handlers?.has(handler)) handler(this.value(instanceId, input));
    });
    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.subscribers.delete(subscription);
    };
  }

  private deliver(
    instanceId: string,
    input: string,
    payload: unknown | undefined,
  ): void {
    for (const handler of this.subscribers.get(key(instanceId, input)) ?? [])
      handler(payload);
  }
}

function key(instanceId: string, port: string): string {
  return `${instanceId}\u0000${port}`;
}

function splitKey(value: string): [string, string] {
  const separator = value.indexOf("\u0000");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
