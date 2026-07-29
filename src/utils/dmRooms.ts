import {
  getRoomNameByRoomId,
  getUsernameByUserId,
  requireUserIdByUsername,
} from './identityMap';

/** Canonical DM room id: @dmid:<userIdA>:<userIdB> (sorted user IDs). */
export function getDmRoomId(userA: string, userB: string): string {
  const userAId = requireUserIdByUsername(userA);
  const userBId = requireUserIdByUsername(userB);
  const [first, second] = [userAId, userBId].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return `@dmid:${first}:${second}`;
}

export function isDmRoom(room: string): boolean {
  return room.startsWith('@dmid:');
}

/** Other participant's username for display in the room list */
export function getDmDisplayName(
  room: string,
  currentUser: string,
): string | null {
  if (!isDmRoom(room)) return null;
  if (!currentUser) return null;
  const currentUserId = requireUserIdByUsername(currentUser);
  const parts = room.split(':');
  if (parts.length !== 3) return null;
  const [, userAId, userBId] = parts;
  if (userAId === currentUserId)
    return getUsernameByUserId(userBId) ?? 'Direct Message';
  if (userBId === currentUserId)
    return getUsernameByUserId(userAId) ?? 'Direct Message';
  return null;
}

export function getDmParticipants(room: string): string[] | null {
  if (!isDmRoom(room)) return null;
  const parts = room.split(':');
  if (parts.length !== 3) return null;
  return [parts[1], parts[2]];
}

export function isUserInDmRoom(room: string, username: string): boolean {
  const participants = getDmParticipants(room);
  if (!participants) return false;
  if (!username) return false;
  const userId = requireUserIdByUsername(username);
  return participants.includes(userId);
}

export function filterRoomsForUser(
  rooms: string[],
  username: string,
): string[] {
  if (!username) return rooms;

  return rooms.filter((room) => {
    if (!isDmRoom(room)) return true;
    return isUserInDmRoom(room, username);
  });
}

export function getRoomDisplayLabel(room: string, currentUser: string): string {
  const dmName = getDmDisplayName(room, currentUser);
  if (dmName) {
    return dmName;
  }
  return getRoomNameByRoomId(room) ?? room;
}
