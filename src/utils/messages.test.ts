import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../types/types';
import { storeIdentityDirectories } from './identityMap';
import { blockUser } from './userSettings';
import { canUserViewMessage, getUtf8ByteLength } from './messages';

describe('messages utils', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns the utf8 byte length for simple strings', () => {
    expect(getUtf8ByteLength('hi')).toBe(2);
    expect(getUtf8ByteLength('π')).toBeGreaterThan(0);
  });

  it('allows unencrypted content to be viewed by default', () => {
    const message: Message = {
      id: '1',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'plain text',
      timestamp: Date.now(),
    };

    expect(canUserViewMessage(message)).toBe(true);
    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('blocks messages from authors that are blocked for the viewer', () => {
    blockUser('alice');

    const message: Message = {
      id: '2',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'secret',
      timestamp: Date.now(),
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(false);
  });

  it('allows messages that are explicitly encrypted for the viewer', () => {
    const message: Message = {
      id: '3',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'hidden',
      timestamp: Date.now(),
      encryptedFor: { viewer: 'ciphertext' },
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('allows versions that are encrypted for the viewer', () => {
    const message: Message = {
      id: '4',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'old',
      timestamp: Date.now(),
      versions: [
        {
          version: 2,
          timestamp: Date.now(),
          encryptedMessage: 'ciphertext',
        },
      ],
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('returns true when encrypted payloads are present and accessible', () => {
    const message: Message = {
      id: '5',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'hidden',
      timestamp: Date.now(),
      encryptedMessage: 'ciphertext',
    };

    expect(canUserViewMessage(message, 'other-viewer')).toBe(true);
  });

  it('returns true when a version is encrypted for the current viewer', () => {
    const message: Message = {
      id: '6',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'old',
      timestamp: Date.now(),
      versions: [
        {
          version: 2,
          timestamp: Date.now(),
          encryptedFor: { viewer: 'ciphertext' },
        },
      ],
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('allows content to be viewed when the viewer has a current user id and the content is unencrypted', () => {
    storeIdentityDirectories({ currentUserId: 'viewer-id' });

    const message: Message = {
      id: '6b',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'plain text',
      timestamp: Date.now(),
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('returns true for messages that are encrypted for the current viewer id', () => {
    storeIdentityDirectories({ currentUserId: 'viewer-id' });

    const message: Message = {
      id: '6c',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'hidden',
      timestamp: Date.now(),
      encryptedFor: { 'viewer-id': 'ciphertext' },
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('returns true for messages that carry an encrypted payload', () => {
    storeIdentityDirectories({ currentUserId: 'viewer-id' });

    const message: Message = {
      id: '6d',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'hidden',
      timestamp: Date.now(),
      encryptedMessage: 'ciphertext',
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('returns true for encrypted versions when the viewer is not blocked', () => {
    const message: Message = {
      id: '7',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'old',
      timestamp: Date.now(),
      versions: [
        {
          version: 2,
          timestamp: Date.now(),
          encryptedFor: { other: 'ciphertext' },
        },
      ],
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });

  it('returns true when there is no viewer username and no viewer id', () => {
    const message: Message = {
      id: '8',
      username: 'alice',
      userId: 'alice-id',
      roomId: 'general-id',
      content: 'plain text',
      timestamp: Date.now(),
    };

    expect(canUserViewMessage(message)).toBe(true);
  });

  it('returns false for system messages that are blocked', () => {
    const message: Message = {
      id: '9',
      username: 'alice',
      content: 'blocked',
      roomId: 'general-id',
      timestamp: Date.now(),
      userId: 'system',
    };

    expect(canUserViewMessage(message, 'viewer')).toBe(true);
  });
});
