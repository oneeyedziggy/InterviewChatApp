import { type Socket } from '../websocketClient';
import { type Messages } from '../../types/types';
import { DEFAULT_ROOM, SOCKET_EVENTS } from '../../constants';
import {
  encryptForAllUsers,
  loadKeysAsync,
  loadUserPublicKeyEntries,
} from '../gpg';
import { emitSignedMutation } from '../socketAuth';
import {
  getCurrentUserId,
  getRoomIdByName,
  getRoomNameByRoomId,
  requireUserIdByUsername,
} from '../identityMap';
import { isDmRoom } from '../dmRooms';
import { normalizeRoomName } from '../unicode';
import { sha256Hex } from '../crypto/sha256';
import { collectEncryptionRecipients } from './identityDirectory';

const roomNameHash = (roomName: string): Promise<string> =>
  sha256Hex(normalizeRoomName(roomName));

/** Re-encrypts this user's readable channel messages so a newly seen member can read them. */
export const maybeGrantNewMemberAccess = async (args: {
  socket: Socket;
  authToken: string;
  username: string;
  newUserId: string;
  getChatValues: () => Messages;
}): Promise<void> => {
  const { socket, authToken, username, newUserId, getChatValues } = args;
  const keys = await loadKeysAsync();
  if (!keys?.privateKey || !keys.publicKey || !authToken || !newUserId) return;

  const userId = keys.userId || requireUserIdByUsername(username);
  const recipients = collectEncryptionRecipients(loadUserPublicKeyEntries());

  for (const [room, roomMessages] of Object.entries(getChatValues())) {
    if (isDmRoom(room)) continue;
    const roomId = getRoomIdByName(room) || room;
    for (const message of roomMessages) {
      if (
        message.userId !== userId ||
        !message.content ||
        message.content.includes('[Encrypted message]')
      ) {
        continue;
      }
      try {
        const encryptedMessage = await encryptForAllUsers(
          message.content,
          { ...recipients, [newUserId]: recipients[newUserId] },
          keys.publicKey,
        );
        await emitSignedMutation(socket, {
          event: SOCKET_EVENTS.CLIENT_GRANT_ACCESS,
          payload: {
            requestingUserId: newUserId,
            originalRoomId: roomId,
            messageTimestamp: message.timestamp,
            encryptedMessage,
            userId,
            sessionId: authToken,
          },
          userId,
          sessionId: authToken,
          claims: {
            requestingUserId: newUserId,
            originalRoomId: roomId,
            messageTimestamp: message.timestamp,
            encryptedMessage,
          },
        });
      } catch (error) {
        console.warn('[Socket] Skipped automatic member message grant:', error);
      }
    }
  }
};

export const ensureDefaultRoomExists = async (args: {
  socket: Socket;
  authToken: string;
  username: string;
  roomIdsFromServer: unknown;
  incomingUserPubKeys?: unknown;
  retryAttempt?: number;
}): Promise<void> => {
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

  const keys = await loadKeysAsync();
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
          ...args,
          retryAttempt: retryAttempt + 1,
        });
      }, 600);
    }
    console.warn('[Socket] Default room bootstrap attempt failed', error);
    return;
  }

  console.log('[Socket] Bootstrapped missing default room:', DEFAULT_ROOM);
};
