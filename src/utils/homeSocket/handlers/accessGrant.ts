import { type Message } from '../../../types/types';
import { decryptMessageForUser, loadKeysAsync } from '../../gpg';
import {
  getUserIdByUsername,
  getRoomNameByRoomId,
} from '../../identityMap';
import { getBlockedUsers } from '../../userSettings';
import { isDmRoom, isUserInDmRoom } from '../../dmRooms';
import { isPlaceholderContent } from '../../messages';
import {
  messageIdentity,
  normalizeMessageState,
  resolveEncryptedPayloadForUser,
  scrubMessagesForLocalState,
  sortByTimestamp,
} from '../messageState';
import { buildCandidateRooms, normalizeIncomingRoomKey } from '../roomKeys';
import { type HomeSocketContext } from './context';

type AccessGrant = {
  originalRoom: string;
  messageTimestamp: number;
  encryptedMessage?: string;
};

const decryptGrantedMessages = async (
  roomMessages: Message[],
  privateKey: string,
  currentUserId: string,
): Promise<Message[]> =>
  Promise.all(
    roomMessages.map(async (msg) => {
      if (!isPlaceholderContent(msg.content)) {
        return msg;
      }
      const encryptedData = resolveEncryptedPayloadForUser(msg, currentUserId);
      if (!encryptedData) {
        return msg;
      }
      try {
        const decrypted = await decryptMessageForUser(
          encryptedData,
          privateKey,
        );
        return { ...msg, content: decrypted };
      } catch (error) {
        console.error('[AccessGrant] ✗ Failed to decrypt message:', error);
        return msg;
      }
    }),
  );

/** Prefers readable content from either side when merging a granted message over an existing one. */
const mergeGrantedMessages = (
  existing: Message[],
  granted: Message[],
): Message[] => {
  const existingByIdentity = new Map(
    existing.map((msg) => [messageIdentity(msg), msg]),
  );
  const grantedIdentities = new Set(granted.map((m) => messageIdentity(m)));

  const merged = granted.map((grantedMsg) => {
    const current = existingByIdentity.get(messageIdentity(grantedMsg));
    if (!current) {
      return grantedMsg;
    }
    const content =
      isPlaceholderContent(grantedMsg.content) &&
      !isPlaceholderContent(current.content)
        ? current.content
        : grantedMsg.content;
    return { ...current, ...grantedMsg, content };
  });

  existingByIdentity.forEach((msg, identity) => {
    if (!grantedIdentities.has(identity)) {
      merged.push(msg);
    }
  });

  return sortByTimestamp(merged);
};

const applyServerGrantedMessages = async (
  ctx: HomeSocketContext,
  originalRoom: string,
  roomMessages: Message[],
  messageTimestamp: number,
) => {
  const { username, setChatValues, setRoomList } = ctx;
  const keys = await loadKeysAsync();
  if (!keys) {
    console.error('[AccessGrant] No keys available for decryption');
    return;
  }
  const currentUserId = keys.userId || getUserIdByUsername(username);
  if (!currentUserId) {
    console.warn('[AccessGrant] Cannot decrypt granted messages without a stored identity');
    return;
  }
  const decryptedMessages = await decryptGrantedMessages(
    roomMessages,
    keys.privateKey,
    currentUserId,
  );

  setChatValues((prev) => {
    const mergedMessages = mergeGrantedMessages(
      prev[originalRoom] || [],
      decryptedMessages,
    );
    const target = mergedMessages.find((m) => m.timestamp === messageTimestamp);
    if (target && isPlaceholderContent(target.content)) {
      console.warn('[AccessGrant] ⚠ Target message still not decrypted', {
        timestamp: messageTimestamp,
      });
    }
    return {
      ...prev,
      [originalRoom]: scrubMessagesForLocalState(
        mergedMessages,
        new Set(getBlockedUsers()),
      ),
    };
  });

  setRoomList((prev) => {
    if (
      !prev.includes(originalRoom) &&
      (!isDmRoom(originalRoom) || isUserInDmRoom(originalRoom, username))
    ) {
      return [...prev, originalRoom];
    }
    return prev;
  });

  console.log('[AccessGrant] ✓ Updated messages for room:', originalRoom);
};

const withGrantedVersion = (msg: Message, encryptedPacket: string): Message => {
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
  const newVersion = {
    encryptedMessage: encryptedPacket,
    version: versions.length,
    changeSummary: 'access grant re-encryption',
    timestamp: Date.now(),
  };
  return {
    ...msg,
    encryptedMessage: encryptedPacket,
    versions: [newVersion, ...versions],
    currentVersion: 0,
  };
};

const applyFallbackGrant = async (
  ctx: HomeSocketContext,
  originalRoom: string,
  messageTimestamp: number,
  encryptedPacket: string,
) => {
  const { username, setChatValues } = ctx;
  setChatValues((prev) => {
    if (!prev[originalRoom]) {
      return { ...prev };
    }
    return {
      ...prev,
      [originalRoom]: prev[originalRoom].map((msg) =>
        msg.timestamp === messageTimestamp
          ? withGrantedVersion(msg, encryptedPacket)
          : msg,
      ),
    };
  });

  if (!username || !encryptedPacket) {
    return;
  }
  const keys = await loadKeysAsync();
  if (!keys) {
    return;
  }
  try {
    const decrypted = await decryptMessageForUser(
      encryptedPacket,
      keys.privateKey,
    );
    setChatValues((prev) => {
      if (!prev[originalRoom]) {
        return { ...prev };
      }
      return {
        ...prev,
        [originalRoom]: scrubMessagesForLocalState(
          prev[originalRoom].map((msg) =>
            normalizeMessageState(
              msg.timestamp === messageTimestamp
                ? { ...msg, content: decrypted }
                : msg,
            ),
          ),
          new Set(getBlockedUsers()),
        ),
      };
    });
    console.log('[AccessGrant] ✓ Updated UI with decrypted content');
  } catch (error) {
    console.error('[AccessGrant] ✗ Failed to decrypt:', error);
  }
};

export const handleAccessGrant = async (ctx: HomeSocketContext, data: any) => {
  const {
    originalRoom: originalRoomHint,
    messageTimestamp,
    encryptedMessage,
  } = data.accessGrant as AccessGrant;
  const matchingWireRoom = Object.keys(data.messages || {}).find(
    (room) =>
      room === originalRoomHint ||
      getRoomNameByRoomId(room) === originalRoomHint,
  );
  const originalRoom = normalizeIncomingRoomKey(
    matchingWireRoom || originalRoomHint,
    buildCandidateRooms(Object.keys(ctx.getChatValues()), ctx.getRoomList()),
  );

  console.log('[AccessGrant] Processing access grant', {
    room: originalRoom,
    messageTimestamp,
  });

  if (data?.messages && matchingWireRoom && data.messages[matchingWireRoom]) {
    await applyServerGrantedMessages(
      ctx,
      originalRoom,
      data.messages[matchingWireRoom] as Message[],
      messageTimestamp,
    );
  } else {
    await applyFallbackGrant(
      ctx,
      originalRoom,
      messageTimestamp,
      encryptedMessage || '',
    );
  }
};
