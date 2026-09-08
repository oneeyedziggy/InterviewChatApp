export type WebSocketConnectOptions = {
  path?: string;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  auth?: Record<string, unknown>;
};

type EventHandler = (...args: any[]) => void;

type WireEnvelope = {
  event: string;
  payload?: unknown;
};

export type Socket = {
  id?: string;
  connected: boolean;
  disconnected: boolean;
  io?: { engine?: { readyState?: string; transport?: { name?: string } } };
  on: (event: string, handler: EventHandler) => Socket;
  off: (event: string, handler?: EventHandler) => Socket;
  emit: (event: string, payload?: unknown) => void;
  connect: () => void;
  disconnect: () => void;
};

class WebSocketClient implements Socket {
  public id?: string;
  public connected = false;
  public io?: {
    engine?: { readyState?: string; transport?: { name?: string } };
  };

  public get disconnected(): boolean {
    return !this.connected;
  }

  private readonly handlers = new Map<string, Set<EventHandler>>();
  private ws: WebSocket | undefined;
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private readonly pending: WireEnvelope[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly options: WebSocketConnectOptions,
  ) {
    this.open();
  }

  public on(event: string, handler: EventHandler): Socket {
    const set = this.handlers.get(event) || new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  public off(event: string, handler?: EventHandler): Socket {
    if (!handler) {
      this.handlers.delete(event);
      return this;
    }
    const set = this.handlers.get(event);
    if (!set) {
      return this;
    }
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(event);
    }
    return this;
  }

  public emit(event: string, payload?: unknown): void {
    const message: WireEnvelope = { event, payload };
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pending.push(message);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  public disconnect(): void {
    this.manuallyClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.connected = false;
  }

  public connect(): void {
    this.manuallyClosed = false;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.open();
    }
  }

  private open(): void {
    const wsUrl = this.toWebSocketUrl(
      this.baseUrl,
      this.options.path || '/ws/',
    );
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.io = {
      engine: { readyState: 'opening', transport: { name: 'websocket' } },
    };

    ws.onopen = () => {
      this.connected = true;
      if (this.io?.engine) {
        this.io.engine.readyState = 'open';
      }
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        if (!item) break;
        ws.send(JSON.stringify(item));
      }
      if (this.reconnectAttempts > 0) {
        this.emitLocal('reconnect', this.reconnectAttempts);
      }
      this.reconnectAttempts = 0;

      if (this.options.auth && Object.keys(this.options.auth).length > 0) {
        ws.send(JSON.stringify({ event: 'auth', payload: this.options.auth }));
      }
    };

    ws.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as WireEnvelope;
        if (!parsed || typeof parsed.event !== 'string') {
          return;
        }
        if (parsed.event === 'connect') {
          const maybeId =
            parsed.payload && typeof parsed.payload === 'object'
              ? (parsed.payload as { id?: unknown }).id
              : undefined;
          if (typeof maybeId === 'string' && maybeId.trim() !== '') {
            this.id = maybeId;
          }
        }
        this.emitLocal(parsed.event, parsed.payload);
      } catch (error) {
        this.emitLocal('error', error);
      }
    };

    ws.onerror = (error) => {
      if (this.io?.engine) {
        this.io.engine.readyState = 'closed';
      }
      this.emitLocal('connect_error', error);
      this.emitLocal('error', error);
    };

    ws.onclose = (event) => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.io?.engine) {
        this.io.engine.readyState = 'closed';
      }
      this.emitLocal('disconnect', event.reason || 'socket closed');

      if (!wasConnected || this.manuallyClosed) {
        return;
      }

      const shouldReconnect = this.options.reconnection !== false;
      if (!shouldReconnect) {
        return;
      }

      const maxAttempts = this.options.reconnectionAttempts ?? 5;
      if (this.reconnectAttempts >= maxAttempts) {
        this.emitLocal('reconnect_failed');
        return;
      }

      this.reconnectAttempts += 1;
      this.emitLocal('reconnect_attempt', this.reconnectAttempts);
      const delay = this.options.reconnectionDelay ?? 1000;
      window.setTimeout(() => {
        if (!this.manuallyClosed) {
          this.open();
        }
      }, delay);
    };
  }

  private emitLocal(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) {
      return;
    }
    for (const handler of set) {
      handler(...args);
    }
  }

  private toWebSocketUrl(base: string, path: string): string {
    const parsed = new URL(base, window.location.href);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${protocol}//${parsed.host}${normalizedPath}`;
  }
}

const connectWebSocket = (
  baseUrl: string,
  options: WebSocketConnectOptions = {},
): Socket => {
  return new WebSocketClient(baseUrl, options);
};
export default connectWebSocket;
