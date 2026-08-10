const unlockedKeys = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port) {
    return;
  }

  const data = event.data || {};
  const cmd = data.cmd;
  const username = typeof data.username === 'string' ? data.username : '';

  if (cmd === 'set') {
    if (!username || typeof data.privateKey !== 'string') {
      port.postMessage({ ok: false, error: 'Invalid set payload' });
      return;
    }

    unlockedKeys.set(username, data.privateKey);
    port.postMessage({ ok: true });
    return;
  }

  if (cmd === 'get') {
    if (!username) {
      port.postMessage({ ok: false, error: 'Username required' });
      return;
    }

    const privateKey = unlockedKeys.has(username)
      ? unlockedKeys.get(username)
      : null;
    port.postMessage({ ok: true, privateKey });
    return;
  }

  if (cmd === 'clear') {
    if (username) {
      unlockedKeys.delete(username);
    }
    port.postMessage({ ok: true });
    return;
  }

  if (cmd === 'clearAll') {
    unlockedKeys.clear();
    port.postMessage({ ok: true });
    return;
  }

  port.postMessage({ ok: false, error: 'Unknown command' });
});
