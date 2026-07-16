import { createContext, useContext, type ReactNode } from 'react';
import {
  type HomeAuthContextValue,
  type HomeComposerContextValue,
  type HomePresenceContextValue,
  type HomeRoomsContextValue,
} from './homePageTypes';
import { useHomePageActions } from '../../hooks/home/useHomePageActions';
import { useHomePageState } from '../../hooks/home/useHomePageState';

const HomeAuthContext = createContext<HomeAuthContextValue | null>(null);
const HomeRoomsContext = createContext<HomeRoomsContextValue | null>(null);
const HomeComposerContext = createContext<HomeComposerContextValue | null>(
  null,
);
const HomePresenceContext = createContext<HomePresenceContextValue | null>(
  null,
);

export function HomePageProvider({ children }: { children: ReactNode }) {
  const state = useHomePageState();
  const actions = useHomePageActions(state);

  const authValue: HomeAuthContextValue = {
    authToken: state.authToken,
  };

  const roomsValue: HomeRoomsContextValue = {
    username: state.username,
    roomList: state.roomList,
    leftRooms: state.leftRooms,
    roomNotifications: state.roomNotifications,
    currentRoom: state.currentRoom,
    newRoomName: state.newRoomName,
    setCurrentRoom: state.setCurrentRoom,
    setNewRoomName: state.setNewRoomName,
    onNewRoomKeyDownHandler: actions.onNewRoomKeyDownHandler,
    makeNewRoom: actions.makeNewRoom,
  };

  const composerValue: HomeComposerContextValue = {
    socket: state.socket,
    username: state.username,
    currentRoom: state.currentRoom,
    chatValues: state.chatValues,
    blockedUsers: state.blockedUsers,
    userDraftMessage: state.userDraftMessage,
    replyingTo: state.replyingTo,
    editingMessageTimestamp: state.editingMessageTimestamp,
    setUserDraftMessage: state.setUserDraftMessage,
    onDraftKeyDownHandler: actions.onDraftKeyDownHandler,
    doSend: actions.doSend,
    handleRequestAccess: actions.handleRequestAccess,
    handleGrantAccess: actions.handleGrantAccess,
    handleSelectVersion: actions.handleSelectVersion,
    handleReply: actions.handleReply,
    handleEdit: actions.handleEdit,
    handleVote: actions.handleVote,
    handleCancelReplyOrEdit: actions.handleCancelReplyOrEdit,
  };

  const presenceValue: HomePresenceContextValue = {
    username: state.username,
    blockedUsers: state.blockedUsers,
    loggedInUsers: state.loggedInUsers,
    activeUsers: state.activeUsers,
    userLastSeen: state.userLastSeen,
    activeJoinRequests: state.activeJoinRequests,
    currentRoom: state.currentRoom,
    handleMessageUser: actions.handleMessageUser,
    handleSendPublicKeyToUser: actions.handleSendPublicKeyToUser,
    handleBlockUser: actions.handleBlockUser,
    handleVoteJoin: actions.handleVoteJoin,
    handleLogout: actions.handleLogout,
  };

  return (
    <HomeAuthContext.Provider value={authValue}>
      <HomeRoomsContext.Provider value={roomsValue}>
        <HomeComposerContext.Provider value={composerValue}>
          <HomePresenceContext.Provider value={presenceValue}>
            {children}
          </HomePresenceContext.Provider>
        </HomeComposerContext.Provider>
      </HomeRoomsContext.Provider>
    </HomeAuthContext.Provider>
  );
}

export function useHomeAuthContext() {
  const context = useContext(HomeAuthContext);
  if (!context) {
    throw new Error(
      'useHomeAuthContext must be used within a HomePageProvider',
    );
  }
  return context;
}

export function useHomeRoomsContext() {
  const context = useContext(HomeRoomsContext);
  if (!context) {
    throw new Error(
      'useHomeRoomsContext must be used within a HomePageProvider',
    );
  }
  return context;
}

export function useHomeComposerContext() {
  const context = useContext(HomeComposerContext);
  if (!context) {
    throw new Error(
      'useHomeComposerContext must be used within a HomePageProvider',
    );
  }
  return context;
}

export function useHomePresenceContext() {
  const context = useContext(HomePresenceContext);
  if (!context) {
    throw new Error(
      'useHomePresenceContext must be used within a HomePageProvider',
    );
  }
  return context;
}
