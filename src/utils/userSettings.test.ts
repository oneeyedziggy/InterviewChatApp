import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadUserSettings() {
  return import('./userSettings');
}

describe('userSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('blocks, unblocks, and exports users for the current local username', async () => {
    const userSettings = await loadUserSettings();

    localStorage.setItem('gpg_username', 'carol');
    localStorage.setItem(
      'gpg_user_public_keys',
      JSON.stringify({ alice: { publicKey: 'pub-alice' } }),
    );

    expect(userSettings.isUserBlocked('alice')).toBe(false);

    userSettings.blockUser('alice');

    const stored = JSON.parse(
      localStorage.getItem('gpg_user_public_keys') || '{}',
    );
    expect(stored.alice.blocked).toBe(true);
    expect(stored.alice.blockedBy).toEqual(['carol']);
    expect(userSettings.getBlockedUsers()).toEqual(['alice']);
    expect(userSettings.getBlockedUserExportsForCurrentUser()).toEqual({
      alice: { blockedBy: ['carol'], blockedAt: expect.any(Number) },
    });

    const blockedAt = userSettings.unblockUser('alice');
    expect(typeof blockedAt).toBe('number');
    expect(userSettings.isUserBlocked('alice')).toBe(false);
    expect(userSettings.getBlockedUsers()).toEqual([]);
  });

  it('falls back to entry-level blocked flags when no local username exists', async () => {
    const userSettings = await loadUserSettings();

    localStorage.setItem(
      'gpg_user_public_keys',
      JSON.stringify({ bob: { publicKey: 'pub-bob', blocked: true } }),
    );

    expect(userSettings.isUserBlocked('bob')).toBe(true);
    expect(userSettings.getBlockedUsers()).toEqual(['bob']);
  });

  it('handles malformed entries and empty usernames safely', async () => {
    const userSettings = await loadUserSettings();

    localStorage.setItem(
      'gpg_user_public_keys',
      JSON.stringify({
        alice: 'pub-alice',
        bob: { publicKey: 'pub-bob', blockedBy: ['carol'] },
        carol: { publicKey: 'pub-carol', blockedAt: 123, blocked: false },
        dave: { publicKey: 42 },
      }),
    );

    expect(userSettings.isUserBlocked('')).toBe(false);
    expect(userSettings.isUserBlocked('alice')).toBe(false);
    expect(userSettings.isUserBlocked('bob')).toBe(false);
    expect(userSettings.getBlockedUsers()).toEqual([]);
    expect(userSettings.getBlockedUserExportsForCurrentUser()).toEqual({});
  });

  it('returns undefined when unblocking a missing user', async () => {
    const userSettings = await loadUserSettings();

    expect(userSettings.unblockUser('missing')).toBeUndefined();
  });
});
