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

function roomNotificationsStorageKey(username: string): string {
  return `home_room_notifications_${username}`;
}

function hiddenDmBaselineStorageKey(username: string): string {
  return `home_hidden_dm_unread_baseline_${username}`;
}

function normalizeRoomNotifications(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [room, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof room !== 'string' || room.trim() === '') {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    normalized[room] = Math.max(0, Math.floor(value));
  }

  return normalized;
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
  const [hiddenDmUnreadBaseline, setHiddenDmUnreadBaselineState] = useState<
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
  const [roomPrefsHydrated, setRoomPrefsHydrated] = useState(false);
  const [roomNotificationsHydrated, setRoomNotificationsHydrated] =
    useState(false);
  const [hiddenDmUnreadBaselineHydrated, setHiddenDmUnreadBaselineHydrated] =
    useState(false);

  const getSocket = () => socketRef.current;
  const currentRoomRef = useRef<string>('');
  const chatValuesRef = useRef<Messages>({});
  const roomListRef = useRef<string[]>([]);
  const leftRoomsRef = useRef<Set<string>>(new Set());
  const roomNotificationsRef = useRef<Record<string, number>>({});
  const hiddenDmUnreadBaselineRef = useRef<Record<string, number>>({});
  const getCurrentRoom = () => currentRoomRef.current;
  const getChatValues = () => chatValuesRef.current;
  const getRoomList = () => roomListRef.current;
  const getLeftRooms = () => leftRoomsRef.current;
  const getRoomNotifications = () => roomNotificationsRef.current;
  const getHiddenDmUnreadBaseline = () => hiddenDmUnreadBaselineRef.current;

  useEffect(() => {
    currentRoomRef.current = currentRoomState;
  }, [currentRoomState]);

  useEffect(() => {
    chatValuesRef.current = chatValues;
  }, [chatValues]);

  useEffect(() => {
    roomListRef.current = roomList;
  }, [roomList]);

  useEffect(() => {
    leftRoomsRef.current = leftRooms;
  }, [leftRooms]);

  useEffect(() => {
    roomNotificationsRef.current = roomNotifications;
  }, [roomNotifications]);

  useEffect(() => {
    hiddenDmUnreadBaselineRef.current = hiddenDmUnreadBaseline;
  }, [hiddenDmUnreadBaseline]);

  const setSocket = (next: Socket | undefined) => {
    socketRef.current = next;
  };

  useHomeSessionLifecycle({
    authToken,
    username,
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
    getLeftRooms,
    getChatValues,
    getRoomNotifications,
    getHiddenDmUnreadBaseline,
    setLeftRooms: setLeftRoomsState,
    setHiddenDmUnreadBaseline: setHiddenDmUnreadBaselineState,
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
    if (!username) {
      setRoomPrefsHydrated(false);
      setRoomNotificationsHydrated(false);
      setHiddenDmUnreadBaselineHydrated(false);
      setRoomNotifications({});
      setHiddenDmUnreadBaselineState({});
      return;
    }
    setRoomPrefsHydrated(false);
    setRoomNotificationsHydrated(false);
    setHiddenDmUnreadBaselineHydrated(false);
  }, [username]);

  useEffect(() => {
    if (!username || typeof window === 'undefined') return;

    const raw = localStorage.getItem(roomPrefsStorageKey(username));
    if (!raw) {
      setRoomPrefsHydrated(true);
      return;
    }

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
    } finally {
      setRoomPrefsHydrated(true);
    }
  }, [username]);

  useEffect(() => {
    if (!username || typeof window === 'undefined') return;

    const raw = localStorage.getItem(hiddenDmBaselineStorageKey(username));
    if (!raw) {
      setHiddenDmUnreadBaselineState({});
      setHiddenDmUnreadBaselineHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      setHiddenDmUnreadBaselineState(normalizeRoomNotifications(parsed));
    } catch (error) {
      console.warn(
        '[RoomPrefs] Failed to restore hidden DM unread baseline',
        error,
      );
      setHiddenDmUnreadBaselineState({});
    } finally {
      setHiddenDmUnreadBaselineHydrated(true);
    }
  }, [username]);

  useEffect(() => {
    if (!username || typeof window === 'undefined') return;

    const raw = localStorage.getItem(roomNotificationsStorageKey(username));
    if (!raw) {
      setRoomNotifications({});
      setRoomNotificationsHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      setRoomNotifications(normalizeRoomNotifications(parsed));
    } catch (error) {
      console.warn(
        '[RoomNotifications] Failed to restore room notifications',
        error,
      );
      setRoomNotifications({});
    } finally {
      setRoomNotificationsHydrated(true);
    }
  }, [username]);

  useEffect(() => {
    if (!username || typeof window === 'undefined' || !roomPrefsHydrated)
      return;

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
  }, [username, leftRooms, currentRoomState, roomList, roomPrefsHydrated]);

  useEffect(() => {
    if (
      !username ||
      typeof window === 'undefined' ||
      !roomNotificationsHydrated
    ) {
      return;
    }

    localStorage.setItem(
      roomNotificationsStorageKey(username),
      JSON.stringify(roomNotifications),
    );
  }, [username, roomNotifications, roomNotificationsHydrated]);

  useEffect(() => {
    if (
      !username ||
      typeof window === 'undefined' ||
      !hiddenDmUnreadBaselineHydrated
    ) {
      return;
    }

    localStorage.setItem(
      hiddenDmBaselineStorageKey(username),
      JSON.stringify(hiddenDmUnreadBaseline),
    );
  }, [username, hiddenDmUnreadBaseline, hiddenDmUnreadBaselineHydrated]);

  useHomeAutoDecrypt({
    chatValues,
    username,
    setChatValues: setChatValuesState,
  });

  useEffect(() => {
    if (blockedUsers.length === 0) return;

    setChatValuesState((prev) => {
      const blockedSet = new Set(blockedUsers);
      let changed = false;
      const next: Messages = {};

      for (const [room, messages] of Object.entries(prev)) {
        const filtered = messages.filter((message) => {
          if (
            message.username !== 'system' &&
            blockedSet.has(message.username)
          ) {
            changed = true;
            return false;
          }

          const hasEncryptedPayload =
            !!message.encryptedMessage ||
            !!message.encryptedFor ||
            (message.versions?.length || 0) > 0;
          const content = (message.content || '').trim();
          if (
            hasEncryptedPayload &&
            (!content ||
              content.includes('🔒') ||
              content.includes('[Encrypted message]'))
          ) {
            changed = true;
            return false;
          }

          return true;
        });
        next[room] = filtered;
      }

      return changed ? next : prev;
    });
  }, [blockedUsers]);

  return {
    authToken,
    username,
    roomList,
    leftRooms,
    roomNotifications,
    hiddenDmUnreadBaseline,
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

      if (!room) {
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
    setHiddenDmUnreadBaselineState,
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
