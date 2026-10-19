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

const getBrokerServiceWorkerCandidates = ():  string[] => {
  const candidates = [withBasePath(BROKER_SW_PATH), BROKER_SW_PATH];
  return Array.from(new Set(candidates));
};

const formatRegistrationError = (error: unknown):  string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
};

const registerBrokerServiceWorker = async ():  Promise<ServiceWorkerRegistration | null> => {
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
};

const getBrokerWorker = async ():  Promise<ServiceWorker | null> => {
  const registration = await registerBrokerServiceWorker();
  if (!registration) return null;

  if (registration.active) return registration.active;
  const worker = registration.waiting || registration.installing;
  if (!worker) return null;
  if (worker.state === 'activated') return worker;
  if (worker.state === 'redundant') return null;

  return new Promise<ServiceWorker | null>((resolve) => {
    const finish = (activeWorker: ServiceWorker | null) => {
      window.clearTimeout(timeout);
      worker.removeEventListener('statechange', onStateChange);
      resolve(activeWorker);
    };
    const onStateChange = () => {
      if (worker.state === 'activated') finish(worker);
      if (worker.state === 'redundant') finish(null);
    };
    const timeout = window.setTimeout(() => finish(null), 2000);
    worker.addEventListener('statechange', onStateChange);
    onStateChange();
  });
};

const sendBrokerRequest = async (
  request: BrokerRequest,):  Promise<BrokerResponse> => {
  const worker = await getBrokerWorker();
  if (!worker) {
    return { ok: false, error: 'Broker worker unavailable' };
  }

  return new Promise<BrokerResponse>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    let timeout = 0;

    const finish = (response: BrokerResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      resolve(response);
    };

    timeout = window.setTimeout(() => {
      finish({ ok: false, error: 'Broker request timed out' });
    }, 2000);

    channel.port1.onmessage = (event) => {
      const data = (event.data || {}) as BrokerResponse;
      finish(data);
    };

    try {
      worker.postMessage(request, [channel.port2]);
    } catch (error) {
      finish({ ok: false, error: formatRegistrationError(error) });
    }
  });
};

export const brokerSetPrivateKey = async (
  username: string,
  privateKey: string,):  Promise<boolean> => {
  const response = await sendBrokerRequest({
    cmd: 'set',
    username,
    privateKey,
  });
  return response.ok;
};

export const brokerGetPrivateKey = async (
  username: string,):  Promise<string | null> => {
  const response = await sendBrokerRequest({ cmd: 'get', username });
  if (!response.ok) {
    return null;
  }

  return response.privateKey ?? null;
};

export const brokerClearPrivateKey = async (username: string):  Promise<void> => {
  await sendBrokerRequest({ cmd: 'clear', username });
};

export const brokerClearAllPrivateKeys = async ():  Promise<void> => {
  await sendBrokerRequest({ cmd: 'clearAll' });
};
