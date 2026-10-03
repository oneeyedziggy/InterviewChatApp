import { type Socket } from '../websocketClient';
import { SOCKET_EVENTS } from '../../constants';
import {
  decryptMessageForUser,
  encryptForAllUsers,
  loadKeysAsync,
  loadUserPublicKeyEntries,
} from '../gpg';
import { emitSignedMutation } from '../socketAuth';
import {
  getCurrentUserId,
  getRoomDirectorySnapshot,
  getRoomDirectoryTimestampSnapshot,
  getUserDirectorySnapshot,
  getUserDirectoryTimestampSnapshot,
  requireUserIdByUsername,
  storeIdentityDirectories,
} from '../identityMap';
import { asRecord, parsePositiveTimestamp } from './payloadGuards';

type DecryptedDirectory = {
  directory: Record<string, string>;
  updatedAt: Record<string, number>;
};

// Entries this client cannot decrypt are expected and skipped silently.
const decryptCiphertextMap = async (
  ciphertexts: Record<string, unknown>,
  updatedAtRaw: Record<string, unknown>,
  privateKey: string,
): Promise<DecryptedDirectory> => {
  const directory: Record<string, string> = {};
  const updatedAt: Record<string, number> = {};
  for (const [id, ciphertext] of Object.entries(ciphertexts)) {
    if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
      continue;
    }
    try {
      const value = await decryptMessageForUser(ciphertext, privateKey, {
        suppressErrorLog: true,
      });
      if (value && value.trim() !== '') {
        directory[id] = value;
        const timestamp = parsePositiveTimestamp(updatedAtRaw[id]);
        if (timestamp !== undefined) {
          updatedAt[id] = timestamp;
        }
      }
    } catch {
      // Non-decryptable entry.
    }
  }
  return { directory, updatedAt };
};

const DIRECTORY_FIELDS = {
  room: {
    ciphertexts: 'roomNameCiphertexts',
    updatedAt: 'roomDirectoryUpdatedAt',
    store: (result: DecryptedDirectory) =>
      storeIdentityDirectories({
        roomDirectory: result.directory,
        roomDirectoryUpdatedAt: result.updatedAt,
      }),
  },
  user: {
    ciphertexts: 'userDirectoryCiphertexts',
    updatedAt: 'userDirectoryUpdatedAt',
    store: (result: DecryptedDirectory) =>
      storeIdentityDirectories({
        userDirectory: result.directory,
        userDirectoryUpdatedAt: result.updatedAt,
      }),
  },
} as const;

const applyEncryptedDirectory = async (
  payload: unknown,
  kind: keyof typeof DIRECTORY_FIELDS,
): Promise<number> => {
  const record = asRecord(payload);
  if (!record) {
    return 0;
  }

  const fields = DIRECTORY_FIELDS[kind];
  const ciphertexts = record[fields.ciphertexts];
  if (!ciphertexts || typeof ciphertexts !== 'object') {
    return 0;
  }

  const keys = await loadKeysAsync();
  if (!keys?.privateKey) {
    return 0;
  }

  const result = await decryptCiphertextMap(
    ciphertexts as Record<string, unknown>,
    asRecord(record[fields.updatedAt]) ?? {},
    keys.privateKey,
  );
  const count = Object.keys(result.directory).length;
  if (count > 0) {
    fields.store(result);
  }
  return count;
};

export const applyEncryptedRoomDirectory = (payload: unknown) =>
  applyEncryptedDirectory(payload, 'room');

export const applyEncryptedUserDirectory = (payload: unknown) =>
  applyEncryptedDirectory(payload, 'user');

export const validateAndApplyIdentityRefresh = async (
  payload: unknown,
): Promise<{ roomApplied: number; userApplied: number }> => {
  const none = { roomApplied: 0, userApplied: 0 };
  const mapPayload = asRecord(payload);
  if (!mapPayload) {
    return none;
  }

  const senderId =
    typeof mapPayload.refreshedByUserId === 'string'
      ? mapPayload.refreshedByUserId.trim()
      : '';
  if (!senderId) {
    console.warn('[Socket] Identity refresh missing sender id');
    return none;
  }

  const senderEntries = loadUserPublicKeyEntries() || {};
  if (!senderEntries[senderId]?.publicKey) {
    console.warn(
      '[Socket] Ignoring identity refresh from unknown sender:',
      senderId,
    );
    return none;
  }

  const keys = await loadKeysAsync();
  if (!keys?.privateKey) {
    return none;
  }

  const rooms = await decryptCiphertextMap(
    asRecord(mapPayload.roomNameCiphertexts) ?? {},
    asRecord(mapPayload.roomDirectoryUpdatedAt) ?? {},
    keys.privateKey,
  );
  const users = await decryptCiphertextMap(
    asRecord(mapPayload.userDirectoryCiphertexts) ?? {},
    asRecord(mapPayload.userDirectoryUpdatedAt) ?? {},
    keys.privateKey,
  );

  const roomApplied = Object.keys(rooms.directory).length;
  const userApplied = Object.keys(users.directory).length;
  // Require at least one successful decrypt before applying anything.
  if (roomApplied === 0 && userApplied === 0) {
    console.warn(
      '[Socket] Ignoring identity refresh payload with no decryptable entries',
    );
    return none;
  }

  storeIdentityDirectories({
    roomDirectory: rooms.directory,
    userDirectory: users.directory,
    roomDirectoryUpdatedAt: rooms.updatedAt,
    userDirectoryUpdatedAt: users.updatedAt,
  });

  return { roomApplied, userApplied };
};

export const parseUserIdsFromPubKeyPayload = (
  payload: unknown,
): Set<string> => {
  const userIds = new Set<string>();
  const record = asRecord(payload);
  if (!record) {
    return userIds;
  }

  for (const userId of Object.keys(record)) {
    const normalized = userId.trim();
    if (normalized !== '') {
      userIds.add(normalized);
    }
  }

  return userIds;
};

/** Stored public keys overlaid with any keys from an incoming payload (string or `{ publicKey }` entries). */
export const collectEncryptionRecipients = (
  incomingUserPubKeys: unknown,
): Record<string, string> => {
  const entries = loadUserPublicKeyEntries() || {};
  const recipients: Record<string, string> = {};
  for (const [userId, entry] of Object.entries(entries)) {
    const publicKey = entry?.publicKey;
    if (typeof publicKey !== 'string' || publicKey.trim() === '') {
      continue;
    }
    recipients[userId] = publicKey;
  }

  const incoming = asRecord(incomingUserPubKeys);
  if (incoming) {
    for (const [userId, rawEntry] of Object.entries(incoming)) {
      if (!userId) {
        continue;
      }
      let publicKey = '';
      if (typeof rawEntry === 'string') {
        publicKey = rawEntry;
      } else if (
        rawEntry &&
        typeof rawEntry === 'object' &&
        typeof (rawEntry as { publicKey?: unknown }).publicKey === 'string'
      ) {
        publicKey = (rawEntry as { publicKey: string }).publicKey;
      }
      if (publicKey.trim() !== '') {
        recipients[userId] = publicKey;
      }
    }
  }

  return recipients;
};

const encryptValueMap = async (
  entries: Record<string, string>,
  recipients: Record<string, string>,
  publicKey: string,
  label: string,
): Promise<Record<string, string>> => {
  const ciphertexts: Record<string, string> = {};
  for (const [id, value] of Object.entries(entries)) {
    if (!id || !value) {
      continue;
    }
    try {
      ciphertexts[id] = await encryptForAllUsers(value, recipients, publicKey);
    } catch (error) {
      console.warn(
        `[Socket] Failed to refresh ${label} ciphertext for`,
        id,
        error,
      );
    }
  }
  return ciphertexts;
};

const buildIdentityDirectoryRefreshPayload = async (
  newUserIds: string[],
  incomingUserPubKeys: unknown,
): Promise<{
  roomNameCiphertexts: Record<string, string>;
  userDirectoryCiphertexts: Record<string, string>;
  roomDirectoryUpdatedAt: Record<string, number>;
  userDirectoryUpdatedAt: Record<string, number>;
} | null> => {
  if (newUserIds.length === 0) {
    return null;
  }

  const keys = await loadKeysAsync();
  if (!keys?.publicKey) {
    return null;
  }

  const recipients = collectEncryptionRecipients(incomingUserPubKeys);
  if (Object.keys(recipients).length === 0) {
    return null;
  }

  const userDirectory = getUserDirectorySnapshot();
  const currentUserId =
    keys.userId || getCurrentUserId() || requireUserIdByUsername(keys.username);
  if (currentUserId && !userDirectory[currentUserId]) {
    userDirectory[currentUserId] = keys.username;
  }
  const roomDirectoryUpdatedAt = getRoomDirectoryTimestampSnapshot();
  const userDirectoryUpdatedAt = getUserDirectoryTimestampSnapshot();

  const roomNameCiphertexts = await encryptValueMap(
    getRoomDirectorySnapshot(),
    recipients,
    keys.publicKey,
    'room name',
  );
  const userDirectoryCiphertexts = await encryptValueMap(
    userDirectory,
    recipients,
    keys.publicKey,
    'username',
  );

  if (
    Object.keys(roomNameCiphertexts).length === 0 &&
    Object.keys(userDirectoryCiphertexts).length === 0
  ) {
    return null;
  }

  return {
    roomNameCiphertexts,
    userDirectoryCiphertexts,
    roomDirectoryUpdatedAt,
    userDirectoryUpdatedAt,
  };
};

export const maybeSendIdentityDirectoryRefresh = async (args: {
  socket: Socket;
  authToken: string;
  username: string;
  incomingUserPubKeys: unknown;
}): Promise<void> => {
  const { socket, authToken, username, incomingUserPubKeys } = args;
  if (!authToken || !username) {
    return;
  }

  const newUserIds = Array.from(
    parseUserIdsFromPubKeyPayload(incomingUserPubKeys),
  ).filter(
    (userId) =>
      userId !== getCurrentUserId() &&
      userId !== requireUserIdByUsername(username),
  );
  if (newUserIds.length === 0) {
    return;
  }

  const refreshPayload = await buildIdentityDirectoryRefreshPayload(
    newUserIds,
    incomingUserPubKeys,
  );
  if (!refreshPayload) {
    return;
  }

  const userId = requireUserIdByUsername(username);
  try {
    await emitSignedMutation(socket, {
      event: SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
      payload: {
        userId,
        refreshedForUserIds: newUserIds,
        ...refreshPayload,
        submittedAt: Date.now(),
      },
      userId,
      sessionId: authToken,
      claims: {
        userId,
        refreshedForUserIds: JSON.stringify(newUserIds),
      },
    });
  } catch (error) {
    console.warn('[Socket] Identity directory refresh skipped:', error);
  }

  console.log(
    '[Socket] Submitted identity directory refresh for new users:',
    newUserIds,
  );
};
