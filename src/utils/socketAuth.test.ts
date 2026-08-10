import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gpgMock = vi.hoisted(() => ({
  loadKeysAsync: vi.fn(),
  signDetachedText: vi.fn(),
}));

vi.mock('./gpg', () => gpgMock);

import { buildSignedMutationAuth, emitSignedMutation } from './socketAuth';

describe('socketAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gpgMock.loadKeysAsync.mockReset();
    gpgMock.signDetachedText.mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'nonce-id') });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a signed auth payload with normalized claims', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({ privateKey: 'private-key' });
    gpgMock.signDetachedText.mockResolvedValue('signature-value');

    const auth = await buildSignedMutationAuth({
      event: 'clientMessage',
      userId: 'user-a',
      sessionId: 'session-a',
      claims: {
        b: true,
        a: 42,
        c: { nested: 'value' },
      },
    });

    expect(auth).toEqual({
      version: 'v1',
      event: 'clientMessage',
      userId: 'user-a',
      sessionId: 'session-a',
      timestamp: 1234567890,
      nonce: 'nonce-id',
      claims: {
        a: '42',
        b: 'true',
        c: JSON.stringify({ nested: 'value' }),
      },
      signature: 'signature-value',
    });
    expect(gpgMock.signDetachedText).toHaveBeenCalledWith(
      'v1|clientMessage|user-a|session-a|1234567890|nonce-id|a=NDI&b=dHJ1ZQ&c=eyJuZXN0ZWQiOiJ2YWx1ZSJ9',
      'private-key',
    );
  });

  it('throws when private key is missing', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue(null);

    await expect(
      buildSignedMutationAuth({
        event: 'clientMessage',
        userId: 'user-a',
        sessionId: 'session-a',
        claims: {},
      }),
    ).rejects.toThrow('Missing private key for signed mutation auth');
  });

  it('emits signed payloads through the socket', async () => {
    gpgMock.loadKeysAsync.mockResolvedValue({ privateKey: 'private-key' });
    gpgMock.signDetachedText.mockResolvedValue('signature-value');

    const emit = vi.fn();
    await emitSignedMutation(
      { emit },
      {
        event: 'clientMessage',
        payload: { room: 'general' },
        userId: 'user-a',
        sessionId: 'session-a',
        claims: { roomId: 'room-a' },
      },
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe('clientMessage');
    expect(emit.mock.calls[0][1]).toMatchObject({
      room: 'general',
      auth: expect.objectContaining({ signature: 'signature-value' }),
    });
  });

  it('rejects when the socket is unavailable', async () => {
    await expect(
      emitSignedMutation(undefined, {
        event: 'clientMessage',
        payload: {},
        userId: 'user-a',
        sessionId: 'session-a',
        claims: {},
      }),
    ).rejects.toThrow('Socket unavailable');
  });
});
