import type { Message } from '../types/types';
import { isUserBlocked } from './userSettings';

export function canUserViewMessage(message: Message, viewerUsername?: string): boolean {
  if (!viewerUsername) {
    return true;
  }

  if (message.username !== 'system' && isUserBlocked(message.username)) {
    return false;
  }

  const content = message.content?.trim() ?? '';
  if (
    content &&
    !content.includes('🔒') &&
    !content.includes('[Encrypted message]')
  ) {
    return true;
  }

  if (message.encryptedFor?.[viewerUsername]) {
    return true;
  }

  if (message.versions?.length) {
    const newest = message.versions[0];
    if (newest.encryptedFor?.[viewerUsername]) {
      return true;
    }
  }

  if (message.encryptedFor || message.versions?.length) {
    return false;
  }

  return true;
}
