import { loadKeysAsync, verifyDetachedTextSignature } from '../gpg';
import { sha256Hex } from '../crypto/sha256';
import { SOCKET_EVENTS } from '../../constants';
import { asRecord } from './payloadGuards';

export type ServerSignatureEnvelope = {
  version?: string;
  event?: string;
  timestamp?: number;
  nonce?: string;
  payloadHash?: string;
  signature?: string;
};

export const SERVER_SIGNATURE_STRICT_STORAGE_KEY =
  'chat_server_signature_strict';

export const isServerSignatureStrictMode = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }

  const raw = localStorage.getItem(SERVER_SIGNATURE_STRICT_STORAGE_KEY);
  if (!raw) {
    return true;
  }

  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
};

const escapeGoJsonString = (value: string): string => {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
};

export const goJsonStringify = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return escapeGoJsonString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => goJsonStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries
      .map(
        ([key, nested]) =>
          `${escapeGoJsonString(key)}:${goJsonStringify(nested)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
};

export const buildServerSigningInput = (
  envelope: Required<ServerSignatureEnvelope>,
): string => {
  return [
    envelope.version,
    envelope.event,
    String(envelope.timestamp),
    envelope.nonce,
    envelope.payloadHash,
  ].join('|');
};

const normalizeEnvelope = (
  envelope: ServerSignatureEnvelope,
): Required<ServerSignatureEnvelope> => ({
  version:
    typeof envelope.version === 'string' && envelope.version.trim() !== ''
      ? envelope.version
      : 'v1',
  event: typeof envelope.event === 'string' ? envelope.event : '',
  timestamp: typeof envelope.timestamp === 'number' ? envelope.timestamp : 0,
  nonce: typeof envelope.nonce === 'string' ? envelope.nonce : '',
  payloadHash:
    typeof envelope.payloadHash === 'string' ? envelope.payloadHash : '',
  signature: typeof envelope.signature === 'string' ? envelope.signature : '',
});

export const verifyServerEventEnvelope = async (
  eventName: string,
  payload: unknown,
): Promise<boolean> => {
  const strict = isServerSignatureStrictMode();

  const payloadMap = asRecord(payload);
  if (!payloadMap) {
    console.warn('[Socket] Invalid signed payload shape for event:', eventName);
    return !strict;
  }

  const envelope = payloadMap.serverAuth as ServerSignatureEnvelope | undefined;
  if (!envelope || typeof envelope !== 'object') {
    console.warn('[Socket] Missing serverAuth envelope for event:', eventName);
    return !strict;
  }

  const normalizedEnvelope = normalizeEnvelope(envelope);
  if (
    normalizedEnvelope.event !== eventName ||
    normalizedEnvelope.timestamp <= 0 ||
    normalizedEnvelope.nonce === '' ||
    normalizedEnvelope.payloadHash === '' ||
    normalizedEnvelope.signature === ''
  ) {
    console.warn(
      '[Socket] Invalid serverAuth envelope fields for event:',
      eventName,
    );
    return !strict;
  }

  const keys = await loadKeysAsync();
  if (!keys?.serverPublicKey) {
    console.warn(
      '[Socket] Missing server public key for signature verification',
    );
    return !strict;
  }

  const signedPayload = { ...payloadMap };
  delete signedPayload.serverAuth;
  const goHash = await sha256Hex(goJsonStringify(signedPayload));
  if (goHash !== normalizedEnvelope.payloadHash) {
    console.warn('[Socket] Payload hash mismatch for event:', eventName);
    return !strict;
  }

  const verified = await verifyDetachedTextSignature(
    buildServerSigningInput(normalizedEnvelope),
    normalizedEnvelope.signature,
    keys.serverPublicKey,
  ).catch((error) => {
    console.error(
      '[Socket] Signature verification error for event',
      eventName,
      error,
    );
    return false;
  });

  if (!verified) {
    console.warn('[Socket] Invalid server signature for event:', eventName);
    return !strict;
  }

  return true;
};

const socketEventLabel = (eventName: string): string =>
  Object.entries(SOCKET_EVENTS).find(([, value]) => value === eventName)?.[0] ??
  eventName;

export const withVerifiedPayload =
  (eventName: string, handler: (data: any) => void | Promise<void>) =>
  async (data: any): Promise<void> => {
    if (!(await verifyServerEventEnvelope(eventName, data))) {
      console.error(
        `[Socket] Rejected unsigned or invalid ${socketEventLabel(eventName)} payload`,
      );
      return;
    }
    await handler(data);
  };
