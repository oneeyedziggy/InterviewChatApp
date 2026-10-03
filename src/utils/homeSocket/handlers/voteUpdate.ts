import { type Message, type Messages } from '../../../types/types';
import { SOCKET_EVENTS } from '../../../constants';
import { decryptMessageForUser, loadKeysAsync } from '../../gpg';
import { requireUserIdByUsername } from '../../identityMap';
import { getBlockedUsers } from '../../userSettings';
import {
  filterBlockedAuthors,
  messageIdentity,
  normalizeMessageState,
  scrubMessagesForLocalState,
  type StoredKeys,
} from '../messageState';
import { buildCandidateRooms, normalizeIncomingRoomKey } from '../roomKeys';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

// Vote payloads only carry per-recipient `encryptedFor` ciphertexts.
const decryptVotedMessage = async (
  msg: Message,
  keys: StoredKeys,
  currentUserId: string,
): Promise<Message> => {
  const encrypted =
    msg.encryptedFor && keys && currentUserId
      ? msg.encryptedFor[currentUserId]
      : undefined;
  if (!encrypted || !keys) {
    return msg;
  }
  try {
    const decrypted = await decryptMessageForUser(encrypted, keys.privateKey);
    return normalizeMessageState({ ...msg, content: decrypted });
  } catch (error) {
    console.error('[Socket] ✗ Failed to decrypt message:', error);
    return normalizeMessageState(msg);
  }
};

export const registerVoteUpdateHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const { username, getRoomList, setChatValues } = ctx;

  on(
    SOCKET_EVENTS.SERVER_VOTE_UPDATE,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_VOTE_UPDATE, async (data) => {
      if (!data?.messages) {
        return;
      }
      const keys = await loadKeysAsync();
      const currentUserId = username ? requireUserIdByUsername(username) : '';
      const decryptedMessages: Messages = {};
      const candidateRooms = buildCandidateRooms(getRoomList());

      for (const [room, messages] of Object.entries(data.messages)) {
        const normalizedRoom = normalizeIncomingRoomKey(room, candidateRooms);
        const decryptedForRoom = await Promise.all(
          filterBlockedAuthors(
            messages as Message[],
            new Set(getBlockedUsers()),
          ).map((msg) => decryptVotedMessage(msg, keys, currentUserId)),
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
          for (const msg of messages) {
            const key = messageIdentity(msg);
            existingMap.set(key, { ...existingMap.get(key), ...msg });
          }
          merged[room] = scrubMessagesForLocalState(
            Array.from(existingMap.values()),
            blockedUsers,
          );
        }
        return merged;
      });
    }),
  );
};
