import { describe, expect, it, vi } from 'vitest';
import { type Message } from '../../types/types';
import {
  appendMissingByIdentity,
  decryptIncomingMessage,
  ensureMessageId,
  messageIdentity,
  normalizeMessageState,
  resolveEncryptedPayloadForUser,
  scrubMessagesForLocalState,
  upsertByIdentity,
  upsertPreservingReplyTo,
} from './messageState';

vi.mock('../identityMap', () => ({
  getUsernameByUserId: (id: string) =>
    ({ 'u-blocked': 'blocked', 'u-alice': 'alice' })[id],
  getCurrentUserId: () => 'u-alice',
}));

const gpgMocks = vi.hoisted(() => ({ decryptMessageForUser: vi.fn() }));
vi.mock('../gpg', () => gpgMocks);

const msg = (overrides: Partial<Message>): Message =>
  ({
    timestamp: 1,
    username: 'alice',
    userId: 'u-alice',
    content: 'hi',
    ...overrides,
  }) as Message;

describe('ensureMessageId', () => {
  it('is deterministic for id-less messages', () => {
    const raw = msg({ roomId: 'r1', timestamp: 42 });
    expect(ensureMessageId(raw).id).toBe('legacy:r1:42:u-alice');
    expect(ensureMessageId(raw).id).toBe(ensureMessageId({ ...raw }).id);
  });

  it('keeps existing ids', () => {
    const withId = msg({ id: 'abc' });
    expect(ensureMessageId(withId)).toBe(withId);
  });
});

describe('messageIdentity', () => {
  it('prefers id and falls back to a composite key', () => {
    expect(messageIdentity(msg({ id: 'x' }))).toBe('id:x');
    expect(messageIdentity(msg({ timestamp: 3 }))).toBe(
      'ts:3:u:u-alice:r:none:c:hi',
    );
  });
});

describe('normalizeMessageState', () => {
  it('strips payload from deleted messages', () => {
    const normalized = normalizeMessageState(
      msg({ deleted: true, encryptedFor: { a: 'x' }, edited: true }),
    );
    expect(normalized).toMatchObject({
      content: 'Message deleted',
      deleted: true,
      encryptedFor: undefined,
      edited: false,
    });
  });
});

describe('scrubMessagesForLocalState', () => {
  it('drops blocked authors and unreadable encrypted messages', () => {
    const kept = msg({ id: 'keep' });
    const result = scrubMessagesForLocalState(
      [
        kept,
        msg({ id: 'blocked', userId: 'u-blocked' }),
        msg({ id: 'locked', content: '🔒', encryptedMessage: 'x' }),
      ],
      new Set(['blocked']),
    );
    expect(result).toEqual([kept]);
  });
});

describe('resolveEncryptedPayloadForUser', () => {
  it('prefers shared ciphertext, then newest version, then per-user entry', () => {
    expect(
      resolveEncryptedPayloadForUser(msg({ encryptedMessage: 'shared' }), 'u'),
    ).toBe('shared');
    expect(
      resolveEncryptedPayloadForUser(
        msg({
          versions: [{ encryptedFor: { u: 'v0' } } as never],
          encryptedFor: { u: 'old' },
        }),
        'u',
      ),
    ).toBe('v0');
    expect(
      resolveEncryptedPayloadForUser(msg({ encryptedFor: { u: 'mine' } }), 'u'),
    ).toBe('mine');
    expect(resolveEncryptedPayloadForUser(msg({}), undefined)).toBeNull();
  });
});

describe('merge helpers', () => {
  it('upsertByIdentity lets incoming win and sorts', () => {
    const merged = upsertByIdentity(
      [msg({ id: 'a', timestamp: 2, content: 'old' })],
      [
        msg({ id: 'a', timestamp: 2, content: 'new' }),
        msg({ id: 'b', timestamp: 1 }),
      ],
    );
    expect(merged.map((m) => [m.id, m.content])).toEqual([
      ['b', 'hi'],
      ['a', 'new'],
    ]);
  });

  it('appendMissingByIdentity keeps existing entries', () => {
    const merged = appendMissingByIdentity(
      [msg({ id: 'a', timestamp: 2, content: 'existing' })],
      [
        msg({ id: 'a', timestamp: 2, content: 'stale' }),
        msg({ id: 'b', timestamp: 1 }),
      ],
    );
    expect(merged.map((m) => [m.id, m.content])).toEqual([
      ['b', 'hi'],
      ['a', 'existing'],
    ]);
  });

  it('upsertPreservingReplyTo keeps replyTo when incoming lacks it', () => {
    const existing = msg({ id: 'a', replyTo: 7, content: 'old' });
    const merged = upsertPreservingReplyTo(
      [existing],
      [msg({ id: 'a', content: 'new' }), msg({ id: 'b', timestamp: 9 })],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(existing);
    expect(existing).toMatchObject({ content: 'new', replyTo: 7 });
  });
});

describe('decryptIncomingMessage', () => {
  const keys = { privateKey: 'pk' } as never;

  it('decrypts and optionally normalizes', async () => {
    gpgMocks.decryptMessageForUser.mockResolvedValue('Message deleted');
    const raw = msg({ id: 'a', encryptedFor: { 'u-alice': 'c' } });
    const normalized = await decryptIncomingMessage(raw, keys, 'u-alice', {
      normalizeDecrypted: true,
    });
    expect(normalized.deleted).toBe(true);

    const raw2 = msg({ id: 'b', encryptedFor: { 'u-alice': 'c' } });
    const plain = await decryptIncomingMessage(raw2, keys, 'u-alice', {
      normalizeDecrypted: false,
    });
    expect(plain.deleted).toBeUndefined();
    expect(plain.content).toBe('Message deleted');
  });

  it('returns the original message when decryption fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gpgMocks.decryptMessageForUser.mockRejectedValue(new Error('nope'));
    const raw = msg({ roomId: 'r', encryptedMessage: 'c', content: '🔒' });
    const result = await decryptIncomingMessage(raw, keys, 'u-alice', {
      normalizeDecrypted: true,
    });
    expect(result.content).toBe('🔒');
    expect(result.id).toBe('legacy:r:1:u-alice');
  });
});
