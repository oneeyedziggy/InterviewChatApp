import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { type Socket } from '../../utils/websocketClient';
import { type Messages } from '../../types/types';
import { restoreSession } from '../../utils/homeSession';
import { initializeHomeSocket } from '../../utils/homeSocketInitializer';
import { getBlockedUsers } from '../../utils/userSettings';
import { type JoinRequest } from '../../contexts/home/homePageTypes';

type TenantSnapshot = {
  chatValues: Messages;
  roomList: string[];
  leftRooms: Set<string>;
  currentRoom: string;
  roomNotifications: Record<string, number>;
};

const tenantSnapshots = new Map<string, TenantSnapshot>();

const routeServerKey = (): string =>
  typeof window === 'undefined'
    ? ''
    : new URLSearchParams(window.location.search).get('server') || '';

const publishTenantUnreadCount = (
  serverKey: string,
  roomNotifications: Record<string, number>,
) => {
  if (typeof window === 'undefined' || !serverKey) return;
  const unread = Object.values(roomNotifications).reduce(
    (total, count) => total + Math.max(0, count || 0),
    0,
  );
  window.dispatchEvent(
    new CustomEvent('tenant-unread-changed', {
      detail: { serverKey, unread },
    }),
  );
};

type UseHomeSessionLifecycleArgs = {
  authToken: string;
  username: string;
  setAuthToken: Dispatch<SetStateAction<string>>;
  setUsername: Dispatch<SetStateAction<string>>;
  setBlockedUsers: Dispatch<SetStateAction<string[]>>;
  setChatValues: Dispatch<SetStateAction<Messages>>;
  setUserList: Dispatch<SetStateAction<string[]>>;
  setLoggedInUsers: Dispatch<SetStateAction<string[]>>;
  setActiveUsers: Dispatch<SetStateAction<string[]>>;
  setRoomList: Dispatch<SetStateAction<string[]>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  setRoomNotifications: Dispatch<SetStateAction<Record<string, number>>>;
  setUserLastSeen: Dispatch<SetStateAction<Record<string, number>>>;
  setRoomMembers: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  setActiveJoinRequests: Dispatch<SetStateAction<JoinRequest[]>>;
  setIsSwitchingServer: Dispatch<SetStateAction<boolean>>;
  onForceReauth: () => void;
  getSocket: () => Socket | undefined;
  getLeftRooms: () => Set<string>;
  getChatValues: () => Messages;
  getRoomNotifications: () => Record<string, number>;
  getHiddenDmUnreadBaseline: () => Record<string, number>;
  setLeftRooms: Dispatch<SetStateAction<Set<string>>>;
  setHiddenDmUnreadBaseline: Dispatch<SetStateAction<Record<string, number>>>;
  getCurrentRoom: () => string;
  getRoomList: () => string[];
  setSocket: (next: Socket | undefined) => void;
};

export const useHomeSessionLifecycle = ({
  authToken,
  username,
  setAuthToken,
  setUsername,
  setBlockedUsers,
  setChatValues,
  setUserList,
  setLoggedInUsers,
  setActiveUsers,
  setRoomList,
  setCurrentRoom,
  setRoomNotifications,
  setUserLastSeen,
  setRoomMembers,
  setActiveJoinRequests,
  setIsSwitchingServer,
  onForceReauth,
  getSocket,
  getLeftRooms,
  getChatValues,
  getRoomNotifications,
  getHiddenDmUnreadBaseline,
  setLeftRooms,
  setHiddenDmUnreadBaseline,
  getCurrentRoom,
  getRoomList,
  setSocket,
}: UseHomeSessionLifecycleArgs) => {
  const initializeSession = async (
    sessionIdToVerify: string,
    usernameToSet: string,
  ) => {
    console.log('[Home] Initializing session for user:', usernameToSet);

    const socket = getSocket();
    if (socket && socket.connected) {
      console.log('[Home] Disconnecting existing socket for re-init');
      socket.disconnect();
      setSocket(undefined);
    }
    if ((window as any).__socket && (window as any).__socket.connected) {
      console.log('[Home] Disconnecting window socket for re-init');
      (window as any).__socket.disconnect();
      (window as any).__socket = undefined;
    }

    setAuthToken(sessionIdToVerify);
    setUsername(usernameToSet);
  };

  useEffect(() => {
    let cancelled = false;
    let lastServerKey = routeServerKey();

    const restore = async () => {
      await restoreSession({
        isCancelled: () => cancelled,
        initializeSession,
        onForceReauth,
      });
    };

    void restore();
    const handleServerNavigation = (event: Event) => {
      const handoff = (
        event as CustomEvent<{
          sessionId?: string;
          username?: string;
        }>
      ).detail;
      const socket = getSocket();
      if (socket?.connected) {
        socket.disconnect();
      }
      setSocket(undefined);
      if ((window as any).__socket?.connected) {
        (window as any).__socket.disconnect();
        (window as any).__socket = undefined;
      }
      const nextServerKey = routeServerKey();
      if (lastServerKey) {
        const snapshot = {
          chatValues: getChatValues(),
          roomList: getRoomList(),
          leftRooms: new Set(getLeftRooms()),
          currentRoom: getCurrentRoom(),
          roomNotifications: getRoomNotifications(),
        };
        tenantSnapshots.set(lastServerKey, snapshot);
        publishTenantUnreadCount(lastServerKey, snapshot.roomNotifications);
      }
      const nextSnapshot = tenantSnapshots.get(nextServerKey);
      setChatValues(nextSnapshot?.chatValues || {});
      setRoomList(nextSnapshot?.roomList || []);
      setCurrentRoom(nextSnapshot?.currentRoom || '');
      setLeftRooms(nextSnapshot?.leftRooms || new Set());
      setRoomNotifications(nextSnapshot?.roomNotifications || {});
      setHiddenDmUnreadBaseline({});
      setUserList([]);
      setLoggedInUsers([]);
      setActiveUsers([]);
      setUserLastSeen({});
      setRoomMembers({});
      setActiveJoinRequests([]);
      lastServerKey = nextServerKey;
      if (handoff?.sessionId && handoff.username) {
        setIsSwitchingServer(false);
        setAuthToken(handoff.sessionId);
        setUsername(handoff.username);
      } else {
        setIsSwitchingServer(true);
        setAuthToken('');
        setUsername('');
        void restore();
      }
    };
    window.addEventListener('popstate', handleServerNavigation);

    return () => {
      cancelled = true;
      window.removeEventListener('popstate', handleServerNavigation);
    };
    // initializeSession intentionally omitted to preserve mount-only behavior
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setBlockedUsers(getBlockedUsers());
  }, [setBlockedUsers]);

  useEffect(() => {
    console.log(
      '[Home] useEffect triggered, authToken:',
      authToken,
      'username:',
      username,
    );
    if (authToken) {
      setIsSwitchingServer(false);
      console.log('[Home] Calling socketInitializer');
      initializeHomeSocket({
        authToken,
        username,
        setAuthToken,
        setChatValues,
        setUserList,
        setLoggedInUsers,
        setActiveUsers,
        setRoomList,
        setLeftRooms,
        setCurrentRoom,
        setRoomNotifications,
        setUserLastSeen,
        setRoomMembers,
        setActiveJoinRequests,
        getSocket,
        getLeftRooms,
        getChatValues,
        getRoomNotifications,
        getHiddenDmUnreadBaseline,
        getCurrentRoom,
        getRoomList,
        setSocket,
        setHiddenDmUnreadBaseline,
      });
    } else {
      console.log('[Home] No authToken, skipping socket initialization');
    }
    // Match previous dependency semantics (authToken-only trigger)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);
};
