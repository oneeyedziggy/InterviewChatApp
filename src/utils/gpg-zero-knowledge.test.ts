import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import {
  buildOpaqueUsernameEnvelope,
  decryptMessageForUser,
  encryptForAllUsers,
} from './gpg';

const generateKeyPair = async (name: string) =>
  openpgp.generateKey({
    type: 'rsa',
    rsaBits: 1024,
    userIDs: [{ name, email: `${name}@example.test` }],
  });

describe('zero-knowledge content encryption', () => {
  it('encrypts the username for the owner, not the server', async () => {
    const [owner, server] = await Promise.all([
      generateKeyPair('owner'),
      generateKeyPair('server'),
    ]);

    const envelope = await buildOpaqueUsernameEnvelope(
      'private-owner-name',
      owner.publicKey,
    );

    await expect(
      decryptMessageForUser(envelope.usernameCiphertext, owner.privateKey),
    ).resolves.toBe('private-owner-name');
    await expect(
      decryptMessageForUser(envelope.usernameCiphertext, server.privateKey, {
        suppressErrorLog: true,
      }),
    ).rejects.toThrow();
  }, 30000);

  it('does not place plaintext usernames in key envelope metadata', async () => {
    const owner = await generateKeyPair('owner');
    const recipient = await generateKeyPair('recipient');
    const username = 'private-owner-name';

    const encrypted = await encryptForAllUsers(
      'private message',
      { [username]: recipient.publicKey },
      owner.publicKey,
    );
    const parsed = JSON.parse(encrypted) as {
      keyEnvelopes: Record<string, string>;
    };

    expect(Object.keys(parsed.keyEnvelopes)).not.toContain(username);
    await expect(
      decryptMessageForUser(encrypted, owner.privateKey),
    ).resolves.toBe('private message');
  }, 30000);
});
