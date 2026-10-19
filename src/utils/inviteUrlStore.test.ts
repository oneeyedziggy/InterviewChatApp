import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureInviteRoute,
  inviteScopeKey,
  isSafeInviteUrl,
  loadInviteUrls,
  saveInviteUrls,
} from './inviteUrlStore';
import * as appPaths from './appPaths';

const mocks = vi.hoisted(() => ({
  loadKeysAsync: vi.fn(),
  encryptJsonForCurrentUser: vi.fn(),
  decryptJsonForCurrentUser: vi.fn(),
  loadServerMemberships: vi.fn(),
}));
vi.mock('./gpg', () => mocks);
vi.mock('./serverRegistry', () => mocks);

const scope = {
  origin: window.location.origin,
  serverId: 'tenant-1',
  userId: 'alice-id',
};
const url = `${scope.origin}/login?invite=secret&server=tenant-1`;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/?server=friendly');
  mocks.loadServerMemberships.mockReturnValue([
    { serverId: 'tenant-1', alias: 'friendly', label: 'Friends' },
  ]);
  mocks.loadKeysAsync.mockResolvedValue({ userId: 'alice-id' });
  mocks.encryptJsonForCurrentUser.mockResolvedValue('encrypted-armored');
  mocks.decryptJsonForCurrentUser.mockResolvedValue({
    version: 1,
    scope: [scope.origin, scope.serverId, scope.userId],
    urls: { invite1: url },
  });
});

describe('encrypted local invite URLs', () => {
  it('encrypts with existing helpers, persists no plaintext, and recovers by stable ID', async () => {
    await saveInviteUrls(scope, { invite1: url });
    expect(localStorage.getItem(inviteScopeKey(scope))).toBe(
      'encrypted-armored',
    );
    expect(mocks.encryptJsonForCurrentUser).toHaveBeenCalledWith({
      version: 1,
      scope: [scope.origin, scope.serverId, scope.userId],
      urls: { invite1: url },
    });
    expect(await loadInviteUrls(scope)).toEqual({ invite1: url });
    expect(mocks.decryptJsonForCurrentUser).toHaveBeenCalledWith(
      'encrypted-armored',
    );
    expect(captureInviteRoute().serverId).toBe('tenant-1');
  });

  it.each([
    { ...scope, userId: 'bob-id' },
    { ...scope, serverId: 'tenant-2' },
    { ...scope, serverId: '' },
    { ...scope, origin: 'https://other.example' },
  ])('isolates scope %j', async (other) => {
    await saveInviteUrls(scope, { invite1: url });
    expect(inviteScopeKey(other)).not.toBe(inviteScopeKey(scope));
    expect(await loadInviteUrls(other)).toEqual({});
  });

  it('rejects a mismatched decrypted envelope and filters unsafe URLs', async () => {
    localStorage.setItem(inviteScopeKey(scope), 'cipher');
    mocks.decryptJsonForCurrentUser.mockResolvedValueOnce({
      version: 1,
      scope: ['other'],
      urls: { invite1: url },
    });
    await expect(loadInviteUrls(scope)).rejects.toThrow('Invalid local');
    mocks.decryptJsonForCurrentUser.mockResolvedValueOnce({
      version: 1,
      scope: [scope.origin, scope.serverId, scope.userId],
      urls: {
        good: url,
        bad: 'https://evil.example/login?invite=secret&server=tenant-1',
      },
    });
    expect(await loadInviteUrls(scope)).toEqual({ good: url });
  });

  it.each([
    'javascript:alert(1)',
    `${scope.origin}/login?invite=x&server=tenant-2`,
    `${scope.origin}/other?invite=x&server=tenant-1`,
    `${scope.origin}/login?invite=x&invite=y&server=tenant-1`,
    `${scope.origin}/login?server=tenant-1`,
  ])('rejects unsafe URL %s', (value) => {
    expect(isSafeInviteUrl(value, scope)).toBe(false);
  });

  it('does not write after switching account during encryption', async () => {
    mocks.encryptJsonForCurrentUser.mockImplementationOnce(async () => {
      mocks.loadKeysAsync.mockResolvedValue({ userId: 'bob-id' });
      return 'cipher';
    });
    await expect(saveInviteUrls(scope, { invite1: url })).rejects.toThrow(
      'changed',
    );
    expect(localStorage.length).toBe(0);
  });

  it('keeps default-tenant links in their separate namespace', async () => {
    window.history.replaceState({}, '', '/');
    const defaultScope = { ...scope, serverId: '' };
    const defaultUrl = `${scope.origin}/login?invite=default-secret`;
    expect(captureInviteRoute().serverId).toBe('');
    expect(isSafeInviteUrl(defaultUrl, defaultScope)).toBe(true);
    expect(isSafeInviteUrl(defaultUrl, scope)).toBe(false);
    await saveInviteUrls(defaultScope, { default1: defaultUrl });
    expect(localStorage.getItem(inviteScopeKey(defaultScope))).toBe(
      'encrypted-armored',
    );
    expect(localStorage.getItem(inviteScopeKey(scope))).toBeNull();
  });

  it('validates the configured base-path login route', () => {
    const route = vi
      .spyOn(appPaths, 'withBasePath')
      .mockReturnValue('/chatApp/login');
    try {
      expect(
        isSafeInviteUrl(
          `${scope.origin}/chatApp/login?invite=secret&server=tenant-1`,
          scope,
        ),
      ).toBe(true);
      expect(isSafeInviteUrl(url, scope)).toBe(false);
    } finally {
      route.mockRestore();
    }
  });

  it('prefers canonical IDs and does not merge ambiguous aliases', () => {
    mocks.loadServerMemberships.mockReturnValue([
      { serverId: 'tenant-1', alias: 'friendly' },
      { serverId: 'tenant-2', alias: 'friendly' },
    ]);
    expect(captureInviteRoute().serverId).toBe('friendly');
    window.history.replaceState({}, '', '/?server=tenant-1');
    expect(captureInviteRoute().serverId).toBe('tenant-1');
  });

  it('discards cache recovery when the server changes during decryption', async () => {
    localStorage.setItem(inviteScopeKey(scope), 'cipher');
    mocks.decryptJsonForCurrentUser.mockImplementationOnce(async () => {
      window.history.replaceState({}, '', '/?server=other');
      return {
        version: 1,
        scope: [scope.origin, scope.serverId, scope.userId],
        urls: { invite1: url },
      };
    });
    expect(await loadInviteUrls(scope)).toEqual({});
  });

  it('propagates unavailable storage and corrupt encryption for useful UI feedback', async () => {
    localStorage.setItem(inviteScopeKey(scope), 'bad-cipher');
    mocks.decryptJsonForCurrentUser.mockRejectedValueOnce(
      new Error('Corrupt cache'),
    );
    await expect(loadInviteUrls(scope)).rejects.toThrow('Corrupt');
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage full');
      });
    await expect(saveInviteUrls(scope, { invite1: url })).rejects.toThrow(
      'Storage full',
    );
    storage.mockRestore();
  });
});
