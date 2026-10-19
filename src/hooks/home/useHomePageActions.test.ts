import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomePageState } from '../../contexts/home/homePageTypes';
import { SOCKET_EVENTS } from '../../constants';
import { useHomePageActions } from './useHomePageActions';

const mocks = vi.hoisted(() => ({
  loadKeysAsync: vi.fn(),
  loadUserPublicKeyEntries: vi.fn(),
  filterPubKeysForEncryption: vi.fn(),
  encryptForAllUsers: vi.fn(),
  getUserIdByUsername: vi.fn(),
  requireUserIdByUsername: vi.fn(),
  emitSignedMutation: vi.fn(),
}));

vi.mock('../../utils/gpg', () => ({
  ...mocks,
  decryptSharedAccountPackageForRecipient: vi.fn(),
  encryptSharedAccountPackageForRecipient: vi.fn(),
  importSharedAccountPackage: vi.fn(),
  loadStoredKeyMetadataForUser: vi.fn(),
  redirectToLogout: vi.fn(),
  unlockStoredPrivateKeyForUser: vi.fn(),
}));
vi.mock('../../utils/identityMap', () => ({
  getUserIdByUsername: mocks.getUserIdByUsername,
  requireUserIdByUsername: mocks.requireUserIdByUsername,
  getUsernameByUserId: vi.fn(),
  requireRoomIdByName: vi.fn(),
}));
vi.mock('../../utils/socketAuth', () => ({
  emitSignedMutation: mocks.emitSignedMutation,
}));
vi.mock('../../utils/homeActions', () => ({
  doSendAction: vi.fn(),
  grantAccessAction: vi.fn(),
  requestAccessAction: vi.fn(),
  selectVersionAction: vi.fn(),
}));

describe('useHomePageActions makeNewRoom', () => {
  const keys = {
    userId: 'authoritative-user',
    sessionId: 'stored-session',
    privateKey: 'private-key',
    publicKey: 'public-key',
  };
  let state: HomePageState;
  let socket: { connected: boolean; emit: ReturnType<typeof vi.fn> };
  let alertMock: ReturnType<typeof vi.fn>;
  let digestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    socket = { connected: true, emit: vi.fn() };
    state = {
      username: 'alice',
      authToken: 'active-session',
      newRoomName: '  New Room  ',
      roomList: ['general'],
      blockedUsers: ['blocked-user'],
      getSocket: vi.fn(() => socket),
      setNewRoomName: vi.fn(),
    } as unknown as HomePageState;
    alertMock = vi.fn();
    digestMock = vi.fn().mockResolvedValue(new Uint8Array([1, 2]).buffer);
    vi.stubGlobal('alert', alertMock);
    vi.stubGlobal('crypto', { subtle: { digest: digestMock } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadKeysAsync.mockResolvedValue({ ...keys });
    mocks.getUserIdByUsername.mockReturnValue('mapped-user');
    mocks.loadUserPublicKeyEntries.mockReturnValue({});
    mocks.filterPubKeysForEncryption.mockReturnValue({});
    mocks.encryptForAllUsers.mockResolvedValue('encrypted-room-name');
    mocks.emitSignedMutation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const expectFailure = () => {
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toMatch(/please/i);
    expect(alertMock.mock.calls[0][0]).not.toMatch(
      /private|public|key|identity|encrypt|sign|socket|internal/i,
    );
    expect(state.setNewRoomName).not.toHaveBeenCalled();
    expect(mocks.requireUserIdByUsername).not.toHaveBeenCalled();
  };

  it.each(['absent', 'disconnected'])('reports an %s connection', async (kind) => {
    if (kind === 'absent') {
      state.getSocket = () => undefined;
    } else {
      socket.connected = false;
    }
    await useHomePageActions(state).makeNewRoom();
    expectFailure();
    expect(alertMock).toHaveBeenCalledWith(expect.stringMatching(/reconnect/i));
    expect(mocks.loadKeysAsync).not.toHaveBeenCalled();
    expect(mocks.emitSignedMutation).not.toHaveBeenCalled();
  });

  it.each(['empty name', 'duplicate name', 'missing username'])(
    'reports %s without submitting',
    async (kind) => {
      if (kind === 'empty name') state.newRoomName = '   ';
      if (kind === 'duplicate name') state.newRoomName = '  GENERAL  ';
      if (kind === 'missing username') state.username = '';
      await useHomePageActions(state).makeNewRoom();
      expectFailure();
      expect(mocks.loadKeysAsync).not.toHaveBeenCalled();
      expect(mocks.emitSignedMutation).not.toHaveBeenCalled();
    },
  );

  it.each(['keys', 'session', 'privateKey', 'publicKey', 'identity'])(
    'reports missing %s and preserves the draft',
    async (missing) => {
      const incompleteKeys = { ...keys };
      if (missing === 'session') {
        state.authToken = '';
        incompleteKeys.sessionId = '';
      } else if (missing === 'identity') {
        incompleteKeys.userId = '';
        mocks.getUserIdByUsername.mockReturnValue(undefined);
      } else if (missing === 'privateKey' || missing === 'publicKey') {
        incompleteKeys[missing] = '';
      }
      mocks.loadKeysAsync.mockResolvedValue(missing === 'keys' ? null : incompleteKeys);
      await useHomePageActions(state).makeNewRoom();
      expectFailure();
      expect(mocks.encryptForAllUsers).not.toHaveBeenCalled();
      expect(mocks.emitSignedMutation).not.toHaveBeenCalled();
    },
  );

  it.each(['key loading', 'identity lookup', 'public key loading', 'filtering', 'encryption', 'hashing', 'signing'])(
    'catches thrown %s errors with generic feedback',
    async (stage) => {
      const actions = useHomePageActions(state);
      const error = new Error('internal security details');
      if (stage === 'key loading') mocks.loadKeysAsync.mockRejectedValue(error);
      if (stage === 'identity lookup') {
        mocks.loadKeysAsync.mockResolvedValue({ ...keys, userId: '' });
        mocks.getUserIdByUsername.mockImplementation(() => { throw error; });
      }
      if (stage === 'public key loading') {
        mocks.loadUserPublicKeyEntries.mockImplementation(() => { throw error; });
      }
      if (stage === 'filtering') {
        mocks.filterPubKeysForEncryption.mockImplementation(() => { throw error; });
      }
      if (stage === 'encryption') mocks.encryptForAllUsers.mockRejectedValue(error);
      if (stage === 'hashing') digestMock.mockRejectedValue(error);
      if (stage === 'signing') mocks.emitSignedMutation.mockRejectedValue(error);
      await expect(actions.makeNewRoom()).resolves.toBeUndefined();
      expectFailure();
      if (stage !== 'signing') expect(mocks.emitSignedMutation).not.toHaveBeenCalled();
    },
  );

  it('preserves the draft if the connection drops during preparation', async () => {
    mocks.encryptForAllUsers.mockImplementation(async () => {
      socket.connected = false;
      return 'encrypted-room-name';
    });
    await useHomePageActions(state).makeNewRoom();
    expectFailure();
    expect(mocks.emitSignedMutation).not.toHaveBeenCalled();
  });

  it.each(['authoritative', 'existing mapping'])(
    'submits using the %s identity and clears only after submission',
    async (identity) => {
      state.authToken = '';
      if (identity === 'existing mapping') {
        mocks.loadKeysAsync.mockResolvedValue({ ...keys, userId: '' });
      }
      const actions = useHomePageActions(state);
      mocks.getUserIdByUsername.mockClear();
      mocks.emitSignedMutation.mockImplementation(async () => {
        expect(state.setNewRoomName).not.toHaveBeenCalled();
      });
      await actions.makeNewRoom();
      const userId = identity === 'authoritative' ? keys.userId : 'mapped-user';
      expect(mocks.emitSignedMutation).toHaveBeenCalledWith(socket, {
        event: SOCKET_EVENTS.CLIENT_NEW_ROOM,
        payload: {
          roomNameCiphertext: 'encrypted-room-name',
          roomNameHash: '0102',
          roomDirectoryUpdatedAt: expect.any(Number),
          userId,
          sessionId: keys.sessionId,
        },
        userId,
        sessionId: keys.sessionId,
        claims: {
          roomNameCiphertext: 'encrypted-room-name',
          roomNameHash: '0102',
          roomDirectoryUpdatedAt: expect.any(String),
        },
      });
      expect(mocks.encryptForAllUsers).toHaveBeenCalledWith('New Room', {}, keys.publicKey);
      expect(mocks.filterPubKeysForEncryption).toHaveBeenCalledWith({}, {
        blockedUsers: state.blockedUsers,
      });
      if (identity === 'authoritative') {
        expect(mocks.getUserIdByUsername).not.toHaveBeenCalled();
      }
      expect(mocks.requireUserIdByUsername).not.toHaveBeenCalled();
      expect(state.setNewRoomName).toHaveBeenCalledExactlyOnceWith('');
      expect(alertMock).not.toHaveBeenCalled();
    },
  );
});