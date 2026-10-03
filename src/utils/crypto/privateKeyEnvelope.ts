import {
  deriveAes256KeyFromPassword,
  SCRYPT_DK_LEN,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
} from './passwordKeyDerivation';
import { base64ToBytes, bytesToBase64 } from './base64';

export const PRIVATE_KEY_ENVELOPE_VERSION = 'enc-v1';
export const PRIVATE_KEY_ALGORITHM = 'AES-256-GCM';
export const PRIVATE_KEY_KDF = 'scrypt';
export const PRIVATE_KEY_SALT_BYTES = 16;
export const PRIVATE_KEY_IV_BYTES = 12;

export type EncryptedPrivateKeyEnvelope = {
  version: typeof PRIVATE_KEY_ENVELOPE_VERSION;
  algorithm: typeof PRIVATE_KEY_ALGORITHM;
  kdf: typeof PRIVATE_KEY_KDF;
  N: number;
  r: number;
  p: number;
  dkLen: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

const randomBytes = (length: number): Uint8Array => {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Web Crypto random source unavailable');
  }

  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
};

export const isEncryptedPrivateKeyEnvelope = (value: string): boolean => {
  if (!value || value[0] !== '{') {
    return false;
  }

  try {
    const parsed = JSON.parse(value) as Partial<EncryptedPrivateKeyEnvelope>;
    return (
      parsed.version === PRIVATE_KEY_ENVELOPE_VERSION &&
      parsed.algorithm === PRIVATE_KEY_ALGORITHM &&
      parsed.kdf === PRIVATE_KEY_KDF &&
      typeof parsed.salt === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ciphertext === 'string'
    );
  } catch {
    return false;
  }
};

export const encryptPrivateKeyWithPassword = async (
  privateKeyArmored: string,
  password: string,
): Promise<string> => {
  const salt = randomBytes(PRIVATE_KEY_SALT_BYTES);
  const iv = randomBytes(PRIVATE_KEY_IV_BYTES);
  const key = await deriveAes256KeyFromPassword(password, salt);
  const plaintextBytes = new TextEncoder().encode(privateKeyArmored);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(iv) },
    key,
    plaintextBytes,
  );

  const envelope: EncryptedPrivateKeyEnvelope = {
    version: PRIVATE_KEY_ENVELOPE_VERSION,
    algorithm: PRIVATE_KEY_ALGORITHM,
    kdf: PRIVATE_KEY_KDF,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DK_LEN,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };

  return JSON.stringify(envelope);
};

export const decryptPrivateKeyWithPassword = async (
  encryptedPayload: string,
  password: string,
): Promise<string> => {
  if (!isEncryptedPrivateKeyEnvelope(encryptedPayload)) {
    throw new Error('Stored private key is not in encrypted format');
  }

  const envelope = JSON.parse(encryptedPayload) as EncryptedPrivateKeyEnvelope;
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const key = await deriveAes256KeyFromPassword(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(iv) },
    key,
    Uint8Array.from(ciphertext),
  );

  return new TextDecoder().decode(plaintext);
};
