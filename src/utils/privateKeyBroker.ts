import { withBasePath } from '@/utils/appPaths';

type BrokerCommand = 'set' | 'get' | 'clear' | 'clearAll';

type BrokerRequest = {
  cmd: BrokerCommand;
  username?: string;
  privateKey?: string;
};

type BrokerResponse = {
  ok: boolean;
  privateKey?: string | null;
  error?: string;
};

const BROKER_SW_PATH = '/private-key-broker-sw.js';

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null =
  null;

function getBrokerServiceWorkerCandidates(): string[] {
  const candidates = [withBasePath(BROKER_SW_PATH), BROKER_SW_PATH];
  return Array.from(new Set(candidates));
}

function formatRegistrationError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function registerBrokerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !navigator.serviceWorker
  ) {
    return null;
  }

  if (!registrationPromise) {
    registrationPromise = (async () => {
      const errors: string[] = [];

      for (const candidate of getBrokerServiceWorkerCandidates()) {
        try {
          const registration =
            await navigator.serviceWorker.register(candidate);
          await navigator.serviceWorker.ready;
          return registration;
        } catch (error) {
          errors.push(`${candidate} -> ${formatRegistrationError(error)}`);
        }
      }

      if (errors.length > 0) {
        console.error(
          '[KeyBroker] Failed to register service worker:',
          errors.join(' | '),
        );
      }
      return null;
    })();
  }

  return registrationPromise;
}

async function getBrokerWorker(): Promise<ServiceWorker | null> {
  const registration = await registerBrokerServiceWorker();
  if (!registration) return null;

  const worker =
    registration.active || registration.waiting || registration.installing;

  return worker ?? null;
}

async function sendBrokerRequest(
  request: BrokerRequest,
): Promise<BrokerResponse> {
  const worker = await getBrokerWorker();
  if (!worker) {
    return { ok: false, error: 'Broker worker unavailable' };
  }

  return new Promise<BrokerResponse>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      resolve({ ok: false, error: 'Broker request timed out' });
    }, 2000);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      const data = (event.data || {}) as BrokerResponse;
      resolve(data);
    };

    worker.postMessage(request, [channel.port2]);
  });
}

export async function brokerSetPrivateKey(
  username: string,
  privateKey: string,
): Promise<boolean> {
  const response = await sendBrokerRequest({
    cmd: 'set',
    username,
    privateKey,
  });
  return response.ok;
}

export async function brokerGetPrivateKey(
  username: string,
): Promise<string | null> {
  const response = await sendBrokerRequest({ cmd: 'get', username });
  if (!response.ok) {
    return null;
  }

  return response.privateKey ?? null;
}

export async function brokerClearPrivateKey(username: string): Promise<void> {
  await sendBrokerRequest({ cmd: 'clear', username });
}

export async function brokerClearAllPrivateKeys(): Promise<void> {
  await sendBrokerRequest({ cmd: 'clearAll' });
}
