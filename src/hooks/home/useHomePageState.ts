import { useEffect, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { type Messages } from '../../types/types';
import {
  type HomePageState,
  type JoinRequest,
} from '../../contexts/home/homePageTypes';
import { useHomeAutoDecrypt } from './useHomeAutoDecrypt';
import { useHomeSessionLifecycle } from './useHomeSessionLifecycle';
import { forceReauthToLogin } from '../../utils/gpg';
import { computeRoomNotifications } from '../../utils/roomNotifications';

export function useHomePageState(): HomePageState {
  const socketRef = useRef<Socket | undefined>(undefined);

  const [oldChatValues, setOldChatValues] = useState<Messages>({});
  const [chatValues, setChatValuesState] = useState<Messages>({});
  const [, setUserList] = useState<string[]>([]);
  const [loggedInUsers, setLoggedInUsers] = useState<string[]>([]);
  const [activeUsers, setActiveUsers] = useState<string[]>([]);
  const [roomList, setRoomList] = useState<string[]>([]);
  const [leftRooms, setLeftRoomsState] = useState<Set<string>>(new Set());
  const [roomNotifications, setRoomNotifications] = useState<
    Record<string, string>
  >({});
  const [currentRoomState, setCurrentRoomState] = useState<string>('');

  const [authToken, setAuthTokenState] = useState<string>('');
  const [username, setUsernameState] = useState<string>('');
  const [userLastSeen, setUserLastSeen] = useState<Record<string, number>>({});
  const [, setRoomMembers] = useState<Record<string, Set<string>>>({});
  const [activeJoinRequests, setActiveJoinRequests] = useState<JoinRequest[]>(
    [],
  );
  const [blockedUsers, setBlockedUsersState] = useState<string[]>([]);

  const [newRoomNameState, setNewRoomNameState] = useState('');
  const [userDraftMessageState, setUserDraftMessageState] = useState('');
  const [replyingTo, setReplyingToState] = useState<number | undefined>(
    undefined,
  );
  const [editingMessageTimestamp, setEditingMessageTimestampState] = useState<
    number | undefined
  >(undefined);

  const getSocket = () => socketRef.current;
  const setSocket = (next: Socket | undefined) => {
    socketRef.current = next;
  };

  useHomeSessionLifecycle({
    authToken,
    username,
    leftRooms,
    setAuthToken: setAuthTokenState,
    setUsername: setUsernameState,
    setBlockedUsers: setBlockedUsersState,
    setChatValues: setChatValuesState,
    setUserList,
    setLoggedInUsers,
    setActiveUsers,
    setRoomList,
    setCurrentRoom: setCurrentRoomState,
    setUserLastSeen,
    setRoomMembers,
    setActiveJoinRequests,
    onForceReauth: forceReauthToLogin,
    getSocket,
    setSocket,
  });

  useEffect(() => {
    setRoomNotifications((roomNotificationState) => {
      const baseRoomName = currentRoomState?.replace(/-\(\d+ NEW!\)/, '');
      return {
        ...roomNotificationState,
        [baseRoomName]: '',
      };
    });
  }, [currentRoomState]);

  useEffect(() => {
    if (!currentRoomState && roomList[0]) {
      setCurrentRoomState(roomList[0]);
    }
  }, [currentRoomState, roomList]);

  useHomeAutoDecrypt({
    chatValues,
    username,
    setChatValues: setChatValuesState,
  });

  useEffect(() => {
    if (oldChatValues) {
      setRoomNotifications(
        computeRoomNotifications(oldChatValues, chatValues, currentRoomState),
      );
    }
    setOldChatValues(chatValues);
  }, [chatValues, currentRoomState, oldChatValues]);

  return {
    authToken,
    username,
    roomList,
    leftRooms,
    roomNotifications,
    currentRoom: currentRoomState,
    chatValues,
    blockedUsers,
    loggedInUsers,
    activeUsers,
    userLastSeen,
    activeJoinRequests,
    newRoomName: newRoomNameState,
    userDraftMessage: userDraftMessageState,
    replyingTo,
    editingMessageTimestamp,
    socket: socketRef.current,
    getSocket,
    setSocket,
    setCurrentRoom: (room: string) => setCurrentRoomState(room),
    setNewRoomName: (roomName: string) => setNewRoomNameState(roomName),
    setUserDraftMessage: (message: string) => setUserDraftMessageState(message),
    setLeftRoomsState,
    setChatValuesState,
    setBlockedUsersState,
    setAuthTokenState,
    setUsernameState,
    setReplyingToState,
    setEditingMessageTimestampState,
    setUserDraftMessageState,
  };
}
