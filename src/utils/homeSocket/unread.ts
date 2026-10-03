import { type Message, type Messages } from '../../types/types';
import { isDmRoom, isUserInDmRoom } from '../dmRooms';
import { messageIdentity, scrubMessagesForLocalState } from './messageState';

export const computeUnreadIncrements = (
  incoming: Messages,
  previousChatValues: Messages,
  currentRoom: string,
  blockedUsers: Set<string>,
): Record<string, number> => {
  const increments: Record<string, number> = {};
  for (const [room, messages] of Object.entries(incoming)) {
    const scrubbed = scrubMessagesForLocalState(messages, blockedUsers);
    const existingRoomMessages: Message[] | undefined =
      previousChatValues[room];

    if (!existingRoomMessages) {
      increments[room] = room === currentRoom ? 0 : scrubbed.length;
      continue;
    }

    const existingIdentities = new Set(
      existingRoomMessages.map((message) => messageIdentity(message)),
    );
    increments[room] = scrubbed.filter(
      (message) => !existingIdentities.has(messageIdentity(message)),
    ).length;
  }
  return increments;
};

/** The current room is always reset to zero. */
export const applyUnreadIncrements = (
  notifications: Record<string, number>,
  increments: Record<string, number>,
  currentRoom: string,
): Record<string, number> => {
  const updated = { ...notifications };
  for (const [room, increment] of Object.entries(increments)) {
    updated[room] = room === currentRoom ? 0 : (updated[room] || 0) + increment;
  }
  return updated;
};

/** Hidden DMs resurface only when unread strictly exceeds the hide-time baseline. */
export const selectDmRoomsToUnhide = (args: {
  increments: Record<string, number>;
  nextNotifications: Record<string, number>;
  hiddenRooms: Set<string>;
  hiddenDmUnreadBaseline: Record<string, number>;
  username: string;
}): string[] => {
  const {
    increments,
    nextNotifications,
    hiddenRooms,
    hiddenDmUnreadBaseline,
    username,
  } = args;
  return Object.entries(increments)
    .filter(
      ([room, increment]) =>
        increment > 0 &&
        isDmRoom(room) &&
        isUserInDmRoom(room, username) &&
        hiddenRooms.has(room) &&
        (nextNotifications[room] || 0) > (hiddenDmUnreadBaseline[room] ?? 0),
    )
    .map(([room]) => room);
};

/** Returns `prev` unchanged when none of the values were present. */
export const deleteFromSet = <T>(prev: Set<T>, values: T[]): Set<T> => {
  const next = new Set(prev);
  let changed = false;
  for (const value of values) {
    if (next.delete(value)) {
      changed = true;
    }
  }
  return changed ? next : prev;
};

/** Returns `prev` unchanged when none of the keys were present. */
export const deleteKeys = <T>(
  prev: Record<string, T>,
  keys: string[],
): Record<string, T> => {
  if (!keys.some((key) => key in prev)) {
    return prev;
  }
  const next = { ...prev };
  for (const key of keys) {
    delete next[key];
  }
  return next;
};
