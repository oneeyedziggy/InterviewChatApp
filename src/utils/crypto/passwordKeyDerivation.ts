import { scryptAsync } from '@noble/hashes/scrypt';

export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_DK_LEN = 32;

function toPlainUint8Array(input: Uint8Array): Uint8Array {
  return new Uint8Array(
    input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength),
  );
}

export async function deriveAes256KeyFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const passwordBytes = toPlainUint8Array(new TextEncoder().encode(password));
  const saltBytes = toPlainUint8Array(salt);
  const keyBytes = await scryptAsync(passwordBytes, saltBytes, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DK_LEN,
  });

  return crypto.subtle.importKey(
    'raw',
    toPlainUint8Array(keyBytes),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
