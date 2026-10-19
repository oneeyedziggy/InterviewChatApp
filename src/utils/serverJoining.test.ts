import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpaqueUsernameEnvelope,
  decryptMessage,
  fetchServerPublicKey,
  loadKeysAsync,
  updateStoredSessionForUser,
  verifyChallengeResponseWithKeyRefresh,
} from './gpg';
import { storeIdentityDirectories } from './identityMap';
import { upsertServerMembership } from './serverRegistry';
import { joinServerFromInvite } from './serverJoining';

vi.mock('./gpg', () => ({
  buildOpaqueUsernameEnvelope: vi.fn(),
  decryptMessage: vi.fn(),
  fetchServerPublicKey: vi.fn(),
  loadKeysAsync: vi.fn(),
  updateStoredSessionForUser: vi.fn(),
  verifyChallengeResponseWithKeyRefresh: vi.fn(),
}));

vi.mock('./identityMap', () => ({
  storeIdentityDirectories: vi.fn(),
}));

vi.mock('./serverRegistry', () => ({
  upsertServerMembership: vi.fn(),
}));

const invite = {
  serverId: 'tenant-42',
  inviteCode: 'one-time-code',
  serverLabel: 'Glink',
};

const keys = {
  username: 'alice',
  userId: 'user-1',
  privateKey: 'unlocked-private-key',
  publicKey: 'public-key',
  serverPublicKey: 'active-server-key',
};

const response = (body: unknown, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(body),
});

describe('joinServerFromInvite', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(loadKeysAsync).mockResolvedValue(keys);
    vi.mocked(fetchServerPublicKey).mockResolvedValue('target-server-key');
    vi.mocked(buildOpaqueUsernameEnvelope).mockResolvedValue({
      usernameHash: 'username-hash',
      usernameCiphertext: 'username-ciphertext',
    });
    vi.mocked(upsertServerMembership).mockImplementation((membership) => [
      membership,
    ]);
  });

  it('registers with the invite on the target server and stores membership after success', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ alias: 'bright-field' }))
      .mockResolvedValueOnce(
        response({ sessionId: 'target-session', userId: 'user-1' }),
      );

    const joined = await joinServerFromInvite(invite);

    expect(fetchServerPublicKey).toHaveBeenCalledWith('tenant-42');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/server-status?server=tenant-42',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/login?server=tenant-42',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('one-time-code'),
      }),
    );
    expect(updateStoredSessionForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'tenant-42',
        sessionId: 'target-session',
        serverPublicKey: 'target-server-key',
        makeActive: false,
      }),
    );
    expect(upsertServerMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'tenant-42',
        alias: 'bright-field',
        label: 'Glink',
      }),
    );
    expect(joined.sessionId).toBe('target-session');
  });

  it('completes an existing-account challenge against the explicit target server', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ alias: 'bright-field' }))
      .mockResolvedValueOnce(response({ challenge: 'encrypted-challenge' }));
    vi.mocked(decryptMessage).mockResolvedValue('challenge-uuid');
    vi.mocked(verifyChallengeResponseWithKeyRefresh).mockResolvedValue({
      sessionId: 'verified-session',
      userId: 'user-1',
      serverPublicKey: 'target-server-key',
    });

    await joinServerFromInvite(invite);

    expect(verifyChallengeResponseWithKeyRefresh).toHaveBeenCalledWith({
      userId: 'user-1',
      decryptedUUID: 'challenge-uuid',
      serverPublicKey: 'target-server-key',
      serverId: 'tenant-42',
    });
    expect(updateStoredSessionForUser).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'verified-session' }),
    );
  });

  it('does not store a session or membership when the invite is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ alias: 'bright-field' }))
      .mockResolvedValueOnce(
        response({ error: 'This invite has expired.' }, false),
      );

    await expect(joinServerFromInvite(invite)).rejects.toThrow(
      'This invite has expired.',
    );
    expect(updateStoredSessionForUser).not.toHaveBeenCalled();
    expect(storeIdentityDirectories).not.toHaveBeenCalled();
    expect(upsertServerMembership).not.toHaveBeenCalled();
  });
});
