import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../crypto/sha256';
import {
  buildServerSigningInput,
  goJsonStringify,
  isServerSignatureStrictMode,
  SERVER_SIGNATURE_STRICT_STORAGE_KEY,
  verifyServerEventEnvelope,
  withVerifiedPayload,
} from './serverSignature';

const gpgMocks = vi.hoisted(() => ({
  loadKeysAsync: vi.fn(),
  verifyDetachedTextSignature: vi.fn(),
}));

vi.mock('../gpg', () => gpgMocks);

const signedPayload = async (event: string, body: Record<string, unknown>) => {
  const payloadHash = await sha256Hex(goJsonStringify(body));
  return {
    ...body,
    serverAuth: {
      version: 'v1',
      event,
      timestamp: 123,
      nonce: 'n',
      payloadHash,
      signature: 'sig',
    },
  };
};

describe('goJsonStringify', () => {
  it('escapes HTML-sensitive characters like Go encoding/json', () => {
    expect(goJsonStringify({ a: '<b>&', n: 1, z: null })).toBe(
      '{"a":"\\u003cb\\u003e\\u0026","n":1,"z":null}',
    );
  });

  it('preserves key order and serializes arrays', () => {
    expect(goJsonStringify({ b: [1, 'x'], a: true })).toBe(
      '{"b":[1,"x"],"a":true}',
    );
  });
});

describe('buildServerSigningInput', () => {
  it('joins envelope fields with pipes', () => {
    expect(
      buildServerSigningInput({
        version: 'v1',
        event: 'e',
        timestamp: 5,
        nonce: 'n',
        payloadHash: 'h',
        signature: 's',
      }),
    ).toBe('v1|e|5|n|h');
  });
});

describe('isServerSignatureStrictMode', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to strict', () => {
    expect(isServerSignatureStrictMode()).toBe(true);
  });

  it.each(['0', 'false', 'OFF'])('is disabled by %s', (value) => {
    localStorage.setItem(SERVER_SIGNATURE_STRICT_STORAGE_KEY, value);
    expect(isServerSignatureStrictMode()).toBe(false);
  });
});

describe('verifyServerEventEnvelope', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gpgMocks.loadKeysAsync.mockResolvedValue({ serverPublicKey: 'server-key' });
    gpgMocks.verifyDetachedTextSignature.mockResolvedValue(true);
  });

  it('rejects payloads without an envelope in strict mode', async () => {
    expect(await verifyServerEventEnvelope('initialData', { a: 1 })).toBe(
      false,
    );
  });

  it('allows payloads without an envelope when strict mode is off', async () => {
    localStorage.setItem(SERVER_SIGNATURE_STRICT_STORAGE_KEY, 'false');
    expect(await verifyServerEventEnvelope('initialData', { a: 1 })).toBe(true);
  });

  it('accepts a valid signed payload', async () => {
    const payload = await signedPayload('initialData', { a: '<x>' });
    expect(await verifyServerEventEnvelope('initialData', payload)).toBe(true);
    expect(gpgMocks.verifyDetachedTextSignature).toHaveBeenCalledWith(
      `v1|initialData|123|n|${payload.serverAuth.payloadHash}`,
      'sig',
      'server-key',
    );
  });

  it('rejects a tampered payload', async () => {
    const payload = await signedPayload('initialData', { a: 1 });
    expect(
      await verifyServerEventEnvelope('initialData', { ...payload, a: 2 }),
    ).toBe(false);
  });

  it('rejects an envelope signed for a different event', async () => {
    const payload = await signedPayload('serverMessage', { a: 1 });
    expect(await verifyServerEventEnvelope('initialData', payload)).toBe(false);
  });

  it('rejects an invalid signature', async () => {
    gpgMocks.verifyDetachedTextSignature.mockResolvedValue(false);
    const payload = await signedPayload('initialData', { a: 1 });
    expect(await verifyServerEventEnvelope('initialData', payload)).toBe(false);
  });

  it('withVerifiedPayload only invokes the handler for verified payloads', async () => {
    const handler = vi.fn();
    const wrapped = withVerifiedPayload('initialData', handler);
    await wrapped({ a: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[Socket] Rejected unsigned or invalid INITIAL_DATA payload',
    );

    const payload = await signedPayload('initialData', { a: 1 });
    await wrapped(payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });
});
