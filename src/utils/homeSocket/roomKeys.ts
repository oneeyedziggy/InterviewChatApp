import { DEFAULT_ROOM } from '../../constants';
import { type Message } from '../../types/types';
import {
  getRoomDirectorySnapshot,
  getRoomIdByName,
  getRoomNameByRoomId,
  getUsernameByUserId,
} from '../identityMap';

const SYSTEM_DM_PREFIX = '@dmid:system:';

export const isSyntheticSystemDmRoom = (room: string): boolean =>
  room.startsWith(SYSTEM_DM_PREFIX);

// DMs, server-assigned opaque IDs, and named rooms are all addressable; only
// empty keys and synthetic system DMs are not.
export const isAddressableRoomEntry = (room: string): boolean =>
  !!room && !isSyntheticSystemDmRoom(room);

export const resolveFallbackRoom = (rooms: string[]): string => {
  const defaultRoom = rooms.find(
    (room) =>
      room === DEFAULT_ROOM || getRoomNameByRoomId(room) === DEFAULT_ROOM,
  );
  if (defaultRoom) {
    return defaultRoom;
  }

  const firstAddressable = rooms.find((room) => isAddressableRoomEntry(room));
  if (firstAddressable) {
    return firstAddressable;
  }

  const roomDirectory = getRoomDirectorySnapshot();
  for (const [roomId, roomName] of Object.entries(roomDirectory)) {
    if (roomName === DEFAULT_ROOM) {
      return roomId;
    }
  }

  for (const roomId of Object.keys(roomDirectory)) {
    if (isAddressableRoomEntry(roomId)) {
      return roomId;
    }
  }

  return getRoomIdByName(DEFAULT_ROOM) || DEFAULT_ROOM;
};

export const normalizeIncomingRoomKey = (
  room: string,
  candidateRooms: string[],
  roomMessages?: Message[],
): string => {
  const mappedRoomName = getRoomNameByRoomId(room);
  if (mappedRoomName && isAddressableRoomEntry(mappedRoomName)) {
    return mappedRoomName;
  }

  if (candidateRooms.includes(room)) {
    return room;
  }

  if (isAddressableRoomEntry(room)) {
    return room;
  }

  if (Array.isArray(roomMessages)) {
    for (const msg of roomMessages) {
      const hintedRoom =
        msg && typeof msg.roomId === 'string' ? msg.roomId.trim() : '';
      if (!hintedRoom) {
        continue;
      }
      const hintedMappedName = getRoomNameByRoomId(hintedRoom);
      if (hintedMappedName && isAddressableRoomEntry(hintedMappedName)) {
        return hintedMappedName;
      }
      if (isAddressableRoomEntry(hintedRoom)) {
        return hintedRoom;
      }
    }
  }

  console.warn(
    '[Socket] Unmapped room key received; keeping original room key',
    { room },
  );
  return room;
};

export const normalizeRoomListEntries = (rooms: string[]): string[] => {
  const byEffectiveName = new Map<string, string>();

  for (const room of rooms) {
    if (!isAddressableRoomEntry(room)) {
      continue;
    }

    const effectiveName = getRoomNameByRoomId(room) || room;
    const existing = byEffectiveName.get(effectiveName);

    if (!existing) {
      byEffectiveName.set(effectiveName, room);
      continue;
    }

    // Prefer opaque room IDs that resolve to names over plain-name entries.
    if (!getRoomNameByRoomId(existing) && getRoomNameByRoomId(room)) {
      byEffectiveName.set(effectiveName, room);
    }
  }

  return Array.from(byEffectiveName.values());
};

/** Normalized union of the given room lists plus every known room-directory ID. */
export const buildCandidateRooms = (...roomLists: string[][]): string[] =>
  normalizeRoomListEntries([
    ...roomLists.flat(),
    ...Object.keys(getRoomDirectorySnapshot()),
  ]);

/** Appends missing rooms and renormalizes; returns `prev` when nothing changed. */
export const mergeRoomsIntoList = (
  prev: string[],
  rooms: string[],
): string[] => {
  const merged = [...prev];
  let changed = false;
  for (const room of rooms) {
    if (!merged.includes(room)) {
      merged.push(room);
      changed = true;
    }
  }
  const normalized = normalizeRoomListEntries(merged);
  return changed || normalized.length !== prev.length ? normalized : prev;
};

export const resolvePersistedCurrentRoom = (
  normalizedRooms: string[],
  preferredRoom: string,
  currentRoom: string,
): string => {
  const roomSet = new Set(normalizedRooms);
  const normalizedPreferred = preferredRoom.trim();

  if (normalizedPreferred) {
    const mappedPreferred = getRoomNameByRoomId(normalizedPreferred);
    if (roomSet.has(normalizedPreferred)) {
      return mappedPreferred || normalizedPreferred;
    }
    if (mappedPreferred && roomSet.has(mappedPreferred)) {
      return mappedPreferred;
    }

    const preferredId = getRoomIdByName(normalizedPreferred);
    if (preferredId) {
      const mappedPreferredId = getRoomNameByRoomId(preferredId);
      if (mappedPreferredId && roomSet.has(mappedPreferredId)) {
        return mappedPreferredId;
      }
      if (roomSet.has(preferredId)) {
        return mappedPreferredId || preferredId;
      }
    }
  }

  const normalizedCurrent = currentRoom.trim();
  if (normalizedCurrent && roomSet.has(normalizedCurrent)) {
    return getRoomNameByRoomId(normalizedCurrent) || normalizedCurrent;
  }

  return resolveFallbackRoom(normalizedRooms);
};

export const toDisplayUsers = (users: unknown): string[] => {
  if (!Array.isArray(users)) {
    return [];
  }

  return users
    .map((value) => {
      if (typeof value !== 'string') {
        return '';
      }
      return getUsernameByUserId(value) || value;
    })
    .filter((value) => value !== '');
};
