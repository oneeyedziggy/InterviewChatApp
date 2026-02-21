export const DEFAULT_ROOM = '#general';
export const VALIDATION = {
  MIN_USERNAME_LENGTH: 8,
  MIN_PASSWORD_LENGTH: 8,
} as const;

export const SOCKET_EVENTS = {
  CLIENT_MESSAGE: 'clientMessage',
  CLIENT_NEW_ROOM: 'clientNewRoom',
  CLIENT_DISCONNECTING: 'clientDisconnecting',
  SERVER_MESSAGE: 'serverMessage',
  SERVER_NEW_ROOM: 'serverNewRoom',
  SERVER_USER_LIST_UPDATE: 'serverUserListUpdate',
  INITIAL_DATA: 'initialData',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  DISCONNECTING: 'disconnecting',
  STATUS: 'status',
} as const;

export const SYSTEM_MESSAGES = {
  USER_JOINED: '<-- has entered the room',
  USER_LEFT: 'says "smell ya\' later" -->',
} as const;

