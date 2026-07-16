import { SOCKET_EVENTS } from '../../constants';
import {
  doSendAction,
  grantAccessAction,
  requestAccessAction,
  selectVersionAction,
} from '../../utils/homeActions';
import { type HomePageState } from '../../contexts/home/homePageTypes';
import { getDmRoomId } from '../../utils/dmRooms';
import { loadKeys, redirectToLogout } from '../../utils/gpg';
import { blockUser, getBlockedUsers } from '../../utils/userSettings';

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
      blockedUsers: state.blockedUsers,
      username: state.username,
      replyingTo: state.replyingTo,
      setEditingMessageTimestamp: state.setEditingMessageTimestampState,
      setUserDraftMessage: state.setUserDraftMessageState,
      setReplyingTo: state.setReplyingToState,
    });
  };

  const onDraftKeyDownHandler = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void doSend();
    }
  };

  const makeNewRoom = () => {
    const socket = state.getSocket();
    if (!socket) return;
    socket.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, state.newRoomName);
  };

  const onNewRoomKeyDownHandler = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === 'Enter') {
      makeNewRoom();
    }
  };

  const handleMessageUser = (targetUser: string) => {
    if (!state.username || targetUser === state.username) return;
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
    state.setCurrentRoom(dmRoomId);
  };

  const handleSendPublicKeyToUser = (targetUser: string) => {
    const keys = loadKeys();
    const activeSocket = (window as any).__socket || state.getSocket();
    if (!keys?.publicKey || !activeSocket || !state.username) return;
    activeSocket.emit(SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY, {
      targetUser,
      fromUser: state.username,
      publicKey: keys.publicKey,
    });
    console.log('[UserList] Sent public key to', targetUser);
  };

  const handleBlockUser = (targetUser: string) => {
    blockUser(targetUser);
    state.setBlockedUsersState(getBlockedUsers());
    console.log('[UserList] Blocked user', targetUser);
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

  const handleEdit = (messageTimestamp: number, content: string) => {
    console.log(
      '[onEdit] Edit button clicked, setting editingMessageTimestamp to:',
      messageTimestamp,
    );
    state.setEditingMessageTimestampState(messageTimestamp);
    state.setReplyingToState(undefined);
    state.setUserDraftMessageState(content);
    focusDraftInput();
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
    onNewRoomKeyDownHandler,
    handleMessageUser,
    handleSendPublicKeyToUser,
    handleBlockUser,
    handleRequestAccess,
    handleGrantAccess,
    handleSelectVersion,
    handleReply,
    handleEdit,
    handleVote,
    handleCancelReplyOrEdit,
    handleVoteJoin,
    handleLogout,
  };
}
