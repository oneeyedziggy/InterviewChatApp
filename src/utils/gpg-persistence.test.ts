import { beforeEach, describe, expect, it, vi } from 'vitest';

const brokerKeys = vi.hoisted(() => new Map<string, string>());
vi.mock('./privateKeyBroker', () => ({
  brokerSetPrivateKey: vi.fn(async (username: string, key: string) => {
    brokerKeys.set(username, key);
    return true;
  }),
  brokerGetPrivateKey: vi.fn(
    async (username: string) => brokerKeys.get(username) ?? null,
  ),
  brokerClearPrivateKey: vi.fn(async (username: string) => {
    brokerKeys.delete(username);
  }),
  brokerClearAllPrivateKeys: vi.fn(async () => {
    brokerKeys.clear();
  }),
}));
vi.mock('openpgp', () => ({
  readKey: vi.fn(async () => 'public'),
  readPrivateKey: vi.fn(async () => 'private'),
  createMessage: vi.fn(async ({ text }: { text: string }) => text),
  encrypt: vi.fn(
    async ({ message }: { message: string }) => `cipher:${message}`,
  ),
  readMessage: vi.fn(
    async ({ armoredMessage }: { armoredMessage: string }) => armoredMessage,
  ),
  decrypt: vi.fn(async ({ message }: { message: string }) => ({
    data: message.slice(7),
  })),
}));

const keys = {
  username: 'alice',
  userId: 'authoritative-id',
  privateKey: 'private-key',
  publicKey: 'public-key',
  serverPublicKey: 'tenant-public-key',
  sessionId: 'tenant-session',
};

describe('key and tenant session persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    brokerKeys.clear();
    window.history.replaceState({}, '', '/?server=tenant-id');
    vi.unstubAllGlobals();
  });

  it('restores keys and the tenant session after page memory is lost', async () => {
    const firstPage = await import('./gpg');
    await firstPage.storeKeys(keys, 'password');
    expect(localStorage.getItem('gpg_private_key')).not.toBe(keys.privateKey);
    vi.resetModules();
    const refreshedPage = await import('./gpg');
    await expect(refreshedPage.loadKeysAsync()).resolves.toEqual(keys);
    await expect(refreshedPage.loadKeysForUserAsync('alice')).resolves.toEqual(
      keys,
    );
  });

  it('does not reuse another tenant session or server public key', async () => {
    const gpg = await import('./gpg');
    await gpg.storeKeys(keys, 'password');
    window.history.replaceState({}, '', '/?server=other-tenant');
    for (const restored of [
      await gpg.loadKeysAsync(),
      await gpg.loadKeysForUserAsync('alice'),
    ]) {
      expect(restored).toMatchObject({
        userId: keys.userId,
        serverPublicKey: '',
      });
      expect(restored?.sessionId).toBeUndefined();
    }
  });

  it('fails closed when the volatile broker loses its private key', async () => {
    const gpg = await import('./gpg');
    await gpg.storeKeys(keys, 'password');
    brokerKeys.clear();
    vi.resetModules();
    await expect((await import('./gpg')).loadKeysAsync()).resolves.toBeNull();
  });

  it('resolves a known alias to the canonical tenant session', async () => {
    const registry = await import('./serverRegistry');
    registry.upsertServerMembership({
      serverId: 'tenant-id',
      alias: 'friendly',
      label: 'Tenant',
      username: 'alice',
      userId: keys.userId,
    });
    const gpg = await import('./gpg');
    await gpg.storeKeys(keys, 'password');
    window.history.replaceState({}, '', '/?server=friendly');
    await expect(gpg.loadKeysAsync()).resolves.toEqual(keys);
  });

  it('stores a background tenant session without activating it', async () => {
    const gpg = await import('./gpg');
    await gpg.storeKeys(keys, 'password');

    await gpg.updateStoredSessionForUser({
      username: 'alice',
      userId: keys.userId,
      sessionId: 'joined-session',
      serverPublicKey: 'joined-server-key',
      serverId: 'joined-tenant',
      makeActive: false,
    });

    expect(localStorage.getItem('gpg_session_id')).toBe(keys.sessionId);
    window.history.replaceState({}, '', '/?server=joined-tenant');
    await expect(gpg.loadKeysAsync()).resolves.toMatchObject({
      sessionId: 'joined-session',
      serverPublicKey: 'joined-server-key',
    });
    window.history.replaceState({}, '', '/?server=tenant-id');
    await expect(gpg.loadKeysAsync()).resolves.toMatchObject({
      sessionId: keys.sessionId,
      serverPublicKey: keys.serverPublicKey,
    });
  });

  it('does not mint an identity for auto-relogin without keys.userId', async () => {
    const gpg = await import('./gpg');
    await gpg.storeKeys({ ...keys, userId: undefined }, 'password');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(gpg.attemptAutoRelogin()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers an exact tenant ID over a different tenant alias', async () => {
    const registry = await import('./serverRegistry');
    registry.mergeServerMemberships([
      {
        serverId: 'tenant-id',
        alias: 'other-tenant',
        label: 'First',
        username: 'alice',
        userId: keys.userId,
      },
      {
        serverId: 'other-tenant',
        alias: 'second-alias',
        label: 'Second',
        username: 'alice',
        userId: keys.userId,
      },
    ]);
    const gpg = await import('./gpg');
    await gpg.storeKeys(keys, 'password');
    window.history.replaceState({}, '', '/?server=other-tenant');
    await gpg.updateStoredSessionForUser({
      username: 'alice',
      sessionId: 'other-session',
      serverPublicKey: 'other-key',
    });
    window.history.replaceState({}, '', '/?server=tenant-id');
    await expect(gpg.loadKeysAsync()).resolves.toEqual(keys);
    window.history.replaceState({}, '', '/?server=other-tenant');
    await expect(gpg.loadKeysAsync()).resolves.toMatchObject({
      sessionId: 'other-session',
      serverPublicKey: 'other-key',
    });
  });
});
