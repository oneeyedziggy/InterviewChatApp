export const DEFAULT_ROOM = '#general';
export const VALIDATION = {
  MIN_USERNAME_LENGTH: 8,
  MIN_PASSWORD_LENGTH: 8,
} as const;

export const SOCKET_EVENTS = {
  CLIENT_MESSAGE: 'clientMessage',
  CLIENT_NEW_ROOM: 'clientNewRoom',
  CLIENT_DISCONNECTING: 'clientDisconnecting',
  CLIENT_REQUEST_ACCESS: 'clientRequestAccess',
  CLIENT_GRANT_ACCESS: 'clientGrantAccess',
  CLIENT_DENY_ACCESS: 'clientDenyAccess',
  CLIENT_LEAVE_ROOM: 'clientLeaveRoom',
  CLIENT_REJOIN_ROOM: 'clientRejoinRoom',
  CLIENT_VOTE_JOIN: 'clientVoteJoin',
  SERVER_MESSAGE: 'serverMessage',
  SERVER_NEW_ROOM: 'serverNewRoom',
  SERVER_USER_LIST_UPDATE: 'serverUserListUpdate',
  SERVER_ACCESS_REQUEST: 'serverAccessRequest',
  SERVER_ACCESS_DENIED: 'serverAccessDenied',
  SERVER_JOIN_REQUEST: 'serverJoinRequest',
  SERVER_JOIN_APPROVED: 'serverJoinApproved',
  SERVER_JOIN_DENIED: 'serverJoinDenied',
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

