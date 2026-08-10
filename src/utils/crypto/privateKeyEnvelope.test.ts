import { describe, expect, it } from 'vitest';
import {
  decryptPrivateKeyWithPassword,
  encryptPrivateKeyWithPassword,
  isEncryptedPrivateKeyEnvelope,
} from './privateKeyEnvelope';

describe('privateKeyEnvelope', () => {
  it('encrypts and decrypts private keys with password', async () => {
    const privateKey =
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----';
    const password = 'StrongPass1!';

    const encrypted = await encryptPrivateKeyWithPassword(privateKey, password);
    expect(isEncryptedPrivateKeyEnvelope(encrypted)).toBe(true);
    expect(encrypted).not.toContain(privateKey);

    const decrypted = await decryptPrivateKeyWithPassword(encrypted, password);
    expect(decrypted).toBe(privateKey);
  });

  it('rejects invalid envelope payloads', async () => {
    await expect(
      decryptPrivateKeyWithPassword('not-json', 'StrongPass1!'),
    ).rejects.toThrow('Stored private key is not in encrypted format');

    expect(isEncryptedPrivateKeyEnvelope('')).toBe(false);
    expect(isEncryptedPrivateKeyEnvelope('{"foo":"bar"}')).toBe(false);
    expect(isEncryptedPrivateKeyEnvelope('{broken-json')).toBe(false);
  });

  it('fails decryption with a wrong password', async () => {
    const encrypted = await encryptPrivateKeyWithPassword(
      'my-private-key',
      'StrongPass1!',
    );

    await expect(
      decryptPrivateKeyWithPassword(encrypted, 'WrongPass1!'),
    ).rejects.toThrow();
  });

  it('fails encryption when crypto random source is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        subtle: originalCrypto.subtle,
      },
      configurable: true,
    });

    await expect(
      encryptPrivateKeyWithPassword('my-private-key', 'StrongPass1!'),
    ).rejects.toThrow('Web Crypto random source unavailable');

    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
    });
  });
});
