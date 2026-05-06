type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type EventHandler = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<EventHandler>>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = (ev) => reject(new Error('WebSocket error'));
      this.ws.onclose = () => this.handleClose();
      this.ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP connection not open');
    }

    const id = ++this.messageId;
    const message = sessionId
      ? JSON.stringify({ id, method, params, sessionId })
      : JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.ws!.send(message);
    });
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get isOpen(): boolean {
    return this.connected;
  }

  private handleMessage(data: string): void {
    const msg = JSON.parse(data);

    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params || {});
        }
      }
    }
  }

  private handleClose(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.ws = null;
  }
}

export async function discoverBrowserWsUrl(port: number, host = 'localhost'): Promise<string> {
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Failed to discover browser: ${response.status}`);
  }
  const data = (await response.json()) as { webSocketDebuggerUrl: string };
  return data.webSocketDebuggerUrl;
}

export async function listTargets(
  port: number,
  host = 'localhost'
): Promise<Array<{ id: string; type: string; title: string; url: string }>> {
  const response = await fetch(`http://${host}:${port}/json`);
  if (!response.ok) {
    throw new Error(`Failed to list targets: ${response.status}`);
  }
  return response.json() as Promise<Array<{ id: string; type: string; title: string; url: string }>>;
}
