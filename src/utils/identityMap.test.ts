import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadIdentityMap = async () => {
  return import('./identityMap');
};

describe('identityMap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('stores and resolves identity directories', async () => {
    const identityMap = await loadIdentityMap();

    identityMap.storeIdentityDirectories({
      userDirectory: { 'user-a': 'alice' },
      roomDirectory: { 'room-a': 'general' },
      userDirectoryUpdatedAt: { 'user-a': 100 },
      roomDirectoryUpdatedAt: { 'room-a': 100 },
      currentUserId: 'user-a',
    });

    expect(identityMap.getUserIdByUsername('alice')).toBe('user-a');
    expect(identityMap.getRoomIdByName('general')).toBe('room-a');
    expect(identityMap.getUsernameByUserId('user-a')).toBe('alice');
    expect(identityMap.getRoomNameByRoomId('room-a')).toBe('general');
    expect(identityMap.getCurrentUserId()).toBe('user-a');
    expect(identityMap.getUserDirectorySnapshot()).toEqual({
      'user-a': 'alice',
    });
    expect(identityMap.getRoomDirectorySnapshot()).toEqual({
      'room-a': 'general',
    });
  });

  it('keeps newer directory entries when stale updates arrive', async () => {
    const identityMap = await loadIdentityMap();

    identityMap.storeIdentityDirectories({
      userDirectory: { 'user-a': 'alice' },
      roomDirectory: { 'room-a': 'general' },
      userDirectoryUpdatedAt: { 'user-a': 200 },
      roomDirectoryUpdatedAt: { 'room-a': 200 },
    });

    identityMap.storeIdentityDirectories({
      userDirectory: { 'user-a': 'ally' },
      roomDirectory: { 'room-a': 'lounge' },
      userDirectoryUpdatedAt: { 'user-a': 100 },
      roomDirectoryUpdatedAt: { 'room-a': 100 },
    });

    expect(identityMap.getUsernameByUserId('user-a')).toBe('alice');
    expect(identityMap.getRoomNameByRoomId('room-a')).toBe('general');
  });

  it('creates local mappings for missing required user ids and rejects missing room ids', async () => {
    const identityMap = await loadIdentityMap();

    const userId = identityMap.requireUserIdByUsername('bob');

    expect(userId).toMatch(/^user:/);
    expect(identityMap.getUserIdByUsername('bob')).toBe(userId);
    expect(() => identityMap.requireRoomIdByName('lobby')).toThrow(
      'Missing roomId mapping for room: lobby',
    );
  });

  it('passes DM room ids through and rejects missing mappings', async () => {
    const identityMap = await loadIdentityMap();

    expect(identityMap.requireRoomIdByName('@dmid:a|b')).toBe('@dmid:a|b');
    expect(() => identityMap.requireRoomIdByName('missing')).toThrow(
      'Missing roomId mapping for room: missing',
    );
  });
});
