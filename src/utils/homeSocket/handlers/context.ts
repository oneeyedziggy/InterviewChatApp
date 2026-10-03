import type { Dispatch, SetStateAction } from 'react';
import { type Socket } from '../../websocketClient';
import { type Messages } from '../../../types/types';
import type { JoinRequest } from '../../../contexts/home/homePageTypes';
import { getRoomNameByRoomId, getUsernameByUserId } from '../../identityMap';
import { appendMissingByIdentity } from '../messageState';
import { toDisplayUsers } from '../roomKeys';

export type InitSocketArgs = {
  authToken: string;
  username: string;
  setAuthToken: Dispatch<SetStateAction<string>>;
  setChatValues: Dispatch<SetStateAction<Messages>>;
  setUserList: Dispatch<SetStateAction<string[]>>;
  setLoggedInUsers: Dispatch<SetStateAction<string[]>>;
  setActiveUsers: Dispatch<SetStateAction<string[]>>;
  setRoomList: Dispatch<SetStateAction<string[]>>;
  setLeftRooms: Dispatch<SetStateAction<Set<string>>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  setRoomNotifications: Dispatch<SetStateAction<Record<string, number>>>;
  setUserLastSeen: Dispatch<SetStateAction<Record<string, number>>>;
  setRoomMembers: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  setActiveJoinRequests: Dispatch<SetStateAction<JoinRequest[]>>;
  getSocket: () => Socket | undefined;
  getLeftRooms: () => Set<string>;
  getChatValues: () => Messages;
  getRoomNotifications: () => Record<string, number>;
  getHiddenDmUnreadBaseline: () => Record<string, number>;
  getCurrentRoom: () => string;
  getRoomList: () => string[];
  setHiddenDmUnreadBaseline: Dispatch<SetStateAction<Record<string, number>>>;
  setSocket: (next: Socket | undefined) => void;
};

export type HomeSocketContext = InitSocketArgs & {
  socket: Socket;
  /** Mutable state shared across handlers for the lifetime of one socket. */
  session: {
    forcedRoomPayloads: Set<string>;
    preferredRoomFromPrefs: string;
  };
  refreshDisplayedUserLists: () => void;
  reconcileCurrentRoomWithResolvedName: (source: string) => void;
  applyPresence: (
    loggedInUsers: unknown,
    activeUsers: unknown,
    options?: { includeUserList?: boolean },
  ) => void;
};

export type RegisterListener = (
  event: string,
  handler: (...args: any[]) => void,
) => void;

const toUsernames = (users: string[]) =>
  users.map((user) => getUsernameByUserId(user) || user);

export const createHomeSocketContext = (
  args: InitSocketArgs,
  socket: Socket,
): HomeSocketContext => {
  const {
    getCurrentRoom,
    setChatValues,
    setCurrentRoom,
    setUserList,
    setLoggedInUsers,
    setActiveUsers,
  } = args;

  // When a room name gets decrypted, migrate state keyed by the opaque wire ID
  // to the resolved name so the visible pane and incoming messages agree.
  const reconcileCurrentRoomWithResolvedName = (source: string) => {
    const currentRoom = getCurrentRoom();
    const resolvedCurrentRoom = getRoomNameByRoomId(currentRoom) || currentRoom;
    if (resolvedCurrentRoom === currentRoom) {
      return;
    }
    console.log(
      `[Socket] Re-resolving currentRoom after ${source} resolved a room name:`,
      { from: currentRoom, to: resolvedCurrentRoom },
    );
    setChatValues((prev) => {
      if (!prev[currentRoom]) {
        return prev;
      }
      const updated = { ...prev };
      const staleMessages = updated[currentRoom];
      delete updated[currentRoom];
      updated[resolvedCurrentRoom] = appendMissingByIdentity(
        updated[resolvedCurrentRoom] || [],
        staleMessages,
      );
      return updated;
    });
    setCurrentRoom(resolvedCurrentRoom);
  };

  const refreshDisplayedUserLists = () => {
    setUserList(toUsernames);
    setLoggedInUsers(toUsernames);
    setActiveUsers(toUsernames);
  };

  const applyPresence: HomeSocketContext['applyPresence'] = (
    loggedInUsers,
    activeUsers,
    options = {},
  ) => {
    const loggedInDisplay = toDisplayUsers(loggedInUsers || []);
    const activeDisplay = toDisplayUsers(activeUsers || []);
    setLoggedInUsers(loggedInDisplay);
    setActiveUsers(activeDisplay);
    if (options.includeUserList) {
      setUserList([...loggedInDisplay, ...activeDisplay]);
    }
  };

  return {
    ...args,
    socket,
    session: { forcedRoomPayloads: new Set(), preferredRoomFromPrefs: '' },
    refreshDisplayedUserLists,
    reconcileCurrentRoomWithResolvedName,
    applyPresence,
  };
};
