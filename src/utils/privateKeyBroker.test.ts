import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorkerMock = (
  responder: (request: any) => any,
): ServiceWorker & { postMessage: ReturnType<typeof vi.fn> } => {
  return {
    postMessage: vi.fn((request: any, ports?: MessagePort[]) => {
      const responsePort = ports?.[0];
      if (responsePort) {
        responsePort.postMessage(responder(request));
      }
    }),
  } as unknown as ServiceWorker & { postMessage: ReturnType<typeof vi.fn> };
};

describe('privateKeyBroker', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns safe fallbacks when service worker is unavailable', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');

    await expect(
      broker.brokerSetPrivateKey('alice', 'private-key'),
    ).resolves.toBe(false);
    await expect(broker.brokerGetPrivateKey('alice')).resolves.toBeNull();
    await expect(
      broker.brokerClearPrivateKey('alice'),
    ).resolves.toBeUndefined();
  });

  it('returns safe fallbacks when registration fails', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => {
          throw new Error('registration failed');
        }),
        ready: Promise.resolve(null),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');
    await expect(broker.brokerSetPrivateKey('alice', 'k')).resolves.toBe(false);
    await expect(broker.brokerGetPrivateKey('alice')).resolves.toBeNull();
  });

  it('sends set/get/clear messages through the service worker channel', async () => {
    const store = new Map<string, string>();
    const worker = createWorkerMock((request) => {
      if (request.cmd === 'set') {
        store.set(request.username, request.privateKey);
        return { ok: true };
      }
      if (request.cmd === 'get') {
        return { ok: true, privateKey: store.get(request.username) ?? null };
      }
      if (request.cmd === 'clear') {
        store.delete(request.username);
        return { ok: true };
      }
      if (request.cmd === 'clearAll') {
        store.clear();
        return { ok: true };
      }
      return { ok: false, error: 'unknown' };
    });

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => ({ active: worker })),
        ready: Promise.resolve({ active: worker }),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');

    await expect(
      broker.brokerSetPrivateKey('alice', 'private-key'),
    ).resolves.toBe(true);
    await expect(broker.brokerGetPrivateKey('alice')).resolves.toBe(
      'private-key',
    );

    await expect(
      broker.brokerClearPrivateKey('alice'),
    ).resolves.toBeUndefined();
    await expect(broker.brokerGetPrivateKey('alice')).resolves.toBeNull();

    await expect(broker.brokerSetPrivateKey('bob', 'b-key')).resolves.toBe(
      true,
    );
    await expect(broker.brokerSetPrivateKey('charlie', 'c-key')).resolves.toBe(
      true,
    );
    await expect(broker.brokerClearAllPrivateKeys()).resolves.toBeUndefined();
    await expect(broker.brokerGetPrivateKey('bob')).resolves.toBeNull();
  });

  it('restores from the registered active broker without waiting for page control', async () => {
    const worker = createWorkerMock(() => ({ ok: true, privateKey: 'unlocked-key' }));
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => ({ active: worker })),
        ready: new Promise(() => {}),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');
    await expect(broker.brokerGetPrivateKey('alice')).resolves.toBe('unlocked-key');
  });

  it('waits for the installing broker to activate before storing a key', async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    const worker = Object.assign(events, {
      state: 'installing',
      postMessage: createWorkerMock(() => ({ ok: true })).postMessage,
    });
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { register: vi.fn(async () => ({ installing: worker })) },
      configurable: true,
    });
    const broker = await import('./privateKeyBroker');
    const pending = broker.brokerSetPrivateKey('alice', 'key');
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.state = 'activated';
    worker.dispatchEvent(new Event('statechange'));
    await expect(pending).resolves.toBe(true);
  });

  it('fails closed if activation never completes', async () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventTarget(), {
      state: 'installing',
      postMessage: vi.fn(),
    });
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { register: vi.fn(async () => ({ installing: worker })) },
      configurable: true,
    });
    const broker = await import('./privateKeyBroker');
    const pending = broker.brokerGetPrivateKey('alice');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('handles registration with no active/waiting/installing worker', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => ({})),
        ready: Promise.resolve({}),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');
    await expect(broker.brokerSetPrivateKey('nobody', 'k')).resolves.toBe(
      false,
    );
  });

  it('handles empty broker message payloads safely', async () => {
    const worker = {
      postMessage: vi.fn((_request: any, ports?: MessagePort[]) => {
        ports?.[0]?.postMessage(undefined);
      }),
    } as unknown as ServiceWorker;

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => ({ active: worker })),
        ready: Promise.resolve({ active: worker }),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');
    await expect(broker.brokerGetPrivateKey('ghost')).resolves.toBeNull();
  });

  it('handles request timeout when worker does not respond', async () => {
    vi.useFakeTimers();

    const worker = {
      postMessage: vi.fn(),
    } as unknown as ServiceWorker;

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: vi.fn(async () => ({ active: worker })),
        ready: Promise.resolve({ active: worker }),
      },
      configurable: true,
    });

    const broker = await import('./privateKeyBroker');

    const pending = broker.brokerGetPrivateKey('nobody');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();

    vi.useRealTimers();
  });
});
