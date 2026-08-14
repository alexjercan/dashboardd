import type { WidgetLinks } from "@scufris/widget-sdk";
import type { DashboardLink } from "./protocol";

type Handler = (payload: unknown) => void;

export class WidgetLinkBus {
  private links: DashboardLink[] = [];
  private latest = new Map<string, unknown>();
  private subscribers = new Map<string, Set<Handler>>();

  context(instanceId: string): WidgetLinks {
    return {
      publish: (output, payload) => this.publish(instanceId, output, payload),
      subscribe: (input, handler) => this.subscribe(instanceId, input, handler),
    };
  }

  replace(links: DashboardLink[]): void {
    this.links = [...links];
    for (const link of links) this.replay(link);
  }

  update(link: DashboardLink): void {
    this.links = this.links.filter(
      (existing) =>
        existing.target_instance_id !== link.target_instance_id ||
        existing.target_port !== link.target_port,
    );
    this.links.push(link);
    this.replay(link);
  }

  delete(targetInstanceId: string, targetPort: string): void {
    this.links = this.links.filter(
      (link) =>
        link.target_instance_id !== targetInstanceId ||
        link.target_port !== targetPort,
    );
  }

  removeInstance(instanceId: string): void {
    this.links = this.links.filter(
      (link) =>
        link.source_instance_id !== instanceId &&
        link.target_instance_id !== instanceId,
    );
    for (const key of this.latest.keys())
      if (key.startsWith(`${instanceId}\u0000`)) this.latest.delete(key);
    for (const key of this.subscribers.keys())
      if (key.startsWith(`${instanceId}\u0000`)) this.subscribers.delete(key);
  }

  list(): readonly DashboardLink[] {
    return this.links;
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
    const link = this.links.find(
      (candidate) =>
        candidate.target_instance_id === instanceId &&
        candidate.target_port === input,
    );
    if (link) {
      const source = key(link.source_instance_id, link.source_port);
      if (this.latest.has(source)) {
        const payload = this.latest.get(source);
        queueMicrotask(() => handler(payload));
      }
    }
    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.subscribers.delete(subscription);
    };
  }

  private replay(link: DashboardLink): void {
    const source = key(link.source_instance_id, link.source_port);
    if (this.latest.has(source))
      this.deliver(
        link.target_instance_id,
        link.target_port,
        this.latest.get(source),
      );
  }

  private deliver(instanceId: string, input: string, payload: unknown): void {
    for (const handler of this.subscribers.get(key(instanceId, input)) ?? [])
      handler(payload);
  }
}

function key(instanceId: string, port: string): string {
  return `${instanceId}\u0000${port}`;
}
