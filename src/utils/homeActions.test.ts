import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestAccessAction, selectVersionAction } from './homeActions';

const emitSignedMutation = vi.fn();
const loadKeys = vi.fn();
const decryptMessageForUser = vi.fn();
const requireUserIdByUsername = vi.fn();
const requireRoomIdByName = vi.fn();

vi.mock('../utils/socketAuth', () => ({
  emitSignedMutation,
}));

vi.mock('../utils/gpg', () => ({
  loadKeys,
  decryptMessageForUser,
  encryptForAllUsers: vi.fn(),
  filterPubKeysForEncryption: vi.fn(),
  loadUserPublicKeyEntries: vi.fn(),
}));

vi.mock('../utils/identityMap', () => ({
  requireUserIdByUsername,
  requireRoomIdByName,
  getUsernameByUserId: vi.fn(),
}));

describe('homeActions userId contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadKeys.mockReturnValue({
      sessionId: 'session-1',
      username: 'alice',
      privateKey: 'private-key',
      publicKey: 'public-key',
    });
    requireUserIdByUsername.mockImplementation((username: string) => {
      if (username === 'alice') return 'user-alice';
      return `user-${username}`;
    });
    requireRoomIdByName.mockImplementation((room: string) => `room:${room}`);
  });

  it('requestAccessAction signs request using message sender userId', () => {
    const socket = {} as any;

    requestAccessAction({
      socket,
      username: 'alice',
      chatValues: {
        '#general': [
          {
            id: 'm1',
            timestamp: 100,
            userId: 'user-bob',
            roomId: 'room:#general',
            content: 'hello',
          },
        ],
      },
      messageUserId: 'user-bob',
      room: '#general',
      messageTimestamp: 100,
    });

    expect(emitSignedMutation).toHaveBeenCalledTimes(1);
    const call = emitSignedMutation.mock.calls[0][1];
    expect(call.event).toBe('clientRequestAccess');
    expect(call.payload.requestAccess.originalSenderId).toBe('user-bob');
    expect(call.claims['requestAccess.originalSenderId']).toBe('user-bob');
    expect(call.payload.userId).toBe('user-alice');
  });

  it('selectVersionAction decrypts using current viewer userId key', async () => {
    let state: any = {
      '#general': [
        {
          id: 'm1',
          timestamp: 100,
          userId: 'user-bob',
          roomId: 'room:#general',
          content: '[Encrypted message]',
          versions: [
            {
              version: 1,
              timestamp: 100,
              encryptedFor: {
                'user-alice': 'ciphertext-for-alice',
              },
            },
          ],
          currentVersion: 0,
        },
      ],
    };

    const setChatValues = vi.fn((updater: any) => {
      state = updater(state);
      return state;
    });

    decryptMessageForUser.mockResolvedValue('decrypted-content');

    await selectVersionAction({
      socket: {} as any,
      username: 'alice',
      chatValues: state,
      setChatValues,
      room: '#general',
      messageTimestamp: 100,
      versionIndex: 0,
    });

    expect(decryptMessageForUser).toHaveBeenCalledWith(
      'ciphertext-for-alice',
      'private-key',
    );
    expect(state['#general'][0].content).toBe('decrypted-content');
  });
});
