import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identityState = {
  currentUserId: 'viewer-id',
  usernamesByUserId: new Map<string, string>(),
  userIdsByUsername: new Map<string, string>(),
  roomNamesByRoomId: new Map<string, string>(),
  blockedUsers: new Set<string>(),
};

vi.mock('./identityMap', () => ({
  getCurrentUserId: () => identityState.currentUserId,
  getUsernameByUserId: (userId: string) =>
    identityState.usernamesByUserId.get(userId),
  getUserIdByUsername: (username: string) =>
    identityState.userIdsByUsername.get(username),
  getRoomNameByRoomId: (roomId: string) =>
    identityState.roomNamesByRoomId.get(roomId),
  requireUserIdByUsername: (username: string) => {
    const userId = identityState.userIdsByUsername.get(username);
    if (!userId) {
      throw new Error(`Missing userId mapping for username: ${username}`);
    }
    return userId;
  },
}));

vi.mock('./userSettings', () => ({
  isUserBlocked: (username: string) => identityState.blockedUsers.has(username),
}));

describe('messages and DM room helpers', () => {
  beforeEach(() => {
    identityState.currentUserId = 'viewer-id';
    identityState.usernamesByUserId.clear();
    identityState.userIdsByUsername.clear();
    identityState.roomNamesByRoomId.clear();
    identityState.blockedUsers.clear();
  });

  afterEach(() => {
    identityState.currentUserId = 'viewer-id';
    identityState.usernamesByUserId.clear();
    identityState.userIdsByUsername.clear();
    identityState.roomNamesByRoomId.clear();
    identityState.blockedUsers.clear();
  });

  it('resolves canonical DM ids and labels', async () => {
    identityState.userIdsByUsername.set('alice', 'user-a');
    identityState.userIdsByUsername.set('bob', 'user-b');
    identityState.usernamesByUserId.set('user-a', 'alice');
    identityState.usernamesByUserId.set('user-b', 'bob');
    identityState.roomNamesByRoomId.set('room-1', '@dmid:user-a|user-b');

    const dmRooms = await import('./dmRooms');

    expect(dmRooms.getDmRoomId('bob', 'alice')).toBe('@dmid:user-a|user-b');
    expect(dmRooms.isDmRoom('room-1')).toBe(true);
    expect(dmRooms.getDmParticipants('room-1')).toEqual(['user-a', 'user-b']);
    expect(dmRooms.getDmDisplayName('room-1', 'alice')).toBe('@bob');
    expect(dmRooms.isUserInDmRoom('room-1', 'bob')).toBe(true);
    expect(dmRooms.filterRoomsForUser(['room-1', 'general'], 'alice')).toEqual([
      'room-1',
      'general',
    ]);
    expect(dmRooms.getRoomDisplayLabel('room-1', 'alice')).toBe('@bob');
  });

  it('handles visible and hidden message combinations', async () => {
    identityState.usernamesByUserId.set('author-id', 'author');
    identityState.blockedUsers.add('author');

    const messages = await import('./messages');

    expect(messages.getUtf8ByteLength('abc')).toBe(3);
    expect(
      messages.canUserViewMessage({
        timestamp: 1,
        userId: 'author-id',
        roomId: 'room-1',
        content: 'plain text',
      }),
    ).toBe(false);

    identityState.blockedUsers.clear();
    expect(
      messages.canUserViewMessage({
        timestamp: 1,
        userId: 'author-id',
        roomId: 'room-1',
        content: 'plain text',
      }),
    ).toBe(true);

    expect(
      messages.canUserViewMessage({
        timestamp: 2,
        userId: 'author-id',
        roomId: 'room-1',
        content: '[Encrypted message]',
        encryptedFor: { 'viewer-id': 'cipher' },
      }),
    ).toBe(true);

    expect(
      messages.canUserViewMessage({
        timestamp: 3,
        userId: 'author-id',
        roomId: 'room-1',
        content: '[Encrypted message]',
        versions: [
          {
            version: 1,
            timestamp: 3,
            encryptedFor: { 'viewer-id': 'cipher' },
          },
        ],
      }),
    ).toBe(true);

    expect(
      messages.canUserViewMessage({
        timestamp: 4,
        userId: 'author-id',
        roomId: 'room-1',
        content: '[Encrypted message]',
        encryptedMessage: 'cipher',
      }),
    ).toBe(true);
  });
});
