import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMembership } from './serverRegistry';

const gpgMock = vi.hoisted(() => ({
  attemptAutoRelogin: vi.fn(),
  hasValidStoredKeys: vi.fn(),
  loadKeysAsync: vi.fn(),
  fetchServerPublicKey: vi.fn(async () => 'server-pub'),
  updateStoredSessionForUser: vi.fn(async () => {}),
}));

const serverRegistryMock = vi.hoisted(() => ({
  loadServerMembershipsAsync: vi.fn(async (): Promise<ServerMembership[]> => []),
}));

const identityMapMock = vi.hoisted(() => ({
  storeIdentityDirectories: vi.fn(),
}));

vi.mock('./gpg', () => gpgMock);
vi.mock('./identityMap', () => identityMapMock);
vi.mock('./serverRegistry', () => serverRegistryMock);

import { apiPath } from './appPaths';
import {
  restoreSession,
  revalidateSessionIfStale,
  resetSessionRevalidationThrottle,
  SESSION_REVALIDATE_INTERVAL_MS,
} from './homeSession';

describe('homeSession', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
    serverRegistryMock.loadServerMembershipsAsync.mockResolvedValue([]);
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forces reauth when stored keys are invalid', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({ sessionId: 'session-a' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(false);
    const onForceReauth = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession: vi.fn(),
      onForceReauth,
    });

    expect(onForceReauth).toHaveBeenCalledTimes(1);
  });

  it('recovers a missing tenant session for a known authoritative membership', async () => {
    window.history.replaceState({}, '', '/?server=friendly');
    gpgMock.loadKeysAsync.mockResolvedValue({ username: 'alice', userId: 'account-id' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    serverRegistryMock.loadServerMembershipsAsync.mockResolvedValue([
      { serverId: 'tenant-id', alias: 'friendly', label: 'Tenant', username: 'alice', userId: 'account-id' },
    ]);
    gpgMock.attemptAutoRelogin.mockResolvedValue('recovered-session');
    const initializeSession = vi.fn();
    const onForceReauth = vi.fn();
    await restoreSession({ isCancelled: () => false, initializeSession, onForceReauth });
    expect(initializeSession).toHaveBeenCalledWith('recovered-session', 'alice');
    expect(onForceReauth).not.toHaveBeenCalled();
  });

  it('does not auto-login a missing session for another tenant or account', async () => {
    window.history.replaceState({}, '', '/?server=tenant-id');
    gpgMock.loadKeysAsync.mockResolvedValue({ username: 'alice', userId: 'account-id' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    for (const membership of [
      { serverId: 'other-tenant', label: 'Other', username: 'alice', userId: 'account-id' },
      { serverId: 'tenant-id', label: 'Tenant', username: 'alice', userId: 'other-account' },
    ]) {
      serverRegistryMock.loadServerMembershipsAsync.mockResolvedValue([membership]);
      const onForceReauth = vi.fn();
      await restoreSession({ isCancelled: () => false, initializeSession: vi.fn(), onForceReauth });
      expect(onForceReauth).toHaveBeenCalledOnce();
    }
    expect(gpgMock.attemptAutoRelogin).not.toHaveBeenCalled();
  });

  it('forces reauth after missing-session recovery fails twice', async () => {
    window.history.replaceState({}, '', '/?server=tenant-id');
    gpgMock.loadKeysAsync.mockResolvedValue({ username: 'alice', userId: 'account-id' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    serverRegistryMock.loadServerMembershipsAsync.mockResolvedValue([
      { serverId: 'tenant-id', label: 'Tenant', username: 'alice', userId: 'account-id' },
    ]);
    gpgMock.attemptAutoRelogin.mockResolvedValue(null);
    const onForceReauth = vi.fn();
    await restoreSession({ isCancelled: () => false, initializeSession: vi.fn(), onForceReauth });
    expect(gpgMock.attemptAutoRelogin).toHaveBeenCalledTimes(2);
    expect(onForceReauth).toHaveBeenCalledOnce();
  });

  it('keeps an unlocked account on the shell when no server is active', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({ username: 'alice', userId: 'account-id' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    serverRegistryMock.loadServerMembershipsAsync.mockResolvedValue([
      { serverId: 'tenant-id', label: 'Tenant', username: 'alice', userId: 'account-id' },
    ]);
    const onForceReauth = vi.fn();
    await restoreSession({ isCancelled: () => false, initializeSession: vi.fn(), onForceReauth });
    expect(gpgMock.attemptAutoRelogin).not.toHaveBeenCalled();
    expect(onForceReauth).not.toHaveBeenCalled();
  });

  it('restores the session after a successful verification', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, userId: 'user-a' }),
    }) as any;

    const initializeSession = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession,
      onForceReauth: vi.fn(),
    });

    expect(global.fetch).toHaveBeenCalledWith(apiPath('/api/auth'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    });
    expect(identityMapMock.storeIdentityDirectories).toHaveBeenCalledWith({
      userDirectory: { 'user-a': 'alice' },
      currentUserId: 'user-a',
    });
    expect(initializeSession).toHaveBeenCalledWith('session-a', 'alice');
  });

  it('falls back to auto relogin when server verification fails', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    gpgMock.attemptAutoRelogin.mockResolvedValue('session-b');
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as any;

    const initializeSession = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession,
      onForceReauth: vi.fn(),
    });

    expect(gpgMock.attemptAutoRelogin).toHaveBeenCalledTimes(1);
    expect(initializeSession).toHaveBeenCalledWith('session-b', 'alice');
  });

  it('forces reauth when the server response is not ok and auto relogin does not recover', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    gpgMock.attemptAutoRelogin.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    const onForceReauth = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession: vi.fn(),
      onForceReauth,
    });

    expect(onForceReauth).toHaveBeenCalledTimes(1);
  });

  it('forces reauth when invalid payloads cannot be recovered', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    gpgMock.attemptAutoRelogin.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false }),
    }) as any;
    const onForceReauth = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession: vi.fn(),
      onForceReauth,
    });

    expect(onForceReauth).toHaveBeenCalledTimes(1);
  });

  it('falls back to auto relogin from the catch path when verification throws', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    gpgMock.attemptAutoRelogin.mockResolvedValue('session-b');
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as any;

    const initializeSession = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession,
      onForceReauth: vi.fn(),
    });

    expect(initializeSession).toHaveBeenCalledWith('session-b', 'alice');
  });

  it('skips initialization when the restore operation is cancelled', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, userId: 'user-a' }),
    }) as any;

    const initializeSession = vi.fn();
    const onForceReauth = vi.fn();

    await restoreSession({
      isCancelled: () => true,
      initializeSession,
      onForceReauth,
    });

    expect(initializeSession).not.toHaveBeenCalled();
    expect(onForceReauth).not.toHaveBeenCalled();
  });

  it('handles invalid server payloads without crashing', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false }),
    }) as any;
    gpgMock.attemptAutoRelogin.mockResolvedValue('session-b');

    const initializeSession = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession,
      onForceReauth: vi.fn(),
    });

    expect(initializeSession).toHaveBeenCalledWith('session-b', 'alice');
  });

  it('uses the stored session id when the response has no user id', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({
      sessionId: 'session-a',
      username: 'alice',
    });
    gpgMock.hasValidStoredKeys.mockResolvedValue(true);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true }),
    }) as any;

    const initializeSession = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession,
      onForceReauth: vi.fn(),
    });

    expect(initializeSession).toHaveBeenCalledWith('session-a', 'alice');
    expect(identityMapMock.storeIdentityDirectories).not.toHaveBeenCalled();
  });

  describe('revalidateSessionIfStale', () => {
    beforeEach(() => {
      resetSessionRevalidationThrottle();
    });

    it('revalidates once and throttles immediate repeat checks', async () => {
      gpgMock.loadKeysAsync.mockResolvedValue({
        sessionId: 'session-a',
        username: 'alice',
      });
      gpgMock.hasValidStoredKeys.mockResolvedValue(true);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ valid: true, userId: 'user-a' }),
      }) as any;

      const options = {
        isCancelled: () => false,
        initializeSession: vi.fn(),
        onForceReauth: vi.fn(),
      };

      await revalidateSessionIfStale({ ...options, now: 1_000_000 });
      await revalidateSessionIfStale({ ...options, now: 1_000_500 });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('revalidates again once the throttle window elapses', async () => {
      gpgMock.loadKeysAsync.mockResolvedValue({
        sessionId: 'session-a',
        username: 'alice',
      });
      gpgMock.hasValidStoredKeys.mockResolvedValue(true);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ valid: true, userId: 'user-a' }),
      }) as any;

      const options = {
        isCancelled: () => false,
        initializeSession: vi.fn(),
        onForceReauth: vi.fn(),
      };

      await revalidateSessionIfStale({ ...options, now: 2_000_000 });
      await revalidateSessionIfStale({
        ...options,
        now: 2_000_000 + SESSION_REVALIDATE_INTERVAL_MS + 1,
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no session is stored', async () => {
      gpgMock.loadKeysAsync.mockResolvedValue({ username: 'alice' });
      global.fetch = vi.fn() as any;

      await revalidateSessionIfStale({
        isCancelled: () => false,
        initializeSession: vi.fn(),
        onForceReauth: vi.fn(),
        now: 3_000_000,
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
