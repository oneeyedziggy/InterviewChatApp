import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { type Socket } from 'socket.io-client';
import { type Messages } from '../../types/types';
import { restoreSession } from '../../utils/homeSession';
import { initializeHomeSocket } from '../../utils/homeSocketInitializer';
import { getBlockedUsers } from '../../utils/userSettings';

type JoinRequest = {
  requestingUser: string;
  room: string;
  timestamp: number;
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

export function useHomeSessionLifecycle({
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
}: UseHomeSessionLifecycleArgs) {
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

    (async () => {
      await restoreSession({
        isCancelled: () => cancelled,
        initializeSession,
        onForceReauth,
      });
    })();

    return () => {
      cancelled = true;
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
}
