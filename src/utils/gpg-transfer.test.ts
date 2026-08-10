import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAllLocalUsers,
  importSharedAccountPackage,
  loadStoredKeyMetadataForUser,
} from './gpg';
import { encryptPrivateKeyWithPassword } from './crypto/privateKeyEnvelope';

describe('shared account import', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores the encrypted private key envelope as a local login option', async () => {
    const encryptedPrivateKey = await encryptPrivateKeyWithPassword(
      'sender-private-key',
      'recipient-local-password',
    );

    importSharedAccountPackage('recipient', {
      username: 'sender',
      privateKey: encryptedPrivateKey,
      publicKey: 'sender-public-key',
      serverPublicKey: 'server-public-key',
    });

    expect(getAllLocalUsers()).toContain('sender');

    const metadata = loadStoredKeyMetadataForUser('sender');
    expect(metadata).toMatchObject({
      username: 'sender',
      publicKey: 'sender-public-key',
      serverPublicKey: 'server-public-key',
      privateKeyEncrypted: encryptedPrivateKey,
    });
  });
});