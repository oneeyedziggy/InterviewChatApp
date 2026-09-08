import { describe, expect, it, vi } from 'vitest';
import { useHomePageActions } from './useHomePageActions';

vi.mock('../../utils/identityMap', () => ({
  getUserIdByUsername: vi.fn(() => 'user-1'),
  getUsernameByUserId: vi.fn(() => 'alice'),
  requireRoomIdByName: vi.fn(() => 'room-1'),
  requireUserIdByUsername: vi.fn(() => 'user-1'),
}));

vi.mock('../../utils/gpg', () => ({
  decryptSharedAccountPackageForRecipient: vi.fn(),
  encryptForAllUsers: vi.fn(),
  encryptSharedAccountPackageForRecipient: vi.fn(),
  filterPubKeysForEncryption: vi.fn(),
  importSharedAccountPackage: vi.fn(),
  loadKeysAsync: vi.fn(async () => undefined),
  loadStoredKeyMetadataForUser: vi.fn(),
  loadUserPublicKeyEntries: vi.fn(),
  redirectToLogout: vi.fn(),
}));

vi.mock('../../utils/userSettings', () => ({
  blockUser: vi.fn(),
  getBlockedUserExportsForCurrentUser: vi.fn(() => []),
  getBlockedUsers: vi.fn(() => []),
  unblockUser: vi.fn(),
}));

vi.mock('../../utils/socketAuth', () => ({
  emitSignedMutation: vi.fn(),
}));

vi.mock('../../utils/inPageDialog', () => ({
  showInPageConfirm: vi.fn(),
}));

vi.mock('../../utils/messages', () => ({
  getUtf8ByteLength: vi.fn((value: string) => value.length),
}));

describe('useHomePageActions', () => {
  it('cancels reply or edit when Escape is pressed in the draft input', () => {
    const setReplyingToState = vi.fn();
    const setEditingMessageTimestampState = vi.fn();
    const setEditingMessageIdState = vi.fn();
    const setUserDraftMessageState = vi.fn();
    const preventDefault = vi.fn();

    const actions = useHomePageActions({
      authToken: '',
      username: 'alice',
      roomList: ['general'],
      leftRooms: new Set(),
      roomNotifications: {},
      hiddenDmUnreadBaseline: {},
      currentRoom: 'general',
      chatValues: { general: [] },
      blockedUsers: [],
      loggedInUsers: [],
      activeUsers: [],
      userLastSeen: {},
      activeJoinRequests: [],
      newRoomName: '',
      userDraftMessage: 'editing text',
      replyingTo: 123,
      editingMessageTimestamp: 456,
      editingMessageId: 'message-1',
      socket: undefined,
      getSocket: () => undefined,
      setSocket: vi.fn(),
      setCurrentRoom: vi.fn(),
      setNewRoomName: vi.fn(),
      setUserDraftMessage: vi.fn(),
      setLeftRoomsState: vi.fn(),
      setHiddenDmUnreadBaselineState: vi.fn(),
      setChatValuesState: vi.fn(),
      setBlockedUsersState: vi.fn(),
      setAuthTokenState: vi.fn(),
      setUsernameState: vi.fn(),
      setReplyingToState,
      setEditingMessageTimestampState,
      setEditingMessageIdState,
      setUserDraftMessageState,
    } as any);

    actions.onDraftKeyDownHandler({
      key: 'Escape',
      preventDefault,
      currentTarget: {
        selectionStart: 0,
        selectionEnd: 0,
      },
    } as any);

    expect(preventDefault).toHaveBeenCalled();
    expect(setReplyingToState).toHaveBeenCalledWith(undefined);
    expect(setEditingMessageTimestampState).toHaveBeenCalledWith(undefined);
    expect(setEditingMessageIdState).toHaveBeenCalledWith(undefined);
    expect(setUserDraftMessageState).toHaveBeenCalledWith('');
  });
});
