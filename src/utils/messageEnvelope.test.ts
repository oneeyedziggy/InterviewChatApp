// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decryptMessageForUser,
  encryptForAllUsers,
  generateKeyPair,
} from './gpg';

describe('asymmetric message envelopes', () => {
  it('encrypts the body once and decrypts for the intended recipient', async () => {
    const sender = await generateKeyPair('sender');
    const recipient = await generateKeyPair('recipient');

    const envelope = await encryptForAllUsers(
      'private room message',
      { recipient: recipient.publicKey },
      sender.publicKey,
      'sender',
    );

    expect(JSON.parse(envelope)).toMatchObject({ version: 'msg-v2' });
    await expect(
      decryptMessageForUser(envelope, recipient.privateKey),
    ).resolves.toBe('private room message');
    await expect(
      decryptMessageForUser(envelope, sender.privateKey),
    ).resolves.toBe('private room message');
  });
});
