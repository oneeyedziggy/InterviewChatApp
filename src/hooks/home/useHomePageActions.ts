import { SOCKET_EVENTS } from '../../constants';
import {
  doSendAction,
  grantAccessAction,
  requestAccessAction,
  selectVersionAction,
} from '../../utils/homeActions';
import { type HomePageState } from '../../contexts/home/homePageTypes';
import { getDmRoomId, isDmRoom } from '../../utils/dmRooms';
import {
  decryptSharedAccountPackageForRecipient,
  encryptSharedAccountPackageForRecipient,
  importSharedAccountPackage,
  loadKeys,
  loadUserPublicKeyEntries,
  redirectToLogout,
} from '../../utils/gpg';
import {
  blockUser,
  getBlockedUserExportsForCurrentUser,
  getBlockedUsers,
  unblockUser,
} from '../../utils/userSettings';

function focusDraftInput() {
  const input = document.getElementById(
    'userDraftMessageInput',
  ) as HTMLInputElement | null;
  if (input) {
    input.focus();
  }
}

export function useHomePageActions(state: HomePageState) {
  const doSend = async () => {
    await doSendAction({
      socket: state.getSocket(),
      userDraftMessage: state.userDraftMessage,
      currentRoom: state.currentRoom,
      editingMessageTimestamp: state.editingMessageTimestamp,
      editingMessageId: state.editingMessageId,
      blockedUsers: state.blockedUsers,
      username: state.username,
      replyingTo: state.replyingTo,
      setEditingMessageTimestamp: state.setEditingMessageTimestampState,
      setEditingMessageId: state.setEditingMessageIdState,
      setUserDraftMessage: state.setUserDraftMessageState,
      setReplyingTo: state.setReplyingToState,
    });
  };

  const onDraftKeyDownHandler = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  const makeNewRoom = () => {
    const socket = state.getSocket();
    const roomName = state.newRoomName.trim();
    if (!socket || roomName === '') return;

    state.setLeftRoomsState((prev) => {
      const next = new Set(prev);
      next.delete(roomName);
      return next;
    });
    state.setCurrentRoom(roomName);
    socket.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, roomName);
  };

  const onNewRoomKeyDownHandler = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === 'Enter') {
      makeNewRoom();
    }
  };

  const hideRoom = (room: string) => {
    if (!room) return;

    if (isDmRoom(room)) {
      const unreadAtHide = Math.max(0, state.roomNotifications[room] || 0);
      state.setHiddenDmUnreadBaselineState((prev) => ({
        ...prev,
        [room]: unreadAtHide,
      }));
    }

    state.setLeftRoomsState((prev) => {
      const next = new Set(prev);
      next.add(room);
      return next;
    });

    if (state.currentRoom === room) {
      const availableRooms = state.roomList.filter(
        (r) => !state.leftRooms.has(r) && r !== room,
      );
      if (availableRooms.length > 0) {
        state.setCurrentRoom(availableRooms[0]);
      }
    }
  };

  const showRoom = (room: string) => {
    if (!room) return;

    state.setLeftRoomsState((prev) => {
      const next = new Set(prev);
      next.delete(room);
      return next;
    });

    if (isDmRoom(room)) {
      state.setHiddenDmUnreadBaselineState((prev) => {
        if (!(room in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[room];
        return next;
      });
    }

    state.setCurrentRoom(room);
  };

  const handleMessageUser = (targetUser: string) => {
    if (!state.username) return;
    const dmRoomId = getDmRoomId(state.username, targetUser);
    if (!state.roomList.includes(dmRoomId)) {
      const activeSocket = (window as any).__socket || state.getSocket();
      if (activeSocket) {
        activeSocket.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, dmRoomId);
      }
    }
    state.setLeftRoomsState((prev) => {
      const next = new Set(prev);
      next.delete(dmRoomId);
      return next;
    });
    state.setHiddenDmUnreadBaselineState((prev) => {
      if (!(dmRoomId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[dmRoomId];
      return next;
    });
    state.setCurrentRoom(dmRoomId);
  };

  const handleImportTransferredAccount = async (
    fromUser: string,
    encryptedPackage: string,
  ): Promise<{ success: boolean; message: string }> => {
    const keys = loadKeys();
    if (!keys?.privateKey) {
      return {
        success: false,
        message: 'Unable to import account: missing local private key.',
      };
    }

    try {
      const accountPackage = await decryptSharedAccountPackageForRecipient(
        encryptedPackage,
        keys.privateKey,
      );
      importSharedAccountPackage(fromUser, accountPackage);
      console.log(
        '[KeyTransfer] ✓ Imported shared account package from',
        fromUser,
      );
      return {
        success: true,
        message: `Imported account from ${fromUser}. It is now available in your local login list.`,
      };
    } catch (error) {
      console.error(
        '[KeyTransfer] ✗ Failed to import shared account package:',
        error,
      );
      return {
        success: false,
        message: 'Failed to import account bundle from this message.',
      };
    }
  };

  const handleSendPublicKeyToUser = (targetUser: string) => {
    void (async () => {
      const keys = loadKeys();
      const activeSocket = (window as any).__socket || state.getSocket();
      if (!keys?.publicKey || !activeSocket || !state.username) return;

      const userPubKeys = loadUserPublicKeyEntries() || {};
      const targetPublicKey = userPubKeys[targetUser]?.publicKey;
      if (!targetPublicKey) {
        alert(
          `Missing public key for ${targetUser}. Ask them to reconnect first.`,
        );
        return;
      }

      const blockedUsers = getBlockedUserExportsForCurrentUser();
      const accountPackage = {
        username: state.username,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        serverPublicKey: keys.serverPublicKey,
        userPubKeys,
        blockedUsers,
      };

      const encryptedAccountPackage =
        await encryptSharedAccountPackageForRecipient(
          accountPackage,
          targetPublicKey,
        );

      activeSocket.emit(SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY, {
        targetUser,
        fromUser: state.username,
        publicKey: keys.publicKey,
        encryptedAccountPackage,
      });
      console.log('[UserList] Sent encrypted account package to', targetUser);
    })().catch((error) => {
      console.error(
        '[UserList] Failed to send encrypted account package:',
        error,
      );
      alert('Failed to encrypt account bundle for recipient.');
    });
  };

  const handleBlockUser = (targetUser: string) => {
    blockUser(targetUser);
    state.setBlockedUsersState(getBlockedUsers());
    console.log('[UserList] Blocked user', targetUser);
  };

  const handleUnblockUser = (targetUser: string) => {
    const blockedAt = unblockUser(targetUser);
    state.setBlockedUsersState(getBlockedUsers());
    console.log('[UserList] Unblocked user', targetUser);

    const activeSocket = (window as any).__socket || state.getSocket();
    const keys = loadKeys();
    if (!activeSocket || !state.username || !keys?.sessionId) {
      return;
    }

    activeSocket.emit(SOCKET_EVENTS.CLIENT_UNBLOCK_USER_DELTA, {
      username: state.username,
      sessionId: keys.sessionId,
      targetUser,
      blockedSince: blockedAt ?? 0,
    });
  };

  const handleRequestAccess = (
    messageUsername: string,
    room: string,
    messageTimestamp: number,
  ) => {
    requestAccessAction({
      socket: state.getSocket(),
      username: state.username,
      chatValues: state.chatValues,
      messageUsername,
      room,
      messageTimestamp,
    });
  };

  const handleGrantAccess = async (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
    providedPlaintext?: string,
  ) => {
    await grantAccessAction({
      socket: state.getSocket(),
      username: state.username,
      chatValues: state.chatValues,
      blockedUsers: state.blockedUsers,
      setChatValues: state.setChatValuesState,
      requestingUser,
      originalRoom,
      messageTimestamp,
      providedPlaintext,
    });
  };

  const handleSelectVersion = async (
    room: string,
    messageTimestamp: number,
    versionIndex: number,
  ) => {
    await selectVersionAction({
      socket: state.getSocket(),
      username: state.username,
      chatValues: state.chatValues,
      setChatValues: state.setChatValuesState,
      room,
      messageTimestamp,
      versionIndex,
    });
  };

  const handleReply = (timestamp: number) => {
    console.log(
      '[onReply] Reply button clicked, setting replyingTo to:',
      timestamp,
    );
    state.setReplyingToState(timestamp);
    state.setEditingMessageTimestampState(undefined);
    focusDraftInput();
  };

  const handleEdit = (
    messageTimestamp: number,
    content: string,
    messageId?: string,
  ) => {
    console.log(
      '[onEdit] Edit button clicked, setting editingMessageTimestamp to:',
      messageTimestamp,
    );
    state.setEditingMessageTimestampState(messageTimestamp);
    state.setEditingMessageIdState(messageId);
    state.setReplyingToState(undefined);
    state.setUserDraftMessageState(content);
    focusDraftInput();
  };

  const handleDeleteMessage = (
    messageTimestamp: number,
    messageId?: string,
  ) => {
    const socket = state.getSocket();
    const keys = loadKeys();

    if (!socket || !state.username || !keys?.sessionId || !state.currentRoom) {
      alert('Unable to delete message: missing active session.');
      return;
    }

    if (
      !window.confirm(
        'Delete this message? It will be replaced with a deleted placeholder and replies will remain.',
      )
    ) {
      return;
    }

    socket.emit(SOCKET_EVENTS.CLIENT_DELETE_MESSAGE, {
      room: state.currentRoom,
      ...(messageId ? { messageId } : {}),
      messageTimestamp,
      username: state.username,
      sessionId: keys.sessionId,
    });

    if (state.editingMessageTimestamp === messageTimestamp) {
      state.setEditingMessageTimestampState(undefined);
      state.setEditingMessageIdState(undefined);
      state.setUserDraftMessageState('');
    }
    if (state.replyingTo === messageTimestamp) {
      state.setReplyingToState(undefined);
    }
  };

  const handleVote = (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => {
    const socket = state.getSocket();
    if (socket && state.username) {
      console.log(
        '[onVote] Voting',
        voteType,
        'on message',
        messageTimestamp,
        'in room',
        room,
      );
      socket.emit(SOCKET_EVENTS.CLIENT_VOTE_MESSAGE, {
        room,
        messageTimestamp,
        username: state.username,
        voteType,
      });
    }
  };

  const handleCancelReplyOrEdit = () => {
    state.setReplyingToState(undefined);
    state.setEditingMessageTimestampState(undefined);
    state.setEditingMessageIdState(undefined);
  };

  const handleVoteJoin = (
    requestingUser: string,
    room: string,
    vote: boolean,
  ) => {
    const socket = state.getSocket();
    if (socket) {
      socket.emit(SOCKET_EVENTS.CLIENT_VOTE_JOIN, {
        room,
        requestingUser,
        vote,
        voter: state.username,
      });
    }
  };

  const handleLogout = async () => {
    const activeSocket = (window as any).__socket || state.getSocket();
    if (activeSocket && state.authToken) {
      try {
        activeSocket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, state.authToken);
      } catch (error) {
        console.error('[Logout] Error emitting disconnect:', error);
      }
    }

    if (activeSocket) {
      activeSocket.disconnect();
    }
    if (state.getSocket()) {
      state.getSocket()?.disconnect();
    }

    state.setSocket(undefined);
    (window as any).__socket = undefined;

    state.setAuthTokenState('');
    state.setUsernameState('');

    redirectToLogout();
  };

  return {
    doSend,
    onDraftKeyDownHandler,
    makeNewRoom,
    hideRoom,
    showRoom,
    onNewRoomKeyDownHandler,
    handleMessageUser,
    handleSendPublicKeyToUser,
    handleImportTransferredAccount,
    handleBlockUser,
    handleUnblockUser,
    handleRequestAccess,
    handleGrantAccess,
    handleSelectVersion,
    handleReply,
    handleEdit,
    handleDeleteMessage,
    handleVote,
    handleCancelReplyOrEdit,
    handleVoteJoin,
    handleLogout,
  };
}
