import { useEffect, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { type Messages } from '../../types/types';
import { SOCKET_EVENTS } from '../../constants';
import {
  type HomePageState,
  type JoinRequest,
} from '../../contexts/home/homePageTypes';
import { useHomeAutoDecrypt } from './useHomeAutoDecrypt';
import { useHomeSessionLifecycle } from './useHomeSessionLifecycle';
import { forceReauthToLogin, loadKeys } from '../../utils/gpg';

type StoredRoomPrefs = {
  leftRooms?: string[];
  currentRoom?: string;
  openRooms?: string[];
};

function roomPrefsStorageKey(username: string): string {
  return `home_room_prefs_${username}`;
}

export function useHomePageState(): HomePageState {
  const socketRef = useRef<Socket | undefined>(undefined);
  const [chatValues, setChatValuesState] = useState<Messages>({});
  const [, setUserList] = useState<string[]>([]);
  const [loggedInUsers, setLoggedInUsers] = useState<string[]>([]);
  const [activeUsers, setActiveUsers] = useState<string[]>([]);
  const [roomList, setRoomList] = useState<string[]>([]);
  const [leftRooms, setLeftRoomsState] = useState<Set<string>>(new Set());
  const [roomNotifications, setRoomNotifications] = useState<
    Record<string, number>
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
  const [editingMessageId, setEditingMessageIdState] = useState<
    string | undefined
  >(undefined);

  const getSocket = () => socketRef.current;
  const currentRoomRef = useRef<string>('');
  const roomListRef = useRef<string[]>([]);
  const getCurrentRoom = () => currentRoomRef.current;
  const getRoomList = () => roomListRef.current;

  useEffect(() => {
    currentRoomRef.current = currentRoomState;
  }, [currentRoomState]);

  useEffect(() => {
    roomListRef.current = roomList;
  }, [roomList]);

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
    setRoomNotifications,
    setUserLastSeen,
    setRoomMembers,
    setActiveJoinRequests,
    onForceReauth: forceReauthToLogin,
    getSocket,
    getCurrentRoom,
    getRoomList,
    setSocket,
  });

  useEffect(() => {
    setRoomNotifications((roomNotificationState) => {
      const baseRoomName = currentRoomState?.trim();
      if (!baseRoomName) {
        return roomNotificationState;
      }
      return {
        ...roomNotificationState,
        [baseRoomName]: 0,
      };
    });
  }, [currentRoomState]);

  useEffect(() => {
    if (!currentRoomState && roomList[0]) {
      setCurrentRoomState(roomList[0]);
    }
  }, [currentRoomState, roomList]);

  useEffect(() => {
    if (!username || typeof window === 'undefined') return;

    const raw = localStorage.getItem(roomPrefsStorageKey(username));
    if (!raw) return;

    try {
      const prefs = JSON.parse(raw) as StoredRoomPrefs;
      const restoredLeftRooms = Array.isArray(prefs.leftRooms)
        ? prefs.leftRooms.filter((room) => typeof room === 'string')
        : [];
      setLeftRoomsState(new Set(restoredLeftRooms));

      if (prefs.currentRoom && typeof prefs.currentRoom === 'string') {
        setCurrentRoomState(prefs.currentRoom);
      }
    } catch (error) {
      console.warn('[RoomPrefs] Failed to restore room preferences', error);
    }
  }, [username]);

  useEffect(() => {
    if (!username || typeof window === 'undefined') return;

    const openRooms = roomList.filter((room) => !leftRooms.has(room));
    const payload: StoredRoomPrefs = {
      leftRooms: Array.from(leftRooms),
      currentRoom: currentRoomState || undefined,
      openRooms,
    };
    localStorage.setItem(
      roomPrefsStorageKey(username),
      JSON.stringify(payload),
    );
  }, [username, leftRooms, currentRoomState, roomList]);

  useHomeAutoDecrypt({
    chatValues,
    username,
    setChatValues: setChatValuesState,
  });

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
    editingMessageId,
    socket: socketRef.current,
    getSocket,
    setSocket,
    setCurrentRoom: (room: string) => {
      setCurrentRoomState(room);

      if (!room || chatValues[room]) {
        return;
      }

      const socket = getSocket() || (window as any).__socket;
      const keys = loadKeys();
      if (!socket || !username || !keys?.sessionId) {
        return;
      }

      socket.emit(SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA, {
        username,
        sessionId: keys.sessionId,
        room,
      });
    },
    setNewRoomName: (roomName: string) => setNewRoomNameState(roomName),
    setUserDraftMessage: (message: string) => setUserDraftMessageState(message),
    setLeftRoomsState,
    setChatValuesState,
    setBlockedUsersState,
    setAuthTokenState,
    setUsernameState,
    setReplyingToState,
    setEditingMessageTimestampState,
    setEditingMessageIdState,
    setUserDraftMessageState,
  };
}
