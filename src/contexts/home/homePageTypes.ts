import { type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { type Socket } from 'socket.io-client';
import { type Messages } from '../../types/types';

export type JoinRequest = {
  requestingUser: string;
  room: string;
  timestamp: number;
};

export type HomeAuthContextValue = {
  authToken: string;
};

export type HomeRoomsContextValue = {
  username: string;
  roomList: string[];
  leftRooms: Set<string>;
  roomNotifications: Record<string, string>;
  currentRoom: string;
  newRoomName: string;
  setCurrentRoom: (room: string) => void;
  setNewRoomName: (roomName: string) => void;
  onNewRoomKeyDownHandler: (e: KeyboardEvent<HTMLInputElement>) => void;
  makeNewRoom: () => void;
};

export type HomeComposerContextValue = {
  socket: Socket | undefined;
  username: string;
  currentRoom: string;
  chatValues: Messages;
  blockedUsers: string[];
  userDraftMessage: string;
  replyingTo: number | undefined;
  editingMessageTimestamp: number | undefined;
  setUserDraftMessage: (message: string) => void;
  onDraftKeyDownHandler: (e: KeyboardEvent<HTMLInputElement>) => void;
  doSend: () => Promise<void>;
  handleRequestAccess: (
    messageUsername: string,
    room: string,
    messageTimestamp: number,
  ) => void;
  handleGrantAccess: (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
    providedPlaintext?: string,
  ) => Promise<void>;
  handleSelectVersion: (
    room: string,
    messageTimestamp: number,
    versionIndex: number,
  ) => Promise<void>;
  handleReply: (timestamp: number) => void;
  handleEdit: (messageTimestamp: number, content: string) => void;
  handleVote: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void;
  handleCancelReplyOrEdit: () => void;
};

export type HomePresenceContextValue = {
  username: string;
  blockedUsers: string[];
  loggedInUsers: string[];
  activeUsers: string[];
  userLastSeen: Record<string, number>;
  activeJoinRequests: JoinRequest[];
  currentRoom: string;
  handleMessageUser: (targetUser: string) => void;
  handleSendPublicKeyToUser: (targetUser: string) => void;
  handleBlockUser: (targetUser: string) => void;
  handleVoteJoin: (requestingUser: string, room: string, vote: boolean) => void;
  handleLogout: () => Promise<void>;
};

export type HomePageState = {
  authToken: string;
  username: string;
  roomList: string[];
  leftRooms: Set<string>;
  roomNotifications: Record<string, string>;
  currentRoom: string;
  chatValues: Messages;
  blockedUsers: string[];
  loggedInUsers: string[];
  activeUsers: string[];
  userLastSeen: Record<string, number>;
  activeJoinRequests: JoinRequest[];
  newRoomName: string;
  userDraftMessage: string;
  replyingTo: number | undefined;
  editingMessageTimestamp: number | undefined;
  socket: Socket | undefined;
  getSocket: () => Socket | undefined;
  setSocket: (next: Socket | undefined) => void;
  setCurrentRoom: (room: string) => void;
  setNewRoomName: (roomName: string) => void;
  setUserDraftMessage: (message: string) => void;
  setLeftRoomsState: Dispatch<SetStateAction<Set<string>>>;
  setChatValuesState: Dispatch<SetStateAction<Messages>>;
  setBlockedUsersState: Dispatch<SetStateAction<string[]>>;
  setAuthTokenState: Dispatch<SetStateAction<string>>;
  setUsernameState: Dispatch<SetStateAction<string>>;
  setReplyingToState: Dispatch<SetStateAction<number | undefined>>;
  setEditingMessageTimestampState: Dispatch<SetStateAction<number | undefined>>;
  setUserDraftMessageState: Dispatch<SetStateAction<string>>;
};
