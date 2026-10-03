import type { Message } from '../types/types';
import { getCurrentUserId, getUsernameByUserId } from './identityMap';
import { isUserBlocked } from './userSettings';

export const getUtf8ByteLength = (value: string): number => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
};

export const isPlaceholderContent = (content: string | undefined): boolean => {
  const trimmed = content?.trim() ?? '';
  return (
    !trimmed ||
    trimmed.includes('🔒') ||
    trimmed.includes('[Encrypted message]')
  );
};

export const canUserViewMessage = (
  message: Message,
  viewerUsername?: string,
): boolean => {
  const viewerUserId = getCurrentUserId();
  const authorUsername =
    (message.userId ? getUsernameByUserId(message.userId) : undefined) ||
    message.username ||
    message.userId;

  if (!viewerUsername) {
    if (!viewerUserId) {
      return true;
    }
  }

  if (
    message.userId !== 'system' &&
    authorUsername &&
    isUserBlocked(authorUsername)
  ) {
    return false;
  }

  if (!isPlaceholderContent(message.content)) {
    return true;
  }

  if (viewerUserId && message.encryptedFor?.[viewerUserId]) {
    return true;
  }

  if (message.encryptedMessage) {
    return true;
  }

  if (message.versions?.length) {
    const newest = message.versions[0];
    if (newest.encryptedMessage) {
      return true;
    }
    if (viewerUserId && newest.encryptedFor?.[viewerUserId]) {
      return true;
    }
  }

  if (
    message.encryptedMessage ||
    message.encryptedFor ||
    message.versions?.length
  ) {
    return false;
  }

  return true;
};
