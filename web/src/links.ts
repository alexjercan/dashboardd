import type { WidgetLinks } from "@dashboardd/widget-sdk";
import type { DashboardLink } from "./dashboard-store";

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
    for (const previous of this.links)
      if (
        !links.some(
          (link) =>
            link.source_instance_id === previous.source_instance_id &&
            link.source_port === previous.source_port &&
            link.target_instance_id === previous.target_instance_id &&
            link.target_port === previous.target_port,
        )
      )
        this.deliver(previous.target_instance_id, previous.target_port, null);
    this.links = [...links];
    for (const link of links) this.replay(link);
  }

  update(link: DashboardLink): void {
    const previous = this.links.find(
      (existing) =>
        existing.target_instance_id === link.target_instance_id &&
        existing.target_port === link.target_port,
    );
    this.links = this.links.filter(
      (existing) =>
        existing.target_instance_id !== link.target_instance_id ||
        existing.target_port !== link.target_port,
    );
    this.links.push(link);
    if (
      previous &&
      (previous.source_instance_id !== link.source_instance_id ||
        previous.source_port !== link.source_port)
    )
      this.deliver(link.target_instance_id, link.target_port, null);
    this.replay(link);
  }

  delete(targetInstanceId: string, targetPort: string): void {
    const linked = this.links.some(
      (link) =>
        link.target_instance_id === targetInstanceId &&
        link.target_port === targetPort,
    );
    this.links = this.links.filter(
      (link) =>
        link.target_instance_id !== targetInstanceId ||
        link.target_port !== targetPort,
    );
    if (linked) this.deliver(targetInstanceId, targetPort, null);
  }

  removeInstance(instanceId: string): void {
    const removed = this.links.filter(
      (link) =>
        link.source_instance_id === instanceId ||
        link.target_instance_id === instanceId,
    );
    this.links = this.links.filter(
      (link) =>
        link.source_instance_id !== instanceId &&
        link.target_instance_id !== instanceId,
    );
    for (const link of removed)
      if (link.source_instance_id === instanceId)
        this.deliver(link.target_instance_id, link.target_port, null);
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
