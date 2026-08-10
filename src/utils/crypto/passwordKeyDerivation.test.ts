import { describe, expect, it } from 'vitest';
import { deriveAes256KeyFromPassword } from './passwordKeyDerivation';

describe('passwordKeyDerivation', () => {
  it('derives an AES-GCM CryptoKey that can encrypt/decrypt', async () => {
    const key = await deriveAes256KeyFromPassword(
      'StrongPass1!',
      new Uint8Array(16).fill(7),
    );

    expect(key.algorithm.name).toBe('AES-GCM');

    const iv = new Uint8Array(12).fill(3);
    const message = new TextEncoder().encode('secret');

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      message,
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted,
    );

    expect(new TextDecoder().decode(decrypted)).toBe('secret');
  });
});
