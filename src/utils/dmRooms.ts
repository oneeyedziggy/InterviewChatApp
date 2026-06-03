/** Canonical DM room id: @dm:alice:bob (sorted usernames) */
export function getDmRoomId(userA: string, userB: string): string {
  const [first, second] = [userA, userB].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
  return `@dm:${first}:${second}`;
}

export function isDmRoom(room: string): boolean {
  return room.startsWith('@dm:');
}

/** Other participant's username for display in the room list */
export function getDmDisplayName(room: string, currentUser: string): string | null {
  if (!isDmRoom(room)) return null;
  const parts = room.split(':');
  if (parts.length !== 3) return null;
  const [, userA, userB] = parts;
  if (userA === currentUser) return userB;
  if (userB === currentUser) return userA;
  return null;
}

export function getDmParticipants(room: string): string[] | null {
  if (!isDmRoom(room)) return null;
  const parts = room.split(':');
  if (parts.length !== 3) return null;
  return [parts[1], parts[2]];
}

export function getRoomDisplayLabel(room: string, currentUser: string): string {
  const dmName = getDmDisplayName(room, currentUser);
  return dmName ?? room;
}
