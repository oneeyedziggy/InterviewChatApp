import { decryptJsonForCurrentUser } from './gpg';

export type StoredRoomPrefs = {
  leftRooms?: string[];
  currentRoom?: string;
  openRooms?: string[];
};

export type EncryptedStoredRoomPrefs = {
  version: 'enc-v1';
  ciphertext: string;
};

export const roomPrefsStorageKey = (username: string): string => {
  return `home_room_prefs_${username}`;
};

/** Parses (and decrypts, if enc-v1) a stored prefs string; throws on invalid input. */
export const decodeStoredRoomPrefs = async (
  raw: string,
): Promise<StoredRoomPrefs> => {
  const parsed = JSON.parse(raw) as StoredRoomPrefs | EncryptedStoredRoomPrefs;
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as EncryptedStoredRoomPrefs).version === 'enc-v1' &&
    typeof (parsed as EncryptedStoredRoomPrefs).ciphertext === 'string'
  ) {
    return decryptJsonForCurrentUser<StoredRoomPrefs>(
      (parsed as EncryptedStoredRoomPrefs).ciphertext,
    );
  }
  return parsed as StoredRoomPrefs;
};

const stringEntries = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((room): room is string => typeof room === 'string')
    : [];

export const loadRoomPrefs = async (
  username: string,
): Promise<StoredRoomPrefs> => {
  if (!username || typeof window === 'undefined') {
    return {};
  }

  const raw = localStorage.getItem(roomPrefsStorageKey(username));
  if (!raw) {
    return {};
  }

  try {
    const prefs = await decodeStoredRoomPrefs(raw);
    return {
      leftRooms: stringEntries(prefs.leftRooms),
      currentRoom:
        typeof prefs.currentRoom === 'string' ? prefs.currentRoom : undefined,
      openRooms: stringEntries(prefs.openRooms),
    };
  } catch {
    return {};
  }
};
