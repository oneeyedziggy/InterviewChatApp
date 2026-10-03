import { type Message } from '../../types/types';
import { decryptMessageForUser, type loadKeysAsync } from '../gpg';
import { getUsernameByUserId } from '../identityMap';
import { isPlaceholderContent } from '../messages';

export type StoredKeys = Awaited<ReturnType<typeof loadKeysAsync>>;

export const ensureMessageId = (message: Message): Message => {
  if (message.id && message.id.trim() !== '') {
    return message;
  }
  // Deterministic (not random) so re-delivery of the same server message
  // dedupes correctly instead of being treated as a brand-new message.
  return {
    ...message,
    id: `legacy:${message.roomId || ''}:${message.timestamp}:${message.userId || ''}`,
  };
};

export const normalizeMessageState = (message: Message): Message => {
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
};

export const isBlockedAuthor = (
  message: Message,
  blockedUsers: Set<string>,
): boolean => {
  if (message.userId === 'system') {
    return false;
  }
  const authorName = getUsernameByUserId(message.userId);
  return !!authorName && blockedUsers.has(authorName);
};

export const isEncryptedMessageWithoutReadableContent = (
  message: Message,
): boolean => {
  const hasEncryptedPayload =
    !!message.encryptedMessage ||
    !!message.encryptedFor ||
    (message.versions?.length || 0) > 0;
  return hasEncryptedPayload && isPlaceholderContent(message.content);
};

export const scrubMessagesForLocalState = (
  messages: Message[],
  blockedUsers: Set<string>,
): Message[] => {
  // Unreadable encrypted messages are dropped rather than shown as placeholders.
  return messages.filter(
    (message) =>
      !isBlockedAuthor(message, blockedUsers) &&
      !isEncryptedMessageWithoutReadableContent(message),
  );
};

export const filterBlockedAuthors = (
  messages: Message[],
  blockedUsers: Set<string>,
): Message[] => messages.filter((msg) => !isBlockedAuthor(msg, blockedUsers));

export const messageIdentity = (
  message: Pick<Message, 'id' | 'timestamp'>,
): string => {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  const msg = message as Message;
  const userId = msg.userId || 'unknown';
  const replyTo = msg.replyTo ?? 'none';
  const content = (msg.content || '').slice(0, 48);
  return `ts:${message.timestamp}:u:${userId}:r:${replyTo}:c:${content}`;
};

export const resolveEncryptedPayloadForUser = (
  msg: Message,
  userId: string | undefined,
): string | null => {
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
};

export const sortByTimestamp = (messages: Message[]): Message[] =>
  messages.sort((a, b) => a.timestamp - b.timestamp);

/** Incoming messages replace existing ones with the same identity. */
export const upsertByIdentity = (
  existing: Message[],
  incoming: Message[],
): Message[] => {
  const byIdentity = new Map(
    existing.map((message) => [messageIdentity(message), message]),
  );
  for (const message of incoming) {
    byIdentity.set(messageIdentity(message), message);
  }
  return sortByTimestamp(Array.from(byIdentity.values()));
};

/** Existing messages win; only unseen extras are appended. */
export const appendMissingByIdentity = (
  existing: Message[],
  extra: Message[],
): Message[] => {
  const existingIds = new Set(existing.map((m) => messageIdentity(m)));
  return sortByTimestamp([
    ...existing,
    ...extra.filter((m) => !existingIds.has(messageIdentity(m))),
  ]);
};

/** Mutates matching existing messages in place, keeping their replyTo when incoming lacks one. */
export const upsertPreservingReplyTo = (
  existing: Message[],
  incoming: Message[],
): Message[] => {
  const existingMap = new Map(existing.map((m) => [messageIdentity(m), m]));
  for (const message of incoming) {
    const key = messageIdentity(message);
    const current = existingMap.get(key);
    if (current) {
      Object.assign(current, message, {
        replyTo:
          message.replyTo !== undefined ? message.replyTo : current.replyTo,
      });
    } else {
      existingMap.set(key, message);
    }
  }
  return Array.from(existingMap.values());
};

export const decryptIncomingMessage = async (
  rawMsg: Message,
  keys: StoredKeys,
  userId: string,
  options: { normalizeDecrypted: boolean },
): Promise<Message> => {
  const msg = ensureMessageId(rawMsg);
  const encrypted = resolveEncryptedPayloadForUser(msg, userId);
  if (!encrypted || !keys) {
    return ensureMessageId(normalizeMessageState(msg));
  }
  try {
    const decrypted = await decryptMessageForUser(encrypted, keys.privateKey);
    const withContent = { ...msg, content: decrypted };
    return ensureMessageId(
      options.normalizeDecrypted
        ? normalizeMessageState(withContent)
        : withContent,
    );
  } catch (error) {
    console.error('[Socket] ✗ Failed to decrypt message:', error);
    return ensureMessageId(normalizeMessageState(msg));
  }
};
