import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gpgMock = vi.hoisted(() => ({
  attemptAutoRelogin: vi.fn(),
  hasValidStoredKeys: vi.fn(),
  loadKeys: vi.fn(),
}));

const identityMapMock = vi.hoisted(() => ({
  storeIdentityDirectories: vi.fn(),
}));

vi.mock('./gpg', () => gpgMock);
vi.mock('./identityMap', () => identityMapMock);

import { apiPath } from './appPaths';
import { restoreSession } from './homeSession';

describe('homeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forces reauth when stored keys are invalid', async () => {
    gpgMock.loadKeys.mockReturnValue({ sessionId: 'session-a' });
    gpgMock.hasValidStoredKeys.mockResolvedValue(false);
    const onForceReauth = vi.fn();

    await restoreSession({
      isCancelled: () => false,
      initializeSession: vi.fn(),
      onForceReauth,
    });

    expect(onForceReauth).toHaveBeenCalledTimes(1);
  });

  it('restores the session after a successful verification', async () => {
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
    gpgMock.loadKeys.mockReturnValue({
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
});
