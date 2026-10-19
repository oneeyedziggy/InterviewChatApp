import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import connectWebSocket from './websocketClient';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { reason: string }) => void;
  onerror?: (error: unknown) => void;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  receive(event: string) {
    this.onmessage?.({ data: JSON.stringify({ event, payload: {} }) });
  }
}

describe('websocketClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('finishes initial key hydration before handling a later identity refresh', async () => {
    const socket = connectWebSocket('http://localhost', { path: '/ws/?server=tenant' });
    const wire = FakeWebSocket.instances[0];
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });
    const order: string[] = [];
    socket.on('initial', async () => {
      order.push('initial-start');
      await hydration;
      order.push('initial-end');
    });
    socket.on('refresh', () => { order.push('refresh'); });
    wire.receive('initial');
    wire.receive('refresh');
    await Promise.resolve();
    expect(order).toEqual(['initial-start']);
    finishHydration();
    await vi.waitFor(() => expect(order).toEqual(['initial-start', 'initial-end', 'refresh']));
    expect(wire.url).toBe('ws://localhost/ws/?server=tenant');
    socket.disconnect();
  });

  it('continues processing after a handler fails', async () => {
    const socket = connectWebSocket('http://localhost');
    const error = new Error('handler failed');
    const onError = vi.fn();
    const next = vi.fn();
    socket.on('initial', async () => { throw error; });
    socket.on('error', onError);
    socket.on('refresh', next);
    FakeWebSocket.instances[0].receive('initial');
    FakeWebSocket.instances[0].receive('refresh');
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
    socket.disconnect();
  });

  it('retries failed initial connections up to the configured limit', async () => {
    const socket = connectWebSocket('http://localhost', {
      reconnectionAttempts: 2, reconnectionDelay: 100,
    });
    const failed = vi.fn();
    socket.on('reconnect_failed', failed);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      FakeWebSocket.instances[attempt].onclose?.({ reason: 'unavailable' });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(failed).toHaveBeenCalledOnce();
    socket.disconnect();
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const socket = connectWebSocket('http://localhost');
    const wire = FakeWebSocket.instances[0];
    socket.disconnect();
    wire.onclose?.({ reason: 'closed' });
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});