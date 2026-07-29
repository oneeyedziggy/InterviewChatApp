import { SOCKET_EVENTS } from '../../constants';
import { MESSAGE_LIMITS } from '../../constants';
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
  encryptForAllUsers,
  encryptSharedAccountPackageForRecipient,
  filterPubKeysForEncryption,
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
import { getUtf8ByteLength } from '../../utils/messages';
import {
  getUserIdByUsername,
  requireRoomIdByName,
  requireUserIdByUsername,
} from '../../utils/identityMap';
import { emitSignedMutation } from '../../utils/socketAuth';

async function roomNameHash(roomName: string): Promise<string> {
  const normalized = roomName.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function focusDraftInput() {
  const input = document.getElementById('userDraftMessageInput') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (input) {
    input.focus();
  }
}

export function useHomePageActions(state: HomePageState) {
  const currentUserId = state.username
    ? getUserIdByUsername(state.username) || ''
    : '';

  const doSend = async () => {
    if (
      getUtf8ByteLength(state.userDraftMessage) > MESSAGE_LIMITS.MAX_TEXT_BYTES
    ) {
      return;
    }

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
    const isDraftOverLimit =
      getUtf8ByteLength(state.userDraftMessage) > MESSAGE_LIMITS.MAX_TEXT_BYTES;

    if (
      e.key === 'ArrowUp' &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      const target = e.currentTarget;
      const caretAtStart =
        target.selectionStart === 0 && target.selectionEnd === 0;
      const draftIsEmpty = state.userDraftMessage.trim() === '';

      if (
        caretAtStart &&
        draftIsEmpty &&
        state.editingMessageTimestamp === undefined
      ) {
        const roomMessages = state.chatValues[state.currentRoom] || [];
        const latestOwnMessage = [...roomMessages]
          .reverse()
          .find(
            (message) =>
              message.userId === currentUserId &&
              message.userId !== 'system' &&
              !message.deleted &&
              message.content !== 'Message deleted',
          );

        if (latestOwnMessage) {
          e.preventDefault();
          state.setEditingMessageTimestampState(latestOwnMessage.timestamp);
          state.setEditingMessageIdState(latestOwnMessage.id);
          state.setReplyingToState(undefined);
          state.setUserDraftMessageState(latestOwnMessage.content);
          focusDraftInput();
        }
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isDraftOverLimit) {
        return;
      }
      void doSend();
    }
  };

  const makeNewRoom = async () => {
    const socket = state.getSocket();
    const roomName = state.newRoomName.trim();
    const keys = loadKeys();
    if (!socket || roomName === '' || !state.username || !keys?.sessionId)
      return;

    const userId = requireUserIdByUsername(state.username);

    const userPubKeys = loadUserPublicKeyEntries() || {};
    const filteredPubKeys = filterPubKeysForEncryption(userPubKeys, {
      blockedUsers: state.blockedUsers,
    });

    let roomNameCiphertext = '';
    let normalizedRoomNameHash = '';
    const roomDirectoryUpdatedAt = Date.now();
    try {
      roomNameCiphertext = await encryptForAllUsers(
        roomName,
        filteredPubKeys,
        keys.publicKey,
        state.username,
      );
      normalizedRoomNameHash = await roomNameHash(roomName);
    } catch (error) {
      console.error('[RoomCreate] Failed to encrypt room name', error);
      return;
    }

    void emitSignedMutation(socket, {
      event: SOCKET_EVENTS.CLIENT_NEW_ROOM,
      payload: {
        roomNameCiphertext,
        roomNameHash: normalizedRoomNameHash,
        roomDirectoryUpdatedAt,
        userId,
        sessionId: keys.sessionId,
      },
      userId,
      sessionId: keys.sessionId,
      claims: {
        roomNameCiphertext,
        roomNameHash: normalizedRoomNameHash,
        roomDirectoryUpdatedAt: String(roomDirectoryUpdatedAt),
      },
    });
  };

  const onNewRoomKeyDownHandler = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === 'Enter') {
      void makeNewRoom();
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

      if (!keys.sessionId) {
        alert('Session expired. Please log in again.');
        return;
      }

      const targetUserId = requireUserIdByUsername(targetUser);
      const fromUserId = requireUserIdByUsername(state.username);
      void emitSignedMutation(activeSocket, {
        event: SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY,
        payload: {
          targetUserId,
          fromUserId,
          publicKey: keys.publicKey,
          encryptedAccountPackage,
          sessionId: keys.sessionId,
        },
        userId: fromUserId,
        sessionId: keys.sessionId,
        claims: {
          fromUserId,
          targetUserId,
          publicKey: keys.publicKey,
        },
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

    const userId = requireUserIdByUsername(state.username);
    const targetUserId = requireUserIdByUsername(targetUser);
    void emitSignedMutation(activeSocket, {
      event: SOCKET_EVENTS.CLIENT_UNBLOCK_USER_DELTA,
      payload: {
        userId,
        sessionId: keys.sessionId,
        targetUserId,
        blockedSince: blockedAt ?? 0,
      },
      userId,
      sessionId: keys.sessionId,
      claims: {
        userId,
        targetUserId,
        blockedSince: blockedAt ?? 0,
      },
    });
  };

  const handleRequestAccess = (
    messageUserId: string,
    room: string,
    messageTimestamp: number,
  ) => {
    requestAccessAction({
      socket: state.getSocket(),
      username: state.username,
      chatValues: state.chatValues,
      messageUserId,
      room,
      messageTimestamp,
    });
  };

  const handleGrantAccess = async (
    requestingUserId: string,
    originalRoom: string,
    messageTimestamp: number,
  ) => {
    await grantAccessAction({
      socket: state.getSocket(),
      username: state.username,
      chatValues: state.chatValues,
      blockedUsers: state.blockedUsers,
      setChatValues: state.setChatValuesState,
      requestingUserId,
      originalRoom,
      messageTimestamp,
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

    const userId = requireUserIdByUsername(state.username);
    const roomId = requireRoomIdByName(state.currentRoom);
    void emitSignedMutation(socket, {
      event: SOCKET_EVENTS.CLIENT_DELETE_MESSAGE,
      payload: {
        room: state.currentRoom,
        roomId,
        ...(messageId ? { messageId } : {}),
        messageTimestamp,
        userId,
        sessionId: keys.sessionId,
      },
      userId,
      sessionId: keys.sessionId,
      claims: {
        userId,
        roomId,
        messageTimestamp,
      },
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
    const keys = loadKeys();
    if (socket && state.username && keys?.sessionId) {
      console.log(
        '[onVote] Voting',
        voteType,
        'on message',
        messageTimestamp,
        'in room',
        room,
      );
      const userId = requireUserIdByUsername(state.username);
      const roomId = requireRoomIdByName(room);
      void emitSignedMutation(socket, {
        event: SOCKET_EVENTS.CLIENT_VOTE_MESSAGE,
        payload: {
          room,
          roomId,
          messageTimestamp,
          userId,
          voteType,
          sessionId: keys.sessionId,
        },
        userId,
        sessionId: keys.sessionId,
        claims: {
          roomId,
          messageTimestamp,
          voteType,
        },
      });
    }
  };

  const handleCancelReplyOrEdit = () => {
    state.setReplyingToState(undefined);
    state.setEditingMessageTimestampState(undefined);
    state.setEditingMessageIdState(undefined);
  };

  const handleVoteJoin = (
    requestingUserId: string,
    requestingUser: string,
    roomId: string,
    room: string,
    vote: boolean,
  ) => {
    const socket = state.getSocket();
    const keys = loadKeys();
    if (socket && state.username && keys?.sessionId) {
      const voterUserId = requireUserIdByUsername(state.username);
      void emitSignedMutation(socket, {
        event: SOCKET_EVENTS.CLIENT_VOTE_JOIN,
        payload: {
          room,
          roomId,
          requestingUserId,
          vote,
          voterUserId,
          sessionId: keys.sessionId,
        },
        userId: voterUserId,
        sessionId: keys.sessionId,
        claims: {
          roomId,
          requestingUserId,
          voterUserId,
          vote,
        },
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
