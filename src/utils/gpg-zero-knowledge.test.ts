// @vitest-environment node

import * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import { twoUserCrypto } from '../test-utils/twoUserCrypto';
import {
  buildOpaqueUsernameEnvelope,
  decryptSharedAccountPackageForRecipient,
  decryptMessageForUser,
  encryptForAllUsers,
  encryptSharedAccountPackageForRecipient,
} from './gpg';
import {
  decryptPrivateKeyWithPassword,
  encryptPrivateKeyWithPassword,
} from './crypto/privateKeyEnvelope';

const generateKeyPair = async (name: string) =>
  openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048,
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

describe('two independent users', () => {
  let keys: Awaited<ReturnType<typeof twoUserCrypto>>;

  beforeAll(async () => {
    keys = await twoUserCrypto();
  }, 30000);

  it('uses distinct identity fingerprints', async () => {
    const fingerprints = await Promise.all(
      Object.values(keys).map(async (pair) =>
        (
          await openpgp.readKey({ armoredKey: pair.publicKey })
        ).getFingerprint(),
      ),
    );
    expect(new Set(fingerprints).size).toBe(3);
  });

  it('transfers a password-protected account to the recipient without exposing it to the server', async () => {
    const password = 'local-transfer-test-password';
    const accountPackage = {
      username: 'Private transferred account',
      privateKey: await encryptPrivateKeyWithPassword(
        keys.alice.privateKey,
        password,
      ),
      publicKey: keys.alice.publicKey,
      serverPublicKey: keys.server.publicKey,
    };
    const encrypted = await encryptSharedAccountPackageForRecipient(
      accountPackage,
      keys.bob.publicKey,
    );
    expect(encrypted).not.toContain(accountPackage.username);
    expect(encrypted).not.toContain(keys.alice.privateKey);
    expect(encrypted).not.toContain(accountPackage.privateKey);
    const recovered = await decryptSharedAccountPackageForRecipient(
      encrypted,
      keys.bob.privateKey,
    );
    expect(recovered).toEqual(accountPackage);
    await expect(
      decryptPrivateKeyWithPassword(recovered.privateKey, password),
    ).resolves.toBe(keys.alice.privateKey);
    await expect(
      decryptMessageForUser(encrypted, keys.server.privateKey, {
        suppressErrorLog: true,
      }),
    ).rejects.toThrow();
  }, 30000);

  it.each([
    ['alice', 'Alice private username'],
    ['bob', 'Bob private username'],
    ['alice', 'Shared private room'],
    ['alice', 'Alice says hello to Bob'],
    ['bob', 'Bob replies to Alice'],
  ] as const)(
    'decrypts %s-authored %s for both users but not the server',
    async (sender, plaintext) => {
      const recipient = sender === 'alice' ? 'bob' : 'alice';
      const encrypted = await encryptForAllUsers(
        plaintext,
        { [recipient]: keys[recipient].publicKey },
        keys[sender].publicKey,
      );
      expect(encrypted).not.toContain(plaintext);
      for (const user of ['alice', 'bob'] as const) {
        await expect(
          decryptMessageForUser(encrypted, keys[user].privateKey),
        ).resolves.toBe(plaintext);
      }
      await expect(
        decryptMessageForUser(encrypted, keys.server.privateKey, {
          suppressErrorLog: true,
        }),
      ).rejects.toThrow();
    },
  );

  it('cannot decrypt until the peer is included in the recipients', async () => {
    const initial = await buildOpaqueUsernameEnvelope(
      'Alice private username',
      keys.alice.publicKey,
    );
    await expect(
      decryptMessageForUser(initial.usernameCiphertext, keys.bob.privateKey, {
        suppressErrorLog: true,
      }),
    ).rejects.toThrow();
    const refreshed = await encryptForAllUsers(
      'Alice private username',
      {
        'bob-id': keys.bob.publicKey,
      },
      keys.alice.publicKey,
    );
    await expect(
      decryptMessageForUser(refreshed, keys.bob.privateKey),
    ).resolves.toBe('Alice private username');
  });

  it('rejects a modified authenticated body for either recipient', async () => {
    const encrypted = await encryptForAllUsers(
      'Untampered message',
      {
        'bob-id': keys.bob.publicKey,
      },
      keys.alice.publicKey,
    );
    const envelope = JSON.parse(encrypted);
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    envelope.ciphertext = ciphertext.toString('base64');
    for (const user of ['alice', 'bob'] as const) {
      await expect(
        decryptMessageForUser(JSON.stringify(envelope), keys[user].privateKey, {
          suppressErrorLog: true,
        }),
      ).rejects.toThrow();
    }
  });
});
