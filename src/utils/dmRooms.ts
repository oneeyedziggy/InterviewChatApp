import {
  getUserIdByUsername,
  getRoomNameByRoomId,
  getUsernameByUserId,
  requireUserIdByUsername,
} from './identityMap';

/** Canonical DM room id: @dmid:<userIdA>|<userIdB> (sorted user IDs). */
const userIdsEquivalent = (a: string, b: string):  boolean => {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) {
    return false;
  }
  return left === right;
};

const looksLikeUserId = (value: string):  boolean => {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized,
  );
};

const resolveUserId = (userOrId: string):  string => {
  const normalized = userOrId.trim();
  if (!normalized) {
    return normalized;
  }

  if (looksLikeUserId(normalized)) {
    return normalized;
  }

  // If input already resolves as a known user ID, keep it as-is.
  if (getUsernameByUserId(normalized)) {
    return normalized;
  }

  const mapped = getUserIdByUsername(normalized);
  if (mapped) {
    return mapped;
  }

  return requireUserIdByUsername(normalized);
};

const resolveUsernameForDisplay = (userId: string):  string | null => {
  const normalized = userId.trim();
  if (!normalized) {
    return null;
  }

  return getUsernameByUserId(normalized) || null;
};

export const getDmRoomId = (userA: string, userB: string):  string => {
  const userAId = resolveUserId(userA);
  const userBId = resolveUserId(userB);
  const [first, second] = [userAId, userBId].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return `@dmid:${first}|${second}`;
};

const resolveEffectiveRoomName = (room: string):  string => {
  return getRoomNameByRoomId(room) || room;
};

export const isDmRoom = (room: string):  boolean => {
  return resolveEffectiveRoomName(room).startsWith('@dmid:');
};

/** Other participant's username for display in the room list */
export const getDmDisplayName = (
  room: string,
  currentUser: string,):  string | null => {
  if (!isDmRoom(room)) return null;
  if (!currentUser) return null;
  const participants = getDmParticipants(room);
  if (!participants) return null;

  const [userAId, userBId] = participants;
  const currentUserId = looksLikeUserId(currentUser)
    ? currentUser
    : getUserIdByUsername(currentUser) || '';

  if (currentUserId) {
    if (userIdsEquivalent(userAId, currentUserId)) {
      const other = resolveUsernameForDisplay(userBId) ?? 'direct-message';
      return `@${other}`;
    }
    if (userIdsEquivalent(userBId, currentUserId)) {
      const other = resolveUsernameForDisplay(userAId) ?? 'direct-message';
      return `@${other}`;
    }
  }

  const userAName = resolveUsernameForDisplay(userAId);
  const userBName = resolveUsernameForDisplay(userBId);
  if (userAName && userAName !== currentUser) {
    return `@${userAName}`;
  }
  if (userBName && userBName !== currentUser) {
    return `@${userBName}`;
  }

  return null;
};

export const getDmParticipants = (room: string):  string[] | null => {
  if (!isDmRoom(room)) return null;
  const rest = resolveEffectiveRoomName(room).slice('@dmid:'.length);

  const [first, second] = rest.split('|', 2);
  if (!first || !second) return null;
  return [first, second];
};

export const isUserInDmRoom = (room: string, username: string):  boolean => {
  const participants = getDmParticipants(room);
  if (!participants) return false;
  if (!username) return false;
  const userId = looksLikeUserId(username)
    ? username
    : getUserIdByUsername(username) || '';
  if (!userId) {
    return false;
  }
  return participants.some((participant) =>
    userIdsEquivalent(participant, userId),
  );
};

export const filterRoomsForUser = (
  rooms: string[],
  username: string,):  string[] => {
  if (!username) return rooms;

  return rooms.filter((room) => {
    if (!isDmRoom(room)) return true;
    return isUserInDmRoom(room, username);
  });
};

export const getRoomDisplayLabel = (room: string, currentUser: string):  string => {
  const effectiveRoom = resolveEffectiveRoomName(room);
  const dmName = getDmDisplayName(effectiveRoom, currentUser);
  if (dmName) {
    return dmName;
  }
  return effectiveRoom;
};
