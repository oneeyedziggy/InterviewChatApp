import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllLocalUsers,
  importSharedAccountPackage,
  loadStoredKeyMetadataForUser,
  verifyDetachedTextSignature,
} from './gpg';
import { encryptPrivateKeyWithPassword } from './crypto/privateKeyEnvelope';

const openpgpMock = vi.hoisted(() => ({
  readKey: vi.fn(),
  readSignature: vi.fn(),
  createMessage: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('openpgp', () => openpgpMock);

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

describe('server signature verification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00Z'));
    openpgpMock.readKey.mockResolvedValue('public-key');
    openpgpMock.readSignature.mockResolvedValue('signature');
    openpgpMock.createMessage.mockResolvedValue('message');
    openpgpMock.verify.mockResolvedValue({
      signatures: [{ verified: Promise.resolve(true) }],
    });
  });

  it('verifies server signatures slightly ahead of the local clock', async () => {
    await verifyDetachedTextSignature(
      'payload',
      'signature-armored',
      'public-key-armored',
    );

    expect(openpgpMock.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        date: new Date('2026-08-11T12:05:00.000Z'),
      }),
    );
  });
});
