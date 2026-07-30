import io, { type Socket } from 'socket.io-client';
import { socketIoPath } from '@/utils/appPaths';
import { type Message, type Messages } from '../types/types';
import { SOCKET_EVENTS, DEFAULT_ROOM, SYSTEM_MESSAGES } from '../constants';
import {
  decryptJsonForCurrentUser,
  storeUserPublicKeys,
  loadUserPublicKeyEntries,
  decryptMessageForUser,
  loadKeys,
  encryptForAllUsers,
  verifyDetachedTextSignature,
} from '../utils/gpg';
import { emitSignedMutation } from '../utils/socketAuth';
import {
  getCurrentUserId,
  getRoomIdByName,
  getUsernameByUserId,
  getRoomNameByRoomId,
  requireRoomIdByName,
  requireUserIdByUsername,
  storeIdentityDirectories,
  getRoomDirectorySnapshot,
  getRoomDirectoryTimestampSnapshot,
  getUserDirectorySnapshot,
  getUserDirectoryTimestampSnapshot,
} from '../utils/identityMap';
import { getBlockedUsers } from '../utils/userSettings';
import { filterRoomsForUser, isDmRoom, isUserInDmRoom } from '../utils/dmRooms';
import type { Dispatch, SetStateAction } from 'react';
import type { JoinRequest } from '../contexts/home/homePageTypes';

function createClientMessageId(prefix = 'client'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function ensureMessageId(message: Message): Message {
  if (message.id && message.id.trim() !== '') {
    return message;
  }
  return {
    ...message,
    id: createClientMessageId('legacy'),
  };
}

type StoredRoomPrefs = {
  leftRooms?: string[];
  currentRoom?: string;
  openRooms?: string[];
};

type EncryptedStoredRoomPrefs = {
  version: 'enc-v1';
  ciphertext: string;
};

type ServerSignatureEnvelope = {
  version?: string;
  event?: string;
  timestamp?: number;
  nonce?: string;
  payloadHash?: string;
  signature?: string;
};

const SERVER_SIGNATURE_STRICT_STORAGE_KEY = 'chat_server_signature_strict';

function isServerSignatureStrictMode(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  const raw = localStorage.getItem(SERVER_SIGNATURE_STRICT_STORAGE_KEY);
  if (!raw) {
    return true;
  }

  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function escapeGoJsonString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function goJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return escapeGoJsonString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => goJsonStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries
      .map(
        ([key, nested]) =>
          `${escapeGoJsonString(key)}:${goJsonStringify(nested)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function roomNameHash(roomName: string): Promise<string> {
  const normalized = roomName.trim().toLowerCase();
  return sha256Hex(normalized);
}

function buildServerSigningInput(
  envelope: Required<ServerSignatureEnvelope>,
): string {
  return [
    envelope.version,
    envelope.event,
    String(envelope.timestamp),
    envelope.nonce,
    envelope.payloadHash,
  ].join('|');
}

async function applyEncryptedRoomDirectory(payload: unknown): Promise<number> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 0;
  }

  const roomNameCiphertexts = (payload as Record<string, unknown>)[
    'roomNameCiphertexts'
  ];
  if (!roomNameCiphertexts || typeof roomNameCiphertexts !== 'object') {
    return 0;
  }

  const keys = loadKeys();
  if (!keys?.privateKey) {
    return 0;
  }

  const decryptedRoomDirectory: Record<string, string> = {};
  const decryptedRoomDirectoryUpdatedAt: Record<string, number> = {};
  const updatedAtByRoomId =
    (payload as Record<string, unknown>)['roomDirectoryUpdatedAt'] &&
    typeof (payload as Record<string, unknown>)['roomDirectoryUpdatedAt'] ===
      'object' &&
    !Array.isArray(
      (payload as Record<string, unknown>)['roomDirectoryUpdatedAt'],
    )
      ? ((payload as Record<string, unknown>)[
          'roomDirectoryUpdatedAt'
        ] as Record<string, unknown>)
      : {};
  for (const [roomId, ciphertext] of Object.entries(
    roomNameCiphertexts as Record<string, unknown>,
  )) {
    if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
      continue;
    }
    try {
      const roomName = await decryptMessageForUser(ciphertext, keys.privateKey);
      if (roomName && roomName.trim() !== '') {
        decryptedRoomDirectory[roomId] = roomName;
        const rawUpdatedAt = updatedAtByRoomId[roomId];
        const numericUpdatedAt =
          typeof rawUpdatedAt === 'number'
            ? rawUpdatedAt
            : typeof rawUpdatedAt === 'string'
              ? Number.parseInt(rawUpdatedAt, 10)
              : NaN;
        if (Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0) {
          decryptedRoomDirectoryUpdatedAt[roomId] =
            Math.trunc(numericUpdatedAt);
        }
      }
    } catch (error) {
      console.warn('[Socket] Failed to decrypt room name for', roomId, error);
    }
  }

  if (Object.keys(decryptedRoomDirectory).length > 0) {
    storeIdentityDirectories({
      roomDirectory: decryptedRoomDirectory,
      roomDirectoryUpdatedAt: decryptedRoomDirectoryUpdatedAt,
    });
  }
  return Object.keys(decryptedRoomDirectory).length;
}

async function applyEncryptedUserDirectory(payload: unknown): Promise<number> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 0;
  }

  const userNameCiphertexts = (payload as Record<string, unknown>)[
    'userDirectoryCiphertexts'
  ];
  if (!userNameCiphertexts || typeof userNameCiphertexts !== 'object') {
    return 0;
  }

  const keys = loadKeys();
  if (!keys?.privateKey) {
    return 0;
  }

  const decryptedUserDirectory: Record<string, string> = {};
  const decryptedUserDirectoryUpdatedAt: Record<string, number> = {};
  const updatedAtByUserId =
    (payload as Record<string, unknown>)['userDirectoryUpdatedAt'] &&
    typeof (payload as Record<string, unknown>)['userDirectoryUpdatedAt'] ===
      'object' &&
    !Array.isArray(
      (payload as Record<string, unknown>)['userDirectoryUpdatedAt'],
    )
      ? ((payload as Record<string, unknown>)[
          'userDirectoryUpdatedAt'
        ] as Record<string, unknown>)
      : {};
  for (const [userId, ciphertext] of Object.entries(
    userNameCiphertexts as Record<string, unknown>,
  )) {
    if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
      continue;
    }
    try {
      const username = await decryptMessageForUser(ciphertext, keys.privateKey);
      if (username && username.trim() !== '') {
        decryptedUserDirectory[userId] = username;
        const rawUpdatedAt = updatedAtByUserId[userId];
        const numericUpdatedAt =
          typeof rawUpdatedAt === 'number'
            ? rawUpdatedAt
            : typeof rawUpdatedAt === 'string'
              ? Number.parseInt(rawUpdatedAt, 10)
              : NaN;
        if (Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0) {
          decryptedUserDirectoryUpdatedAt[userId] =
            Math.trunc(numericUpdatedAt);
        }
      }
    } catch (error) {
      console.warn('[Socket] Failed to decrypt username for', userId, error);
    }
  }

  if (Object.keys(decryptedUserDirectory).length > 0) {
    storeIdentityDirectories({
      userDirectory: decryptedUserDirectory,
      userDirectoryUpdatedAt: decryptedUserDirectoryUpdatedAt,
    });
  }
  return Object.keys(decryptedUserDirectory).length;
}

function parseUserIdsFromPubKeyPayload(payload: unknown): Set<string> {
  const userIds = new Set<string>();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return userIds;
  }

  for (const userId of Object.keys(payload as Record<string, unknown>)) {
    const normalized = userId.trim();
    if (normalized !== '') {
      userIds.add(normalized);
    }
  }

  return userIds;
}

function collectEncryptionRecipients(
  incomingUserPubKeys: unknown,
): Record<string, string> {
  const entries = loadUserPublicKeyEntries() || {};
  const recipients: Record<string, string> = {};
  for (const [userId, entry] of Object.entries(entries)) {
    const publicKey = entry?.publicKey;
    if (typeof publicKey !== 'string' || publicKey.trim() === '') {
      continue;
    }
    recipients[userId] = publicKey;
  }

  if (
    incomingUserPubKeys &&
    typeof incomingUserPubKeys === 'object' &&
    !Array.isArray(incomingUserPubKeys)
  ) {
    for (const [userId, rawEntry] of Object.entries(
      incomingUserPubKeys as Record<string, unknown>,
    )) {
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
}

async function buildIdentityDirectoryRefreshPayload(
  newUserIds: string[],
  incomingUserPubKeys: unknown,
): Promise<{
  roomNameCiphertexts: Record<string, string>;
  userDirectoryCiphertexts: Record<string, string>;
  roomDirectoryUpdatedAt: Record<string, number>;
  userDirectoryUpdatedAt: Record<string, number>;
} | null> {
  if (newUserIds.length === 0) {
    return null;
  }

  const keys = loadKeys();
  if (!keys?.publicKey) {
    return null;
  }

  const recipients = collectEncryptionRecipients(incomingUserPubKeys);
  const recipientCountBefore = Object.keys(recipients).length;
  if (recipientCountBefore === 0) {
    return null;
  }

  const roomDirectory = getRoomDirectorySnapshot();
  const userDirectory = getUserDirectorySnapshot();
  const roomDirectoryUpdatedAt = getRoomDirectoryTimestampSnapshot();
  const userDirectoryUpdatedAt = getUserDirectoryTimestampSnapshot();

  const roomNameCiphertexts: Record<string, string> = {};
  const userDirectoryCiphertexts: Record<string, string> = {};

  for (const [roomId, roomName] of Object.entries(roomDirectory)) {
    if (!roomId || !roomName) {
      continue;
    }
    try {
      roomNameCiphertexts[roomId] = await encryptForAllUsers(
        roomName,
        recipients,
        keys.publicKey,
        keys.username,
      );
    } catch (error) {
      console.warn(
        '[Socket] Failed to refresh room name ciphertext for',
        roomId,
        error,
      );
    }
  }

  for (const [userId, username] of Object.entries(userDirectory)) {
    if (!userId || !username) {
      continue;
    }
    try {
      userDirectoryCiphertexts[userId] = await encryptForAllUsers(
        username,
        recipients,
        keys.publicKey,
        keys.username,
      );
    } catch (error) {
      console.warn(
        '[Socket] Failed to refresh username ciphertext for',
        userId,
        error,
      );
    }
  }

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
}

async function maybeSendIdentityDirectoryRefresh(args: {
  socket: Socket;
  authToken: string;
  username: string;
  incomingUserPubKeys: unknown;
}): Promise<void> {
  const { socket, authToken, username, incomingUserPubKeys } = args;
  if (!authToken || !username) {
    return;
  }

  const knownBefore = parseUserIdsFromPubKeyPayload(loadUserPublicKeyEntries());
  const knownAfter = parseUserIdsFromPubKeyPayload(incomingUserPubKeys);
  const newUserIds = Array.from(knownAfter).filter(
    (userId) => !knownBefore.has(userId),
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
  await emitSignedMutation(socket, {
    event: SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
    payload: {
      userId,
      refreshedForUserIds: newUserIds,
      roomNameCiphertexts: refreshPayload.roomNameCiphertexts,
      userDirectoryCiphertexts: refreshPayload.userDirectoryCiphertexts,
      roomDirectoryUpdatedAt: refreshPayload.roomDirectoryUpdatedAt,
      userDirectoryUpdatedAt: refreshPayload.userDirectoryUpdatedAt,
      submittedAt: Date.now(),
    },
    userId,
    sessionId: authToken,
    claims: {
      userId,
      refreshedForUserIds: JSON.stringify(newUserIds),
    },
  });

  console.log(
    '[Socket] Submitted identity directory refresh for new users:',
    newUserIds,
  );
}

async function ensureDefaultRoomExists(args: {
  socket: Socket;
  authToken: string;
  username: string;
  roomIdsFromServer: unknown;
  incomingUserPubKeys?: unknown;
  retryAttempt?: number;
}): Promise<void> {
  const {
    socket,
    authToken,
    username,
    roomIdsFromServer,
    incomingUserPubKeys,
    retryAttempt = 0,
  } = args;
  if (!authToken || !username) {
    return;
  }

  const roomIds = Array.isArray(roomIdsFromServer)
    ? roomIdsFromServer.filter(
        (room): room is string =>
          typeof room === 'string' && room.trim() !== '',
      )
    : [];
  const hasGeneral = roomIds.some(
    (roomId) =>
      roomId === DEFAULT_ROOM || getRoomNameByRoomId(roomId) === DEFAULT_ROOM,
  );
  console.log('[Socket] Default room bootstrap check:', {
    roomIds,
    hasGeneral,
  });
  if (hasGeneral) {
    return;
  }

  const keys = loadKeys();
  if (!keys?.publicKey) {
    return;
  }

  const recipients = collectEncryptionRecipients(incomingUserPubKeys);
  let roomNameCiphertext = '';
  try {
    roomNameCiphertext = await encryptForAllUsers(
      DEFAULT_ROOM,
      recipients,
      keys.publicKey,
      username,
    );
  } catch (error) {
    console.warn('[Socket] Failed to bootstrap default room ciphertext', error);
    return;
  }

  const hashedRoomName = await roomNameHash(DEFAULT_ROOM);
  const userId = getCurrentUserId() || requireUserIdByUsername(username);
  const roomDirectoryUpdatedAt = Date.now();

  try {
    await emitSignedMutation(socket, {
      event: SOCKET_EVENTS.CLIENT_NEW_ROOM,
      payload: {
        roomNameCiphertext,
        roomNameHash: hashedRoomName,
        roomDirectoryUpdatedAt,
        userId,
        sessionId: authToken,
      },
      userId,
      sessionId: authToken,
      claims: {
        roomNameCiphertext,
        roomNameHash: hashedRoomName,
        roomDirectoryUpdatedAt: String(roomDirectoryUpdatedAt),
      },
    });
  } catch (error) {
    if (retryAttempt < 1) {
      window.setTimeout(() => {
        void ensureDefaultRoomExists({
          socket,
          authToken,
          username,
          roomIdsFromServer,
          incomingUserPubKeys,
          retryAttempt: retryAttempt + 1,
        });
      }, 600);
    }
    console.warn('[Socket] Default room bootstrap attempt failed', error);
    return;
  }

  console.log('[Socket] Bootstrapped missing default room:', DEFAULT_ROOM);
}

async function validateAndApplyIdentityRefresh(payload: unknown): Promise<{
  roomApplied: number;
  userApplied: number;
}> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { roomApplied: 0, userApplied: 0 };
  }

  const mapPayload = payload as Record<string, unknown>;
  const senderId =
    typeof mapPayload.refreshedByUserId === 'string'
      ? mapPayload.refreshedByUserId.trim()
      : '';
  if (!senderId) {
    console.warn('[Socket] Identity refresh missing sender id');
    return { roomApplied: 0, userApplied: 0 };
  }

  const senderEntries = loadUserPublicKeyEntries() || {};
  if (!senderEntries[senderId]?.publicKey) {
    console.warn(
      '[Socket] Ignoring identity refresh from unknown sender:',
      senderId,
    );
    return { roomApplied: 0, userApplied: 0 };
  }

  const keys = loadKeys();
  if (!keys?.privateKey) {
    return { roomApplied: 0, userApplied: 0 };
  }

  const roomNameCiphertexts =
    mapPayload.roomNameCiphertexts &&
    typeof mapPayload.roomNameCiphertexts === 'object' &&
    !Array.isArray(mapPayload.roomNameCiphertexts)
      ? (mapPayload.roomNameCiphertexts as Record<string, unknown>)
      : {};
  const userDirectoryCiphertexts =
    mapPayload.userDirectoryCiphertexts &&
    typeof mapPayload.userDirectoryCiphertexts === 'object' &&
    !Array.isArray(mapPayload.userDirectoryCiphertexts)
      ? (mapPayload.userDirectoryCiphertexts as Record<string, unknown>)
      : {};

  const roomDirectoryUpdatedAtRaw =
    mapPayload.roomDirectoryUpdatedAt &&
    typeof mapPayload.roomDirectoryUpdatedAt === 'object' &&
    !Array.isArray(mapPayload.roomDirectoryUpdatedAt)
      ? (mapPayload.roomDirectoryUpdatedAt as Record<string, unknown>)
      : {};
  const userDirectoryUpdatedAtRaw =
    mapPayload.userDirectoryUpdatedAt &&
    typeof mapPayload.userDirectoryUpdatedAt === 'object' &&
    !Array.isArray(mapPayload.userDirectoryUpdatedAt)
      ? (mapPayload.userDirectoryUpdatedAt as Record<string, unknown>)
      : {};

  const decryptedRoomDirectory: Record<string, string> = {};
  const decryptedUserDirectory: Record<string, string> = {};
  const decryptedRoomDirectoryUpdatedAt: Record<string, number> = {};
  const decryptedUserDirectoryUpdatedAt: Record<string, number> = {};

  for (const [roomId, ciphertext] of Object.entries(roomNameCiphertexts)) {
    if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
      continue;
    }
    try {
      const roomName = await decryptMessageForUser(ciphertext, keys.privateKey);
      if (roomName && roomName.trim() !== '') {
        decryptedRoomDirectory[roomId] = roomName;
        const rawUpdatedAt = roomDirectoryUpdatedAtRaw[roomId];
        const numericUpdatedAt =
          typeof rawUpdatedAt === 'number'
            ? rawUpdatedAt
            : typeof rawUpdatedAt === 'string'
              ? Number.parseInt(rawUpdatedAt, 10)
              : NaN;
        if (Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0) {
          decryptedRoomDirectoryUpdatedAt[roomId] =
            Math.trunc(numericUpdatedAt);
        }
      }
    } catch {
      // Skip non-decryptable entries to avoid poisoning local mappings.
    }
  }

  for (const [userId, ciphertext] of Object.entries(userDirectoryCiphertexts)) {
    if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
      continue;
    }
    try {
      const username = await decryptMessageForUser(ciphertext, keys.privateKey);
      if (username && username.trim() !== '') {
        decryptedUserDirectory[userId] = username;
        const rawUpdatedAt = userDirectoryUpdatedAtRaw[userId];
        const numericUpdatedAt =
          typeof rawUpdatedAt === 'number'
            ? rawUpdatedAt
            : typeof rawUpdatedAt === 'string'
              ? Number.parseInt(rawUpdatedAt, 10)
              : NaN;
        if (Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0) {
          decryptedUserDirectoryUpdatedAt[userId] =
            Math.trunc(numericUpdatedAt);
        }
      }
    } catch {
      // Skip non-decryptable entries to avoid poisoning local mappings.
    }
  }

  // Require at least one successful decrypt across the refresh payload before applying.
  if (
    Object.keys(decryptedRoomDirectory).length === 0 &&
    Object.keys(decryptedUserDirectory).length === 0
  ) {
    console.warn(
      '[Socket] Ignoring identity refresh payload with no decryptable entries',
    );
    return { roomApplied: 0, userApplied: 0 };
  }

  storeIdentityDirectories({
    roomDirectory: decryptedRoomDirectory,
    userDirectory: decryptedUserDirectory,
    roomDirectoryUpdatedAt: decryptedRoomDirectoryUpdatedAt,
    userDirectoryUpdatedAt: decryptedUserDirectoryUpdatedAt,
  });

  return {
    roomApplied: Object.keys(decryptedRoomDirectory).length,
    userApplied: Object.keys(decryptedUserDirectory).length,
  };
}

function maybeInjectIdentitySyncNoticeDM(args: {
  username: string;
  activeUsers: unknown;
  decryptedRoomCount: number;
  providedRoomCipherCount: number;
  setChatValues: Dispatch<SetStateAction<Messages>>;
  setRoomList: Dispatch<SetStateAction<string[]>>;
}): void {
  const {
    username,
    activeUsers,
    decryptedRoomCount,
    providedRoomCipherCount,
    setChatValues,
    setRoomList,
  } = args;

  const myUserId = requireUserIdByUsername(username);
  const activeUserIds = Array.isArray(activeUsers)
    ? activeUsers.filter((user): user is string => typeof user === 'string')
    : [];
  const otherUsersOnline = activeUserIds.some((userId) => userId !== myUserId);
  const missingAnyRoomNames =
    providedRoomCipherCount > 0 && decryptedRoomCount < providedRoomCipherCount;

  if (otherUsersOnline || !missingAnyRoomNames) {
    return;
  }

  const dmRoom = `@dmid:system:${myUserId}`;
  const noticeMessageID = `identity-sync-notice:${myUserId}`;
  const noticeMessage: Message = {
    id: noticeMessageID,
    timestamp: Date.now(),
    username: 'system',
    userId: 'system',
    roomId: dmRoom,
    content:
      'Privacy notice: because room and user names are end-to-end encrypted and server-blind, you may need to wait for an existing user to come online before some room names or message contents become readable.',
    edited: false,
    visibleTo: [myUserId],
  };

  setChatValues((prev) => {
    const roomMessages = prev[dmRoom] || [];
    const alreadyPresent = roomMessages.some(
      (message) => message.id === noticeMessageID,
    );
    if (alreadyPresent) {
      return prev;
    }
    return {
      ...prev,
      [dmRoom]: [noticeMessage, ...roomMessages],
    };
  });

  setRoomList((prev) => {
    if (prev.includes(dmRoom)) {
      return prev;
    }
    return [...prev, dmRoom];
  });
}

function toDisplayUsers(users: unknown): string[] {
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
}

function isSyntheticSystemDmRoom(room: string): boolean {
  return room.startsWith('@dmid:system:');
}

const OPAQUE_ROOM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOpaqueRoomKey(room: string): boolean {
  return OPAQUE_ROOM_ID_PATTERN.test(room);
}

function isAddressableRoomEntry(room: string): boolean {
  if (!room || isSyntheticSystemDmRoom(room)) {
    return false;
  }
  if (isDmRoom(room)) {
    return true;
  }
  if (isOpaqueRoomKey(room)) {
    // Opaque room IDs from the server are authoritative and must not be
    // remapped to fallback rooms on the client.
    return true;
  }
  if (getRoomNameByRoomId(room)) {
    return true;
  }
  return true;
}

function resolveFallbackRoom(rooms: string[]): string {
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
}

function normalizeIncomingRoomKey(
  room: string,
  candidateRooms: string[],
  roomMessages?: Message[],
): string {
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
      if (hintedRoom && isAddressableRoomEntry(hintedRoom)) {
        const hintedMappedName = getRoomNameByRoomId(hintedRoom);
        if (hintedMappedName && isAddressableRoomEntry(hintedMappedName)) {
          return hintedMappedName;
        }
        return hintedRoom;
      }
      if (hintedRoom) {
        const mappedName = getRoomNameByRoomId(hintedRoom);
        if (mappedName && isAddressableRoomEntry(mappedName)) {
          return mappedName;
        }
      }
    }
  }

  console.warn(
    '[Socket] Unmapped room key received; keeping original room key',
    {
      room,
    },
  );
  return room;
}

function normalizeRoomListEntries(rooms: string[]): string[] {
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

    const existingMappedName = getRoomNameByRoomId(existing);
    const nextMappedName = getRoomNameByRoomId(room);
    // Prefer opaque room IDs that resolve to names over plain-name entries.
    if (!existingMappedName && nextMappedName) {
      byEffectiveName.set(effectiveName, room);
    }
  }

  return Array.from(byEffectiveName.values());
}

function resolvePersistedCurrentRoom(
  normalizedRooms: string[],
  preferredRoom: string,
  currentRoom: string,
): string {
  const roomSet = new Set(normalizedRooms);
  const normalizedPreferred = preferredRoom.trim();

  if (normalizedPreferred) {
    const mappedPreferred = getRoomNameByRoomId(normalizedPreferred);
    if (mappedPreferred && roomSet.has(mappedPreferred)) {
      return mappedPreferred;
    }
    if (roomSet.has(normalizedPreferred)) {
      return normalizedPreferred;
    }

    const preferredId = getRoomIdByName(normalizedPreferred);
    if (preferredId) {
      const mappedPreferredId = getRoomNameByRoomId(preferredId);
      if (mappedPreferredId && roomSet.has(mappedPreferredId)) {
        return mappedPreferredId;
      }
      if (roomSet.has(preferredId)) {
        return preferredId;
      }
    }
  }

  const normalizedCurrent = currentRoom.trim();
  if (normalizedCurrent && roomSet.has(normalizedCurrent)) {
    return normalizedCurrent;
  }

  return resolveFallbackRoom(normalizedRooms);
}

function refreshDisplayedUserLists(args: {
  setUserList: Dispatch<SetStateAction<string[]>>;
  setLoggedInUsers: Dispatch<SetStateAction<string[]>>;
  setActiveUsers: Dispatch<SetStateAction<string[]>>;
}): void {
  const { setUserList, setLoggedInUsers, setActiveUsers } = args;
  setUserList((prev) => prev.map((user) => getUsernameByUserId(user) || user));
  setLoggedInUsers((prev) =>
    prev.map((user) => getUsernameByUserId(user) || user),
  );
  setActiveUsers((prev) =>
    prev.map((user) => getUsernameByUserId(user) || user),
  );
}

async function verifyServerEventEnvelope(
  eventName: string,
  payload: unknown,
): Promise<boolean> {
  const strict = isServerSignatureStrictMode();

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn('[Socket] Invalid signed payload shape for event:', eventName);
    return !strict;
  }

  const payloadMap = payload as Record<string, unknown>;
  const envelope = payloadMap.serverAuth as ServerSignatureEnvelope | undefined;
  if (!envelope || typeof envelope !== 'object') {
    console.warn('[Socket] Missing serverAuth envelope for event:', eventName);
    return !strict;
  }

  const normalizedEnvelope: Required<ServerSignatureEnvelope> = {
    version:
      typeof envelope.version === 'string' && envelope.version.trim() !== ''
        ? envelope.version
        : 'v1',
    event: typeof envelope.event === 'string' ? envelope.event : '',
    timestamp: typeof envelope.timestamp === 'number' ? envelope.timestamp : 0,
    nonce: typeof envelope.nonce === 'string' ? envelope.nonce : '',
    payloadHash:
      typeof envelope.payloadHash === 'string' ? envelope.payloadHash : '',
    signature: typeof envelope.signature === 'string' ? envelope.signature : '',
  };

  if (
    normalizedEnvelope.event !== eventName ||
    normalizedEnvelope.timestamp <= 0 ||
    normalizedEnvelope.nonce === '' ||
    normalizedEnvelope.payloadHash === '' ||
    normalizedEnvelope.signature === ''
  ) {
    console.warn(
      '[Socket] Invalid serverAuth envelope fields for event:',
      eventName,
    );
    return !strict;
  }

  const keys = loadKeys();
  if (!keys?.serverPublicKey) {
    console.warn(
      '[Socket] Missing server public key for signature verification',
    );
    return !strict;
  }

  const signedPayload = { ...payloadMap };
  delete signedPayload.serverAuth;
  const goHash = await sha256Hex(goJsonStringify(signedPayload));
  if (goHash !== normalizedEnvelope.payloadHash) {
    console.warn('[Socket] Payload hash mismatch for event:', eventName);
    return !strict;
  }

  const verified = await verifyDetachedTextSignature(
    buildServerSigningInput(normalizedEnvelope),
    normalizedEnvelope.signature,
    keys.serverPublicKey,
  ).catch((error) => {
    console.error(
      '[Socket] Signature verification error for event',
      eventName,
      error,
    );
    return false;
  });

  if (!verified) {
    console.warn('[Socket] Invalid server signature for event:', eventName);
    return !strict;
  }

  return true;
}

function roomPrefsStorageKey(username: string): string {
  return `home_room_prefs_${username}`;
}

async function loadRoomPrefs(username: string): Promise<StoredRoomPrefs> {
  if (!username || typeof window === 'undefined') {
    return {};
  }

  const raw = localStorage.getItem(roomPrefsStorageKey(username));
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as
      | StoredRoomPrefs
      | EncryptedStoredRoomPrefs;
    let prefs = parsed as StoredRoomPrefs;

    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as EncryptedStoredRoomPrefs).version === 'enc-v1' &&
      typeof (parsed as EncryptedStoredRoomPrefs).ciphertext === 'string'
    ) {
      prefs = await decryptJsonForCurrentUser<StoredRoomPrefs>(
        (parsed as EncryptedStoredRoomPrefs).ciphertext,
      );
    }

    return {
      leftRooms: Array.isArray(prefs.leftRooms)
        ? prefs.leftRooms.filter((room) => typeof room === 'string')
        : [],
      currentRoom:
        typeof prefs.currentRoom === 'string' ? prefs.currentRoom : undefined,
      openRooms: Array.isArray(prefs.openRooms)
        ? prefs.openRooms.filter((room) => typeof room === 'string')
        : [],
    };
  } catch {
    return {};
  }
}

function normalizeMessageState(message: Message): Message {
  if (message.deleted || message.content === 'Message deleted') {
    return {
      ...message,
      content: 'Message deleted',
      deleted: true,
      encryptedFor: undefined,
      versions: undefined,
      currentVersion: undefined,
      visibleTo: undefined,
      voteTotal: undefined,
      userVotes: undefined,
      edited: false,
    };
  }

  return message;
}

function isBlockedAuthor(message: Message, blockedUsers: Set<string>): boolean {
  if (message.userId === 'system') {
    return false;
  }
  const authorName = getUsernameByUserId(message.userId);
  return !!authorName && blockedUsers.has(authorName);
}

function isEncryptedMessageWithoutReadableContent(message: Message): boolean {
  const hasEncryptedPayload =
    !!message.encryptedMessage ||
    !!message.encryptedFor ||
    (message.versions?.length || 0) > 0;
  if (!hasEncryptedPayload) {
    return false;
  }

  const content = (message.content || '').trim();
  if (!content) {
    return true;
  }

  return content.includes('🔒') || content.includes('[Encrypted message]');
}

function scrubMessagesForLocalState(
  messages: Message[],
  blockedUsers: Set<string>,
): Message[] {
  return messages.filter((message) => {
    if (isBlockedAuthor(message, blockedUsers)) {
      return false;
    }

    // If encrypted content is still unreadable after client processing,
    // drop it entirely so blocked/inaccessible messages do not appear as placeholders.
    if (isEncryptedMessageWithoutReadableContent(message)) {
      return false;
    }

    return true;
  });
}

function messageIdentity(message: Pick<Message, 'id' | 'timestamp'>): string {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  const msg = message as Message;
  const userId = msg.userId || 'unknown';
  const replyTo = msg.replyTo ?? 'none';
  const content = (msg.content || '').slice(0, 48);
  return `ts:${message.timestamp}:u:${userId}:r:${replyTo}:c:${content}`;
}

function resolveEncryptedPayloadForUser(
  msg: Message,
  userId: string | undefined,
): string | null {
  if (!userId) {
    return null;
  }

  if (msg.encryptedMessage) {
    return msg.encryptedMessage;
  }

  if (msg.versions && msg.versions.length > 0) {
    const newestVersion = msg.versions[0];
    if (newestVersion.encryptedMessage) {
      return newestVersion.encryptedMessage;
    }
    if (newestVersion.encryptedFor && newestVersion.encryptedFor[userId]) {
      return newestVersion.encryptedFor[userId];
    }
  }

  if (msg.encryptedFor && msg.encryptedFor[userId]) {
    return msg.encryptedFor[userId];
  }

  return null;
}

type InitSocketArgs = {
  authToken: string;
  username: string;
  setAuthToken: Dispatch<SetStateAction<string>>;
  setChatValues: Dispatch<SetStateAction<Messages>>;
  setUserList: Dispatch<SetStateAction<string[]>>;
  setLoggedInUsers: Dispatch<SetStateAction<string[]>>;
  setActiveUsers: Dispatch<SetStateAction<string[]>>;
  setRoomList: Dispatch<SetStateAction<string[]>>;
  setLeftRooms: Dispatch<SetStateAction<Set<string>>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  setRoomNotifications: Dispatch<SetStateAction<Record<string, number>>>;
  setUserLastSeen: Dispatch<SetStateAction<Record<string, number>>>;
  setRoomMembers: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  setActiveJoinRequests: Dispatch<SetStateAction<JoinRequest[]>>;
  getSocket: () => Socket | undefined;
  getLeftRooms: () => Set<string>;
  getChatValues: () => Messages;
  getRoomNotifications: () => Record<string, number>;
  getHiddenDmUnreadBaseline: () => Record<string, number>;
  getCurrentRoom: () => string;
  getRoomList: () => string[];
  setHiddenDmUnreadBaseline: Dispatch<SetStateAction<Record<string, number>>>;
  setSocket: (next: Socket | undefined) => void;
};

export async function initializeHomeSocket({
  authToken,
  username,
  setAuthToken,
  setChatValues,
  setUserList,
  setLoggedInUsers,
  setActiveUsers,
  setRoomList,
  setLeftRooms,
  setCurrentRoom,
  setRoomNotifications,
  setUserLastSeen,
  setRoomMembers,
  setActiveJoinRequests,
  getSocket,
  getLeftRooms,
  getChatValues,
  getRoomNotifications,
  getHiddenDmUnreadBaseline,
  getCurrentRoom,
  getRoomList,
  setHiddenDmUnreadBaseline,
  setSocket,
}: InitSocketArgs) {
  const forcedRoomPayloads = new Set<string>();
  let preferredRoomFromPrefs = '';
  let socket = getSocket();
  console.log('[Socket] ===== INITIALIZING SOCKET =====');
  console.log('[Socket] Token:', authToken);
  console.log('[Socket] Username:', username);
  console.log('[Socket] Current window location:', window.location.href);

  // Disconnect existing socket if any
  if (socket && socket.connected) {
    console.log(
      '[Socket] Disconnecting existing socket before creating new one',
    );
    socket.disconnect();
    socket = undefined as any;
    setSocket(undefined);
  }
  if ((window as any).__socket && (window as any).__socket.connected) {
    console.log(
      '[Socket] Disconnecting existing window socket before creating new one',
    );
    (window as any).__socket.disconnect();
    (window as any).__socket = undefined;
  }

  // Connect to Socket.IO server - use current origin (should be localhost:3000)
  const socketUrl = window.location.origin;
  console.log('[Socket] Connecting to:', socketUrl);

  socket = io(socketUrl, {
    path: socketIoPath(),
    auth: {
      username,
    },
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    forceNew: true, // Force a new connection
  });

  const activeSocket = socket;

  setSocket(activeSocket);

  // Store socket reference globally for doSend and access grant
  (window as any).__socket = activeSocket;

  console.log('[Socket] Socket instance created:', activeSocket);
  console.log('[Socket] Socket ID:', activeSocket.id);
  console.log('[Socket] Socket connected:', activeSocket.connected);
  console.log('[Socket] Setting up listeners...');

  socket.on('disconnect', (reason) => {
    console.log('[Socket] ✗ Socket disconnected, reason:', reason);
  });

  socket.on('connect_error', (error) => {
    console.error('[Socket] ✗ Connection error:', error);
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log(
      '[Socket] ✓ Socket reconnected after',
      attemptNumber,
      'attempts',
    );
    // Update window reference
    (window as any).__socket = activeSocket;
  });

  socket.on(SOCKET_EVENTS.SERVER_ACTION_RESULT, (result) => {
    const action = result?.action || 'action';
    const success = !!result?.success;
    const code = result?.code || 'unknown';
    const message = result?.message || 'Request failed';

    if (success) {
      console.log(`[ActionResult] ${action} success: ${message}`);
      return;
    }

    let userMessage = `${action} failed: ${message}`;
    if (code === 'session_expired') {
      userMessage = 'Session expired. Please log in again.';
    } else if (code === 'unauthorized') {
      userMessage = 'Unauthorized action.';
    } else if (code === 'not_owner') {
      userMessage = 'You can only edit or delete your own messages.';
    } else if (code === 'room_exists') {
      userMessage =
        'A room with that name already exists. Please choose a different room name.';
    }

    alert(userMessage);
    console.warn('[ActionResult] rejected:', { action, code, message });
  });

  socket.on(SOCKET_EVENTS.INITIAL_DATA, async (data) => {
    if (!(await verifyServerEventEnvelope(SOCKET_EVENTS.INITIAL_DATA, data))) {
      console.error(
        '[Socket] Rejected unsigned or invalid INITIAL_DATA payload',
      );
      return;
    }

    console.log(
      '[Socket] INITIAL_DATA signed payload keys:',
      data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data as Record<string, unknown>).sort()
        : 'invalid payload shape',
    );

    const decryptedRoomCount = await applyEncryptedRoomDirectory(data);
    const decryptedUserCount = await applyEncryptedUserDirectory(data);
    console.log('[Socket] Decrypted identity directories from INITIAL_DATA:', {
      roomNames: decryptedRoomCount,
      userNames: decryptedUserCount,
    });

    if (data?.userPubKeys) {
      await maybeSendIdentityDirectoryRefresh({
        socket: activeSocket,
        authToken,
        username,
        incomingUserPubKeys: data.userPubKeys,
      });
    }

    if (data?.currentUserId) {
      storeIdentityDirectories({
        currentUserId: data.currentUserId,
      });
    }

    console.log('[Socket] ===== INITIAL_DATA RECEIVED =====');
    console.log('[Socket] Messages:', data?.messages);
    console.log('[Socket] Messages type:', typeof data?.messages);
    console.log(
      '[Socket] Messages keys:',
      data?.messages ? Object.keys(data.messages) : 'none',
    );
    console.log('[Socket] Rooms:', data?.rooms);
    console.log('[Socket] Rooms type:', typeof data?.rooms);
    console.log(
      '[Socket] Rooms length:',
      Array.isArray(data?.rooms) ? data.rooms.length : 'not array',
    );
    console.log('[Socket] Users:', data?.users);
    console.log('[Socket] Users type:', typeof data?.users);
    console.log(
      '[Socket] Users length:',
      Array.isArray(data?.users) ? data.users.length : 'not array',
    );

    if (data?.userPubKeys) {
      console.log(
        '[Socket] ✓ Storing user public keys:',
        Object.keys(data.userPubKeys).length,
        'keys',
      );
      storeUserPublicKeys(
        data.userPubKeys,
        (data.userPubKeysUpdatedAt as Record<string, number>) || undefined,
      );
    } else {
      console.warn('[Socket] ✗ No userPubKeys in INITIAL_DATA');
    }

    if (data?.messages) {
      const keys = loadKeys();
      const currentUserId = username ? requireUserIdByUsername(username) : '';
      const decryptedMessages: Messages = {};
      const blockedUsers = new Set(getBlockedUsers());
      const scopedRoomsForFallback = Array.isArray(data.rooms)
        ? normalizeRoomListEntries(filterRoomsForUser(data.rooms, username))
        : normalizeRoomListEntries(getRoomList());

      for (const [room, messages] of Object.entries(data.messages)) {
        const normalizedRoom = normalizeIncomingRoomKey(
          room,
          scopedRoomsForFallback,
        );
        const roomMessages = messages as Message[];
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );
        const decryptedForRoom = await Promise.all(
          visibleRoomMessages.map(async (rawMsg: Message) => {
            const msg = ensureMessageId(rawMsg);
            const encrypted = resolveEncryptedPayloadForUser(
              msg,
              currentUserId,
            );
            if (encrypted && keys) {
              try {
                const decrypted = await decryptMessageForUser(
                  encrypted,
                  keys.privateKey,
                );
                return ensureMessageId(
                  normalizeMessageState({ ...msg, content: decrypted }),
                );
              } catch (error) {
                console.error('[Socket] ✗ Failed to decrypt message:', error);
                return ensureMessageId(normalizeMessageState(msg));
              }
            }
            return ensureMessageId(normalizeMessageState(msg));
          }),
        );

        decryptedMessages[normalizedRoom] = scrubMessagesForLocalState(
          [...(decryptedMessages[normalizedRoom] || []), ...decryptedForRoom],
          blockedUsers,
        );
      }

      console.log(
        '[Socket] ✓ Setting chat values, count:',
        Object.keys(decryptedMessages).length,
      );
      setChatValues(decryptedMessages);
    } else {
      console.warn('[Socket] ✗ No messages in INITIAL_DATA');
    }

    if (data?.rooms) {
      const scopedRooms = filterRoomsForUser(data.rooms, username).map((room) =>
        normalizeIncomingRoomKey(room, data.rooms as string[]),
      );
      const normalizedRooms = normalizeRoomListEntries(scopedRooms);
      console.log('[Socket] ✓ Setting room list:', normalizedRooms);
      setRoomList(normalizedRooms);
      const resolvedCurrentRoom = resolvePersistedCurrentRoom(
        normalizedRooms,
        preferredRoomFromPrefs,
        getCurrentRoom(),
      );
      if (resolvedCurrentRoom !== getCurrentRoom()) {
        setCurrentRoom(resolvedCurrentRoom);
      }
    } else {
      console.warn('[Socket] ✗ No rooms in INITIAL_DATA');
    }

    refreshDisplayedUserLists({
      setUserList,
      setLoggedInUsers,
      setActiveUsers,
    });

    if (data?.users) {
      const displayUsers = toDisplayUsers(data.users);
      console.log('[Socket] ✓ Setting user list:', displayUsers);
      setUserList(displayUsers);
    } else {
      console.warn('[Socket] ✗ No users in INITIAL_DATA');
    }

    if (data?.loggedInUsers || data?.activeUsers) {
      const loggedInDisplay = toDisplayUsers(data.loggedInUsers || []);
      const activeDisplay = toDisplayUsers(data.activeUsers || []);
      console.log('[Socket] ✓ Setting logged in users:', loggedInDisplay);
      console.log('[Socket] ✓ Setting active users:', activeDisplay);
      setLoggedInUsers(loggedInDisplay);
      setActiveUsers(activeDisplay);
    } else if (data?.users) {
      setLoggedInUsers(toDisplayUsers(data.users || []));
      setActiveUsers([]);
    }

    await ensureDefaultRoomExists({
      socket: activeSocket,
      authToken,
      username,
      roomIdsFromServer: data?.rooms,
      incomingUserPubKeys: data?.userPubKeys,
    });

    console.log('[Socket] ===== INITIAL_DATA PROCESSING COMPLETE =====');
  });

  socket.on(SOCKET_EVENTS.SERVER_MESSAGE, async (data) => {
    if (
      !(await verifyServerEventEnvelope(SOCKET_EVENTS.SERVER_MESSAGE, data))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_MESSAGE payload',
      );
      return;
    }

    await applyEncryptedRoomDirectory(data);
    const serverMessageUserDirectoryApplied =
      await applyEncryptedUserDirectory(data);
    if (serverMessageUserDirectoryApplied > 0) {
      refreshDisplayedUserLists({
        setUserList,
        setLoggedInUsers,
        setActiveUsers,
      });
    }

    console.log('[Socket] SERVER_MESSAGE received');

    if (data?.currentUserId) {
      storeIdentityDirectories({
        currentUserId: data.currentUserId,
      });
    }

    // Update user last seen for users in messages
    if (data?.messages) {
      setUserLastSeen((prev) => {
        const updated = { ...prev };
        Object.values(data.messages).forEach((roomMessages: any) => {
          if (Array.isArray(roomMessages)) {
            roomMessages.forEach((msg: Message) => {
              const userRef =
                (typeof msg.userId === 'string' && msg.userId) ||
                msg.username ||
                '';
              if (userRef) {
                updated[userRef] = Date.now();
              }
            });
          }
        });
        return updated;
      });
    }

    // Check if this is an access grant update - handle it specially
    if (data?.accessGrant) {
      const { originalRoom, messageTimestamp, encryptedMessage } =
        data.accessGrant;

      const encryptedPacket = encryptedMessage || '';

      console.log('[AccessGrant] ===== PROCESSING ACCESS GRANT =====');
      console.log(
        '[AccessGrant] Room:',
        originalRoom,
        'timestamp:',
        messageTimestamp,
      );
      console.log(
        '[AccessGrant] encrypted payload length:',
        encryptedPacket.length,
      );

      // If server sent updated messages, use those (they include the new version)
      if (data?.messages && data.messages[originalRoom]) {
        const keys = loadKeys();
        if (!keys) {
          console.error('[AccessGrant] No keys available for decryption');
          return;
        }
        const currentUserId = requireUserIdByUsername(username);

        const roomMessages = data.messages[originalRoom] as Message[];

        console.log(
          '[AccessGrant] Processing',
          roomMessages.length,
          'messages from server for room:',
          originalRoom,
          'for user:',
          currentUserId,
        );

        // Log details about each message
        roomMessages.forEach((msg, idx) => {
          console.log(
            `[AccessGrant] Message ${idx}: timestamp=${msg.timestamp}, username=${msg.username}, hasEncryptedFor=${!!msg.encryptedFor}, encryptedForKeys=${Object.keys(msg.encryptedFor || {}).join(',')}, hasVersions=${!!msg.versions}, versionsCount=${msg.versions?.length || 0}`,
          );
          if (msg.versions && msg.versions.length > 0) {
            console.log(
              `[AccessGrant] Message ${idx} newest version encryptedForKeys:`,
              Object.keys(msg.versions[0].encryptedFor || {}).join(','),
            );
          }
        });

        // Decrypt messages we have access to
        const decryptedMessages = await Promise.all(
          roomMessages.map(async (msg: Message) => {
            // If message already has decrypted content, keep it (but verify it's not the lock emoji)
            if (
              msg.content &&
              msg.content.trim() !== '' &&
              !msg.content.includes('🔒') &&
              !msg.content.includes('[Encrypted message]')
            ) {
              console.log(
                '[AccessGrant] Message',
                msg.timestamp,
                'already has decrypted content, keeping it',
              );
              return msg;
            }

            // For all messages, try to decrypt if we have access
            const encryptedData = resolveEncryptedPayloadForUser(
              msg,
              requireUserIdByUsername(username),
            );

            if (encryptedData) {
              try {
                console.log(
                  '[AccessGrant] ===== DECRYPTING MESSAGE FOR REQUESTING USER =====',
                );
                console.log('[AccessGrant] Message timestamp:', msg.timestamp);
                console.log('[AccessGrant] User:', currentUserId);
                console.log(
                  '[AccessGrant] Encrypted data length:',
                  encryptedData.length,
                );
                console.log(
                  '[AccessGrant] Encrypted data (first 200 chars):',
                  encryptedData.substring(0, 200),
                );
                const decrypted = await decryptMessageForUser(
                  encryptedData,
                  keys.privateKey,
                );
                console.log(
                  '[AccessGrant] ✓ Decrypted message for',
                  currentUserId,
                  'timestamp:',
                  msg.timestamp,
                  'content length:',
                  decrypted.length,
                );
                console.log(
                  '[AccessGrant] Decrypted content (first 200 chars):',
                  decrypted.substring(0, 200),
                );
                console.log(
                  '[AccessGrant] Decrypted content (full):',
                  decrypted,
                );
                return {
                  ...msg,
                  content: decrypted,
                };
              } catch (error) {
                console.error(
                  '[AccessGrant] ✗ Failed to decrypt message:',
                  error,
                );
                return msg;
              }
            }

            // If this is the target message, log why we couldn't decrypt
            if (msg.timestamp === messageTimestamp) {
              console.log(
                '[AccessGrant] ⚠ Target message (timestamp:',
                messageTimestamp,
                ') could not be decrypted',
              );
              console.log('[AccessGrant] Current user:', currentUserId);
              console.log(
                '[AccessGrant] Encrypted payload present:',
                !!encryptedData,
              );
            }

            return msg;
          }),
        );

        // Merge with existing chat values (create room if it doesn't exist)
        setChatValues((prev) => {
          const updated = { ...prev };
          // Merge messages: update existing ones, add new ones
          if (!updated[originalRoom]) {
            updated[originalRoom] = [];
          }

          // Create a map of existing messages by timestamp for efficient lookup
          const existingMessagesMap = new Map(
            updated[originalRoom].map((msg) => [messageIdentity(msg), msg]),
          );

          // Update or add decrypted messages
          const mergedMessages = decryptedMessages.map((decryptedMsg) => {
            const existing = existingMessagesMap.get(
              messageIdentity(decryptedMsg),
            );
            if (existing) {
              // Merge: prioritize decrypted content that's not a placeholder
              let finalContent = decryptedMsg.content;
              if (
                !finalContent ||
                finalContent.trim() === '' ||
                finalContent.includes('🔒') ||
                finalContent.includes('[Encrypted message]')
              ) {
                // If decrypted content is a placeholder, use existing content if it's better
                if (
                  existing.content &&
                  existing.content.trim() !== '' &&
                  !existing.content.includes('🔒') &&
                  !existing.content.includes('[Encrypted message]')
                ) {
                  finalContent = existing.content;
                }
              }

              return {
                ...existing,
                ...decryptedMsg,
                content: finalContent,
              };
            }
            return decryptedMsg;
          });

          // Add any existing messages that weren't in the decrypted set
          existingMessagesMap.forEach((msg, identity) => {
            if (
              !decryptedMessages.find((m) => messageIdentity(m) === identity)
            ) {
              mergedMessages.push(msg);
            }
          });

          // Sort by timestamp
          mergedMessages.sort((a, b) => a.timestamp - b.timestamp);

          updated[originalRoom] = scrubMessagesForLocalState(
            mergedMessages,
            new Set(getBlockedUsers()),
          );
          console.log(
            '[AccessGrant] Updated chatValues for room:',
            originalRoom,
            'with',
            mergedMessages.length,
            'messages',
          );

          // Log the target message specifically
          const targetMsg = mergedMessages.find(
            (m) => m.timestamp === messageTimestamp,
          );
          if (targetMsg) {
            console.log('[AccessGrant] Target message after update:', {
              timestamp: targetMsg.timestamp,
              username: targetMsg.username,
              hasContent: !!targetMsg.content,
              contentLength: targetMsg.content?.length || 0,
              hasEncryptedFor: !!targetMsg.encryptedFor,
              encryptedForKeys: Object.keys(targetMsg.encryptedFor || {}),
              contentPreview: targetMsg.content
                ? targetMsg.content.substring(0, 50)
                : 'no content',
            });

            // If target message still doesn't have content, log detailed info
            if (
              !targetMsg.content ||
              targetMsg.content.trim() === '' ||
              targetMsg.content.includes('🔒') ||
              targetMsg.content.includes('[Encrypted message]')
            ) {
              console.error(
                '[AccessGrant] ⚠ Target message still not decrypted!',
              );
              console.error(
                '[AccessGrant] Message encryptedFor:',
                targetMsg.encryptedFor,
              );
              console.error('[AccessGrant] Current user:', currentUserId);
              console.error(
                '[AccessGrant] Has key in encryptedFor:',
                !!(
                  targetMsg.encryptedFor &&
                  targetMsg.encryptedFor[currentUserId]
                ),
              );
              if (targetMsg.versions && targetMsg.versions.length > 0) {
                console.error(
                  '[AccessGrant] Newest version encryptedFor:',
                  targetMsg.versions[0].encryptedFor,
                );
                console.error(
                  '[AccessGrant] Has key in newest version:',
                  !!(
                    targetMsg.versions[0].encryptedFor &&
                    targetMsg.versions[0].encryptedFor[currentUserId]
                  ),
                );
              }
            } else {
              console.log(
                '[AccessGrant] ✓ Target message successfully decrypted!',
              );
            }
          }
          return updated;
        });

        // Ensure the room is in the room list
        setRoomList((prev) => {
          if (
            !prev.includes(originalRoom) &&
            (!isDmRoom(originalRoom) || isUserInDmRoom(originalRoom, username))
          ) {
            return [...prev, originalRoom];
          }
          return prev;
        });

        console.log(
          '[AccessGrant] ✓ Updated messages for room:',
          originalRoom,
          '- message should now be visible',
        );
      } else {
        // Fallback: update the message's encrypted payload and versions
        setChatValues((prev) => {
          const updated = { ...prev };
          if (updated[originalRoom]) {
            updated[originalRoom] = updated[originalRoom].map((msg) => {
              if (msg.timestamp === messageTimestamp) {
                // Update or create versions array
                let versions = msg.versions || [];
                if (versions.length === 0 && msg.encryptedMessage) {
                  versions = [
                    {
                      encryptedMessage: msg.encryptedMessage,
                      version: 0,
                      changeSummary: 'original version',
                      timestamp: msg.timestamp,
                    },
                  ];
                }

                // Add new version
                const newVersion = {
                  encryptedMessage: encryptedPacket,
                  version: versions.length,
                  changeSummary: 'access grant re-encryption',
                  timestamp: Date.now(),
                };
                versions = [newVersion, ...versions];

                return {
                  ...msg,
                  encryptedMessage: encryptedPacket,
                  versions: versions,
                  currentVersion: 0, // Newest version
                };
              }
              return msg;
            });
          }
          return updated;
        });

        // Decrypt the newly granted message if we have access
        if (username && encryptedPacket) {
          const keys = loadKeys();
          if (keys) {
            try {
              console.log(
                '[AccessGrant] ===== DECRYPTING FOR ORIGINAL AUTHOR (FALLBACK) =====',
              );
              console.log('[AccessGrant] Message timestamp:', messageTimestamp);
              console.log('[AccessGrant] User:', username);
              console.log(
                '[AccessGrant] Encrypted data length:',
                encryptedPacket.length,
              );
              console.log(
                '[AccessGrant] Encrypted data (first 200 chars):',
                encryptedPacket.substring(0, 200),
              );
              const decrypted = await decryptMessageForUser(
                encryptedPacket,
                keys.privateKey,
              );
              console.log(
                '[AccessGrant] ✓ Decrypted granted message, content length:',
                decrypted.length,
              );
              console.log(
                '[AccessGrant] Decrypted content (first 200 chars):',
                decrypted.substring(0, 200),
              );
              console.log('[AccessGrant] Decrypted content (full):', decrypted);
              setChatValues((prev) => {
                const updated = { ...prev };
                if (updated[originalRoom]) {
                  updated[originalRoom] = scrubMessagesForLocalState(
                    updated[originalRoom].map((msg) => {
                      if (msg.timestamp === messageTimestamp) {
                        return normalizeMessageState({
                          ...msg,
                          content: decrypted,
                        });
                      }
                      return normalizeMessageState(msg);
                    }),
                    new Set(getBlockedUsers()),
                  );
                }
                return updated;
              });
              console.log('[AccessGrant] ✓ Updated UI with decrypted content');
            } catch (error) {
              console.error('[AccessGrant] ✗ Failed to decrypt:', error);
            }
          }
        }
      }

      return; // Early return for access grant
    }

    // Decrypt messages if needed
    if (data?.messages) {
      const keys = loadKeys();
      const decryptedMessages: Messages = {};
      const candidateRooms = normalizeRoomListEntries([
        ...getRoomList(),
        ...Object.keys(getRoomDirectorySnapshot()),
      ]);

      for (const [room, messages] of Object.entries(data.messages)) {
        const normalizedRoom = normalizeIncomingRoomKey(
          room,
          candidateRooms,
          messages as Message[],
        );
        const hiddenRooms = getLeftRooms();
        const isHiddenRoom =
          hiddenRooms.has(normalizedRoom) &&
          !forcedRoomPayloads.has(normalizedRoom);
        // Preserve hide behavior for normal channels; DMs can force resurfacing.
        if (isHiddenRoom && !isDmRoom(normalizedRoom)) continue;

        // Type assertion: messages from SERVER_MESSAGE should be Message[]
        const roomMessages = messages as Message[];
        const blockedUsers = new Set(getBlockedUsers());
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );

        // Ignore room updates with no visible messages (important for blocked-user DMs).
        if (visibleRoomMessages.length === 0) {
          forcedRoomPayloads.delete(normalizedRoom);
          continue;
        }

        console.log(
          `[Socket] SERVER_MESSAGE: Received ${visibleRoomMessages.length} visible messages for room ${normalizedRoom}`,
        );
        // Log replyTo fields
        const messagesWithReplies = visibleRoomMessages.filter(
          (m) => m.replyTo !== undefined && m.replyTo !== null,
        );
        if (messagesWithReplies.length > 0) {
          console.log(
            `[Socket] SERVER_MESSAGE: ${messagesWithReplies.length} messages have replyTo:`,
            messagesWithReplies.map((m) => ({
              timestamp: m.timestamp,
              replyTo: m.replyTo,
              username: m.username,
            })),
          );
        }

        const decryptedForRoom = await Promise.all(
          visibleRoomMessages.map(async (rawMsg: Message) => {
            const msg = ensureMessageId(rawMsg);
            // Preserve replyTo field
            const preservedReplyTo = msg.replyTo;

            const encryptedData = resolveEncryptedPayloadForUser(
              msg,
              username ? requireUserIdByUsername(username) : '',
            );

            if (encryptedData) {
              try {
                console.log(
                  '[Socket] ===== DECRYPTING MESSAGE IN SERVER_MESSAGE =====',
                );
                console.log('[Socket] Message timestamp:', msg.timestamp);
                console.log('[Socket] Message replyTo:', preservedReplyTo);
                console.log('[Socket] User:', keys!.username);
                console.log('[Socket] Room:', normalizedRoom);
                const decrypted = await decryptMessageForUser(
                  encryptedData,
                  keys!.privateKey,
                );
                console.log(
                  '[Socket] ✓ Decrypted message, preserving replyTo:',
                  preservedReplyTo,
                );
                // Preserve all fields including replyTo
                return ensureMessageId({
                  ...msg,
                  content: decrypted,
                  replyTo: preservedReplyTo,
                });
              } catch (error) {
                console.error('[Socket] ✗ Failed to decrypt message:', error);
                return normalizeMessageState(msg); // Return original if decryption fails (should preserve replyTo)
              }
            }
            // Return message with preserved replyTo
            return ensureMessageId(
              normalizeMessageState({ ...msg, replyTo: preservedReplyTo }),
            );
          }),
        );

        decryptedMessages[normalizedRoom] = [
          ...(decryptedMessages[normalizedRoom] || []),
          ...decryptedForRoom,
        ];

        forcedRoomPayloads.delete(normalizedRoom);
      }

      // Compute unread deltas from current chat snapshot before scheduling state updates.
      // This avoids races where unread logic sees an empty increment map.
      const unreadIncrements: Record<string, number> = {};
      const currentRoom = getCurrentRoom();
      const previousChatValues = getChatValues();
      const blockedUsersForUnread = new Set(getBlockedUsers());

      for (const [room, messages] of Object.entries(decryptedMessages)) {
        const scrubbed = scrubMessagesForLocalState(
          messages,
          blockedUsersForUnread,
        );
        const existingRoomMessages = previousChatValues[room];

        if (!existingRoomMessages) {
          unreadIncrements[room] = room === currentRoom ? 0 : scrubbed.length;
          continue;
        }

        const existingIdentities = new Set(
          existingRoomMessages.map((message) => messageIdentity(message)),
        );
        let newMessageCount = 0;
        for (const message of scrubbed) {
          if (!existingIdentities.has(messageIdentity(message))) {
            newMessageCount += 1;
          }
        }
        unreadIncrements[room] = newMessageCount;
      }

      // Merge with existing chat values instead of replacing
      // Important: preserve replyTo fields when merging
      setChatValues((prev) => {
        const merged = { ...prev };
        const blockedUsers = new Set(getBlockedUsers());
        for (const [room, messages] of Object.entries(decryptedMessages)) {
          // Merge messages by timestamp to preserve replyTo and other fields
          if (!merged[room]) {
            const scrubbed = scrubMessagesForLocalState(messages, blockedUsers);
            merged[room] = scrubbed;
          } else {
            // Create a map of existing messages by timestamp
            const existingMap = new Map(
              merged[room].map((m) => [messageIdentity(m), m]),
            );
            // Update or add new messages, preserving replyTo
            let newMessageCount = 0;
            messages.forEach((msg) => {
              const existing = existingMap.get(messageIdentity(msg));
              if (existing) {
                // Update existing message but preserve replyTo if it exists
                Object.assign(existing, msg, {
                  replyTo:
                    msg.replyTo !== undefined ? msg.replyTo : existing.replyTo,
                });
              } else {
                // Add new message
                existingMap.set(messageIdentity(msg), msg);
                newMessageCount += 1;
              }
            });
            merged[room] = scrubMessagesForLocalState(
              Array.from(existingMap.values()),
              blockedUsers,
            );
          }
        }
        console.log(
          '[Socket] Merged chatValues, checking replyTo fields:',
          Object.entries(merged).map(([r, msgs]) => ({
            room: r,
            total: msgs.length,
            withReplyTo: msgs.filter(
              (m) => m.replyTo !== undefined && m.replyTo !== null,
            ).length,
          })),
        );
        return merged;
      });

      const roomNotificationsSnapshot = getRoomNotifications();
      const nextRoomNotifications = { ...roomNotificationsSnapshot };
      for (const [room, increment] of Object.entries(unreadIncrements)) {
        if (room === currentRoom) {
          nextRoomNotifications[room] = 0;
          continue;
        }
        nextRoomNotifications[room] =
          (nextRoomNotifications[room] || 0) + increment;
      }

      setRoomNotifications((prev) => {
        const updated = { ...prev };
        for (const [room, increment] of Object.entries(unreadIncrements)) {
          if (room === currentRoom) {
            updated[room] = 0;
            continue;
          }
          updated[room] = (updated[room] || 0) + increment;
        }
        return updated;
      });

      // Only force hidden DMs back into view when there are truly new unread messages.
      const hiddenRooms = getLeftRooms();
      const hiddenDmUnreadBaseline = getHiddenDmUnreadBaseline();
      const dmRoomsToUnhide = Object.entries(unreadIncrements)
        .filter(
          ([room, increment]) =>
            increment > 0 &&
            isDmRoom(room) &&
            isUserInDmRoom(room, username) &&
            hiddenRooms.has(room) &&
            (nextRoomNotifications[room] || 0) >
              (hiddenDmUnreadBaseline[room] ?? 0),
        )
        .map(([room]) => room);

      if (dmRoomsToUnhide.length > 0) {
        setLeftRooms((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const room of dmRoomsToUnhide) {
            if (next.delete(room)) {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setHiddenDmUnreadBaseline((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const room of dmRoomsToUnhide) {
            if (room in next) {
              delete next[room];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      // Ensure all rooms from messages are in the room list
      setRoomList((prev) => {
        const updated = [...prev];
        let changed = false;
        for (const room of Object.keys(decryptedMessages)) {
          if (isSyntheticSystemDmRoom(room)) {
            continue;
          }
          if (isDmRoom(room) && !isUserInDmRoom(room, username)) {
            continue;
          }
          if (!updated.includes(room)) {
            updated.push(room);
            changed = true;
          }
        }
        const normalized = normalizeRoomListEntries(updated);
        return changed || normalized.length !== prev.length ? normalized : prev;
      });
      const nextVisibleRooms = normalizeRoomListEntries([
        ...getRoomList(),
        ...Object.keys(decryptedMessages),
      ]);
      if (!nextVisibleRooms.includes(getCurrentRoom())) {
        setCurrentRoom(resolveFallbackRoom(nextVisibleRooms));
      }
    }

    // Update user lists only from explicit loggedInUsers/activeUsers payloads.
    if (data?.loggedInUsers !== undefined || data?.activeUsers !== undefined) {
      const loggedInDisplay = toDisplayUsers(data.loggedInUsers || []);
      const activeDisplay = toDisplayUsers(data.activeUsers || []);
      setLoggedInUsers(loggedInDisplay);
      setActiveUsers(activeDisplay);
      const allUsers = [...loggedInDisplay, ...activeDisplay];
      setUserList(allUsers);
    }

    // Update room members if provided
    if (data?.roomMembers) {
      setRoomMembers((prev) => {
        const updated = { ...prev };
        for (const [room, members] of Object.entries(data.roomMembers)) {
          updated[room] = new Set(members as string[]);
        }
        return updated;
      });
    }

    // Update user last seen if provided
    if (data?.userLastSeen) {
      setUserLastSeen(data.userLastSeen as Record<string, number>);
    }

    // Update user public keys if provided
    if (data?.userPubKeys) {
      await maybeSendIdentityDirectoryRefresh({
        socket: activeSocket,
        authToken,
        username,
        incomingUserPubKeys: data.userPubKeys,
      });
      console.log('[Socket] ✓ Updating user public keys');
      storeUserPublicKeys(
        data.userPubKeys,
        (data.userPubKeysUpdatedAt as Record<string, number>) || undefined,
      );
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_NEW_ROOM, async (data) => {
    if (
      !(await verifyServerEventEnvelope(SOCKET_EVENTS.SERVER_NEW_ROOM, data))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_NEW_ROOM payload',
      );
      return;
    }

    await applyEncryptedRoomDirectory(data);

    console.log('[Socket] SERVER_NEW_ROOM received');
    const newRoomUserDirectoryApplied = await applyEncryptedUserDirectory(data);
    if (newRoomUserDirectoryApplied > 0) {
      refreshDisplayedUserLists({
        setUserList,
        setLoggedInUsers,
        setActiveUsers,
      });
    }
    if (data?.messages) {
      // Merge payload into existing room history to avoid truncating previously loaded messages.
      setChatValues((prev) => {
        const merged = { ...prev };
        const blockedUsers = new Set(getBlockedUsers());
        const candidateRooms = normalizeRoomListEntries([
          ...Object.keys(prev),
          ...getRoomList(),
          ...Object.keys(getRoomDirectorySnapshot()),
        ]);
        for (const [room, rawMessages] of Object.entries(data.messages)) {
          const normalizedRoom = normalizeIncomingRoomKey(
            room,
            candidateRooms,
            rawMessages as Message[],
          );
          const incomingMessages = scrubMessagesForLocalState(
            (rawMessages as Message[]).map((msg) => ensureMessageId(msg)),
            blockedUsers,
          );

          if (!merged[normalizedRoom]) {
            merged[normalizedRoom] = incomingMessages;
            continue;
          }

          const existingMap = new Map(
            merged[normalizedRoom].map((message) => [
              messageIdentity(message),
              message,
            ]),
          );
          for (const message of incomingMessages) {
            const key = messageIdentity(message);
            const existing = existingMap.get(key);
            if (existing) {
              Object.assign(existing, message, {
                replyTo:
                  message.replyTo !== undefined
                    ? message.replyTo
                    : existing.replyTo,
              });
            } else {
              existingMap.set(key, message);
            }
          }

          merged[normalizedRoom] = scrubMessagesForLocalState(
            Array.from(existingMap.values()),
            blockedUsers,
          );
        }
        return merged;
      });
    }
    if (Array.isArray(data?.rooms) && data.rooms.length > 0) {
      const nextRooms = filterRoomsForUser(data.rooms, username).map((room) =>
        normalizeIncomingRoomKey(room, data.rooms as string[]),
      );
      console.log('[Socket] SERVER_MESSAGE room payload:', {
        roomCount: data.rooms.length,
        filteredCount: nextRooms.length,
      });
      setRoomList((prev) => {
        const merged = [...prev];
        let changed = false;
        for (const room of nextRooms) {
          if (!merged.includes(room)) {
            merged.push(room);
            changed = true;
          }
        }
        const normalized = normalizeRoomListEntries(merged);
        return changed || normalized.length !== prev.length ? normalized : prev;
      });
      const nextVisibleRooms = normalizeRoomListEntries([
        ...getRoomList(),
        ...nextRooms,
      ]);
      if (!nextVisibleRooms.includes(getCurrentRoom())) {
        setCurrentRoom(resolveFallbackRoom(nextVisibleRooms));
      }
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_IDENTITY_DIRECTORY_REFRESH payload',
      );
      return;
    }

    const applied = await validateAndApplyIdentityRefresh(data);
    if (applied.roomApplied === 0 && applied.userApplied === 0) {
      return;
    }

    // Force UI refresh so newly decrypted names replace ID fallbacks immediately.
    setRoomList((prev) => normalizeRoomListEntries(prev));
    refreshDisplayedUserLists({
      setUserList,
      setLoggedInUsers,
      setActiveUsers,
    });

    console.log('[Socket] Applied identity directory refresh:', applied);
  });

  socket.on(SOCKET_EVENTS.SERVER_USER_LIST_UPDATE, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_USER_LIST_UPDATE,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_USER_LIST_UPDATE payload',
      );
      return;
    }

    console.log('[Socket] SERVER_USER_LIST_UPDATE received:', data);

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if ('loggedInUsers' in data || 'activeUsers' in data) {
        const loggedInDisplay = toDisplayUsers(
          (data as any).loggedInUsers || [],
        );
        const activeDisplay = toDisplayUsers((data as any).activeUsers || []);
        setLoggedInUsers(loggedInDisplay);
        setActiveUsers(activeDisplay);
        if ((data as any).userLastSeen) {
          setUserLastSeen((data as any).userLastSeen as Record<string, number>);
        }
        const allUsers = [...loggedInDisplay, ...activeDisplay];
        setUserList(allUsers);
        console.log(
          '[Socket] ✓ Updated user lists:',
          (data as any).loggedInUsers?.length || 0,
          'logged in,',
          (data as any).activeUsers?.length || 0,
          'active',
        );
      } else {
        console.warn('[Socket] ✗ Invalid user list format:', data);
      }
    } else {
      console.warn('[Socket] ✗ Invalid user list format:', data);
    }
  });

  // Handle join requests
  socket.on(SOCKET_EVENTS.SERVER_JOIN_REQUEST, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_JOIN_REQUEST,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_JOIN_REQUEST payload',
      );
      return;
    }

    console.log('[Socket] SERVER_JOIN_REQUEST received:', data);
    if (
      data?.type === 'joinRequest' &&
      data?.requestingUserId &&
      data?.room &&
      data?.roomId
    ) {
      const requestingUser =
        getUsernameByUserId(data.requestingUserId) || data.requestingUserId;

      setActiveJoinRequests((prev) => {
        const exists = prev.some(
          (req) =>
            req.requestingUserId === data.requestingUserId &&
            req.roomId === data.roomId,
        );
        if (!exists) {
          return [
            ...prev,
            {
              requestingUserId: data.requestingUserId,
              requestingUser,
              roomId: data.roomId,
              room: data.room,
              timestamp: data.timestamp || Date.now(),
            },
          ];
        }
        return prev;
      });
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_JOIN_APPROVED, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_JOIN_APPROVED,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_JOIN_APPROVED payload',
      );
      return;
    }

    console.log('[Socket] SERVER_JOIN_APPROVED received:', data);
    if (
      data?.type === 'joinApproved' &&
      data?.requestingUserId &&
      data?.roomId
    ) {
      setActiveJoinRequests((prev) =>
        prev.filter(
          (req) =>
            !(
              req.requestingUserId === data.requestingUserId &&
              req.roomId === data.roomId
            ),
        ),
      );
      // Update room members
      setRoomMembers((prev) => {
        const updated = { ...prev };
        if (!updated[data.roomId]) {
          updated[data.roomId] = new Set();
        }
        updated[data.roomId].add(data.requestingUserId);
        return updated;
      });
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_JOIN_DENIED, async (data) => {
    if (
      !(await verifyServerEventEnvelope(SOCKET_EVENTS.SERVER_JOIN_DENIED, data))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_JOIN_DENIED payload',
      );
      return;
    }

    console.log('[Socket] SERVER_JOIN_DENIED received:', data);
    if (data?.type === 'joinDenied' && data?.requestingUserId && data?.roomId) {
      setActiveJoinRequests((prev) =>
        prev.filter(
          (req) =>
            !(
              req.requestingUserId === data.requestingUserId &&
              req.roomId === data.roomId
            ),
        ),
      );
    }
  });

  // Handle access requests - show in private room named after the other user
  socket.on(SOCKET_EVENTS.SERVER_ACCESS_REQUEST, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_ACCESS_REQUEST,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_ACCESS_REQUEST payload',
      );
      return;
    }

    console.log('[Socket] SERVER_ACCESS_REQUEST received:', data);
    if (data?.requestAccess) {
      const requestAccess = data.requestAccess as Record<string, unknown>;
      const requestingUserId =
        (typeof data.requestingUserId === 'string' && data.requestingUserId) ||
        (typeof requestAccess.requestingUserId === 'string'
          ? requestAccess.requestingUserId
          : '');
      const originalSenderId =
        (typeof data.originalSenderId === 'string' && data.originalSenderId) ||
        (typeof requestAccess.originalSenderId === 'string'
          ? requestAccess.originalSenderId
          : '');
      const requestingUser =
        (requestingUserId
          ? getUsernameByUserId(requestingUserId)
          : undefined) || requestingUserId;
      // The server sends the appropriate room name for this user:
      // - Original sender sees @requestingUser
      // - Requesting user sees @originalSender (from SERVER_MESSAGE, not this event)
      const dmRoom = data?.requestRoom;

      if (!dmRoom) {
        console.warn(
          '[AccessRequest] ⚠ No requestRoom provided in SERVER_ACCESS_REQUEST',
        );
        return;
      }

      if (!requestingUserId || !originalSenderId) {
        console.warn(
          '[AccessRequest] ⚠ Missing sender ids in SERVER_ACCESS_REQUEST',
        );
        return;
      }

      // Store the requesting user's public key if provided by server
      if (data?.requestingUserPubKey && requestingUser) {
        console.log(
          '[AccessRequest] Storing requesting user public key for:',
          requestingUser,
        );
        const userPubKeys = loadUserPublicKeyEntries() || {};
        userPubKeys[requestingUser] = {
          publicKey: data.requestingUserPubKey,
          updatedAt:
            typeof data.requestingUserPubKeyUpdatedAt === 'number'
              ? data.requestingUserPubKeyUpdatedAt
              : undefined,
          blocked: !!userPubKeys[requestingUser]?.blocked,
        };
        storeUserPublicKeys(userPubKeys);
        console.log(
          '[AccessRequest] ✓ Stored public key for requesting user:',
          requestingUser,
        );
      } else {
        console.warn(
          '[AccessRequest] ⚠ No public key provided for requesting user:',
          requestingUser,
        );
      }

      // Add room if it doesn't exist (only for original sender, requesting user gets it from SERVER_MESSAGE)
      const currentUserId = requireUserIdByUsername(username);
      if (originalSenderId === currentUserId) {
        setRoomList((prev) => {
          if (isSyntheticSystemDmRoom(dmRoom)) {
            return prev;
          }
          if (!prev.includes(dmRoom)) {
            return normalizeRoomListEntries([...prev, dmRoom]);
          }
          return prev;
        });
        setCurrentRoom(dmRoom);
      }
    }
  });

  // Handle access denied notifications
  socket.on(SOCKET_EVENTS.SERVER_ACCESS_DENIED, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_ACCESS_DENIED,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_ACCESS_DENIED payload',
      );
      return;
    }

    console.log('[Socket] SERVER_ACCESS_DENIED received:', data);
    if (data?.accessDenied) {
      const { originalRoom, messageTimestamp } = data.accessDenied;
      alert(
        `Access to your message in ${originalRoom} was denied by the original sender.`,
      );
    }
  });

  // Handle vote updates
  socket.on(SOCKET_EVENTS.SERVER_VOTE_UPDATE, async (data) => {
    if (
      !(await verifyServerEventEnvelope(SOCKET_EVENTS.SERVER_VOTE_UPDATE, data))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_VOTE_UPDATE payload',
      );
      return;
    }

    console.log('[Socket] SERVER_VOTE_UPDATE received');
    if (data?.messages) {
      // Update messages with new vote data
      const keys = loadKeys();
      const currentUserId = username ? requireUserIdByUsername(username) : '';
      const decryptedMessages: Messages = {};
      const candidateRooms = normalizeRoomListEntries([
        ...getRoomList(),
        ...Object.keys(getRoomDirectorySnapshot()),
      ]);

      for (const [room, messages] of Object.entries(data.messages)) {
        const normalizedRoom = normalizeIncomingRoomKey(room, candidateRooms);
        const roomMessages = messages as Message[];
        const blockedUsers = new Set(getBlockedUsers());
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );
        const decryptedForRoom = await Promise.all(
          visibleRoomMessages.map(async (msg: Message) => {
            // If message has encryptedFor and we have keys, decrypt it
            if (msg.encryptedFor && keys) {
              const encrypted = currentUserId
                ? msg.encryptedFor[currentUserId]
                : undefined;
              if (encrypted) {
                try {
                  const decrypted = await decryptMessageForUser(
                    encrypted,
                    keys.privateKey,
                  );
                  return normalizeMessageState({ ...msg, content: decrypted });
                } catch (error) {
                  console.error('[Socket] ✗ Failed to decrypt message:', error);
                  return normalizeMessageState(msg);
                }
              }
            }
            return msg;
          }),
        );
        decryptedMessages[normalizedRoom] = [
          ...(decryptedMessages[normalizedRoom] || []),
          ...decryptedForRoom,
        ];
      }

      setChatValues((prev) => {
        const merged = { ...prev };
        const blockedUsers = new Set(getBlockedUsers());
        for (const [room, messages] of Object.entries(decryptedMessages)) {
          if (!merged[room]) {
            merged[room] = scrubMessagesForLocalState(messages, blockedUsers);
            continue;
          }

          const existingMap = new Map(
            merged[room].map((m) => [messageIdentity(m), m]),
          );
          messages.forEach((msg) => {
            existingMap.set(messageIdentity(msg), {
              ...existingMap.get(messageIdentity(msg)),
              ...msg,
            });
          });
          merged[room] = scrubMessagesForLocalState(
            Array.from(existingMap.values()),
            blockedUsers,
          );
        }
        return merged;
      });
    }
  });

  socket.on(SOCKET_EVENTS.DISCONNECTING, (msg) => {
    const keys = loadKeys();
    if (keys?.sessionId) {
      const userId = requireUserIdByUsername(username);
      const roomId = requireRoomIdByName(DEFAULT_ROOM);
      void emitSignedMutation(activeSocket, {
        event: SOCKET_EVENTS.CLIENT_MESSAGE,
        payload: {
          userId,
          sessionId: keys.sessionId,
          room: DEFAULT_ROOM,
          roomId,
          content: SYSTEM_MESSAGES.USER_LEFT,
        },
        userId,
        sessionId: keys.sessionId,
        claims: {
          roomId,
        },
      });
    }
    activeSocket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
    setAuthToken('');
  });

  socket.on(SOCKET_EVENTS.STATUS, (msg) => {
    console.log('[Socket] STATUS received:', msg);
  });

  socket.on(SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED, async (data) => {
    if (
      !(await verifyServerEventEnvelope(
        SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED,
        data,
      ))
    ) {
      console.error(
        '[Socket] Rejected unsigned or invalid SERVER_PUBLIC_KEY_RECEIVED payload',
      );
      return;
    }

    if (typeof data?.fromUserId === 'string' && data?.publicKey) {
      const fromUserId = data.fromUserId;
      const fromUser = getUsernameByUserId(fromUserId) || fromUserId;

      const transferDmRoom =
        typeof data.transferDmRoom === 'string' && data.transferDmRoom
          ? data.transferDmRoom
          : typeof data.transferDmRoomId === 'string'
            ? getRoomNameByRoomId(data.transferDmRoomId)
            : undefined;

      if (transferDmRoom) {
        forcedRoomPayloads.add(transferDmRoom);

        setLeftRooms((prev) => {
          if (!prev.has(transferDmRoom)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(transferDmRoom);
          return next;
        });
        setHiddenDmUnreadBaseline((prev) => {
          if (!(transferDmRoom in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[transferDmRoom];
          return next;
        });

        const hadTransferRoom = getRoomList().includes(transferDmRoom);
        setRoomList((prev) =>
          prev.includes(transferDmRoom)
            ? prev
            : normalizeRoomListEntries([...prev, transferDmRoom]),
        );

        if (!hadTransferRoom && getCurrentRoom() !== transferDmRoom) {
          setRoomNotifications((prev) => ({
            ...prev,
            [transferDmRoom]: Math.max(prev[transferDmRoom] || 0, 1),
          }));
        }

        const keys = loadKeys();
        if (keys?.sessionId) {
          let roomId: string | undefined;
          try {
            roomId = requireRoomIdByName(transferDmRoom);
          } catch {
            roomId = undefined;
          }

          activeSocket.emit(SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA, {
            userId: requireUserIdByUsername(username),
            sessionId: keys.sessionId,
            room: transferDmRoom,
            ...(roomId ? { roomId } : {}),
          });
        }
      }

      if (fromUser) {
        const userPubKeys = loadUserPublicKeyEntries() || {};
        const hadSenderKey = !!userPubKeys[fromUserId]?.publicKey;
        const nextUserPubKeys = {
          ...userPubKeys,
          [fromUserId]: {
            publicKey: data.publicKey,
            blocked: !!userPubKeys[fromUserId]?.blocked,
            blockedAt: userPubKeys[fromUserId]?.blockedAt,
            blockedBy: userPubKeys[fromUserId]?.blockedBy,
          },
        };

        if (!hadSenderKey) {
          await maybeSendIdentityDirectoryRefresh({
            socket: activeSocket,
            authToken,
            username,
            incomingUserPubKeys: nextUserPubKeys,
          });
        }

        userPubKeys[fromUserId] = {
          publicKey: data.publicKey,
          updatedAt:
            typeof data.publicKeyUpdatedAt === 'number'
              ? data.publicKeyUpdatedAt
              : undefined,
          blocked: !!userPubKeys[fromUserId]?.blocked,
          blockedAt: userPubKeys[fromUserId]?.blockedAt,
          blockedBy: userPubKeys[fromUserId]?.blockedBy,
        };
        storeUserPublicKeys(userPubKeys, {
          [fromUserId]:
            typeof data.publicKeyUpdatedAt === 'number'
              ? data.publicKeyUpdatedAt
              : Date.now(),
        });
      }
      console.log('[Socket] ✓ Stored public key from', fromUserId || fromUser);
    }
  });

  socket.on(SOCKET_EVENTS.CONNECT, async () => {
    console.log('[Socket] ===== CONNECTED =====');
    console.log('[Socket] Socket ID:', activeSocket.id);
    console.log('[Socket] Socket connected:', activeSocket.connected);
    const keys = loadKeys();
    if (keys?.publicKey && username) {
      const fromUserId = requireUserIdByUsername(username);
      void emitSignedMutation(activeSocket, {
        event: SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY,
        payload: {
          fromUserId,
          sessionId: authToken,
          publicKey: keys.publicKey,
        },
        userId: fromUserId,
        sessionId: authToken,
        claims: {
          fromUserId,
          publicKey: keys.publicKey,
        },
      });
      console.log('[Socket] ✓ Announced public key for', username);
    }

    const prefs = await loadRoomPrefs(username);
    const requestedCurrentRoom = prefs.currentRoom || DEFAULT_ROOM;
    preferredRoomFromPrefs = requestedCurrentRoom;
    const requestedOpenRooms =
      prefs.openRooms && prefs.openRooms.length > 0
        ? prefs.openRooms
        : [DEFAULT_ROOM];
    const requestedCurrentRoomId = getRoomIdByName(requestedCurrentRoom);
    const requestedOpenRoomIds = requestedOpenRooms
      .map((room) => getRoomIdByName(room))
      .filter(
        (roomId): roomId is string =>
          typeof roomId === 'string' && roomId.trim() !== '',
      );

    activeSocket.emit(SOCKET_EVENTS.CLIENT_REQUEST_INITIAL_DATA, {
      userId: requireUserIdByUsername(username),
      sessionId: authToken,
      defaultRoom: DEFAULT_ROOM,
      currentRoom: requestedCurrentRoom,
      currentRoomId: requestedCurrentRoomId || requestedCurrentRoom,
      openRooms: requestedOpenRooms,
      openRoomIds: requestedOpenRoomIds,
    });
    console.log('[Socket] ✓ Requested filtered initial data', {
      currentRoom: requestedCurrentRoom,
      openRooms: requestedOpenRooms,
    });
    // Join messages are now sent automatically by the server
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
    console.log('[Socket] ===== DISCONNECTED =====');
    console.log('[Socket] Reason:', reason);
    console.log('[Socket] Socket ID:', activeSocket.id);
  });

  socket.on('connect_error', (error: Error) => {
    console.error('[Socket] ===== CONNECTION ERROR =====');
    console.error('[Socket] Error object:', error);
    console.error('[Socket] Error message:', error.message);
    console.error('[Socket] Error name:', error.name);
    console.error('[Socket] Error stack:', error.stack);
  });

  socket.on('error', (error) => {
    console.error('[Socket] ===== SOCKET ERROR =====');
    console.error('[Socket] Error:', error);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] ===== DISCONNECT EVENT =====');
    console.log('[Socket] Reason:', reason);
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log('[Socket] ===== RECONNECTED =====');
    console.log('[Socket] Attempt number:', attemptNumber);
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log('[Socket] Reconnect attempt:', attemptNumber);
  });

  socket.on('reconnect_error', (error) => {
    console.error('[Socket] Reconnect error:', error);
  });

  socket.on('reconnect_failed', () => {
    console.error('[Socket] ===== RECONNECT FAILED =====');
  });

  console.log('[Socket] All listeners registered');
  console.log(
    '[Socket] Socket state - connected:',
    activeSocket.connected,
    'id:',
    activeSocket.id,
  );
}
