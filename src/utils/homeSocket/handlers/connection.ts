import {
  DEFAULT_ROOM,
  SOCKET_EVENTS,
  SYSTEM_MESSAGES,
} from '../../../constants';
import { loadKeysAsync } from '../../gpg';
import { emitSignedMutation } from '../../socketAuth';
import {
  getRoomIdByName,
  getUserIdByUsername,
  requireRoomIdByName,
  storeIdentityDirectories,
} from '../../identityMap';
import { sessionIdPreview } from '../../homeSession';
import { loadRoomPrefs } from '../../roomPrefs';
import { type HomeSocketContext, type RegisterListener } from './context';

const announcePublicKey = async (ctx: HomeSocketContext) => {
  const { socket, username, authToken } = ctx;
  const keys = await loadKeysAsync();
  console.log('[Socket] Auth snapshot on connect:', {
    username,
    authTokenPreview: sessionIdPreview(authToken),
    'keys.userId (authoritative, from loadKeysAsync)': keys?.userId,
    'keys.sessionId (per-server, from loadKeysAsync)': sessionIdPreview(
      keys?.sessionId,
    ),
    authTokenMatchesKeysSessionId: authToken === keys?.sessionId,
  });
  if (!keys?.publicKey || !username) {
    return;
  }

  const fromUserId = keys.userId || getUserIdByUsername(username);
  if (!fromUserId) {
    console.warn('[Socket] Cannot announce public key without a stored identity');
    return;
  }
  if (keys.userId) {
    storeIdentityDirectories({
      userDirectory: { [keys.userId]: username },
      currentUserId: keys.userId,
    });
  }
  await emitSignedMutation(socket, {
    event: SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY,
    payload: {
      fromUserId,
      sessionId: authToken,
      publicKey: keys.publicKey,
    },
    userId: fromUserId,
    sessionId: authToken,
    claims: {
      fromUserId,
      publicKey: keys.publicKey,
    },
  });
  console.log('[Socket] ✓ Announced public key for', username);
};

const requestInitialData = async (ctx: HomeSocketContext) => {
  const { socket, username, authToken, session } = ctx;
  const keys = await loadKeysAsync();
  const userId = keys?.userId || getUserIdByUsername(username);
  if (!userId) {
    console.warn('[Socket] Cannot request initial data without a stored identity');
    return;
  }
  const prefs = await loadRoomPrefs(username);
  const requestedCurrentRoom = prefs.currentRoom || DEFAULT_ROOM;
  session.preferredRoomFromPrefs = requestedCurrentRoom;
  const requestedOpenRooms =
    prefs.openRooms && prefs.openRooms.length > 0
      ? prefs.openRooms
      : [DEFAULT_ROOM];
  const requestedCurrentRoomId = getRoomIdByName(requestedCurrentRoom);
  const requestedOpenRoomIds = requestedOpenRooms
    .map((room) => getRoomIdByName(room))
    .filter(
      (roomId): roomId is string =>
        typeof roomId === 'string' && roomId.trim() !== '',
    );

  // Join messages are sent automatically by the server.
  socket.emit(SOCKET_EVENTS.CLIENT_REQUEST_INITIAL_DATA, {
    userId,
    sessionId: authToken,
    defaultRoom: DEFAULT_ROOM,
    currentRoom: requestedCurrentRoom,
    currentRoomId: requestedCurrentRoomId || requestedCurrentRoom,
    openRooms: requestedOpenRooms,
    openRoomIds: requestedOpenRoomIds,
  });
  console.log('[Socket] ✓ Requested filtered initial data', {
    currentRoom: requestedCurrentRoom,
    openRooms: requestedOpenRooms,
  });
};

export const registerConnectionHandlers = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const { socket, username, authToken } = ctx;

  on(SOCKET_EVENTS.CONNECT, async () => {
    console.log('[Socket] ===== CONNECTED =====', { id: socket.id });
    await announcePublicKey(ctx);
    await requestInitialData(ctx);
  });

  on(SOCKET_EVENTS.DISCONNECT, (reason) => {
    console.log('[Socket] ✗ Socket disconnected, reason:', reason, {
      id: socket.id,
    });
  });

  on(SOCKET_EVENTS.DISCONNECTING, async () => {
    const keys = await loadKeysAsync();
    if (keys?.sessionId) {
      const userId = keys.userId || getUserIdByUsername(username);
      if (!userId) {
        console.warn('[Socket] Cannot send disconnect notice without a stored identity');
        return;
      }
      const roomId = requireRoomIdByName(DEFAULT_ROOM);
      void emitSignedMutation(socket, {
        event: SOCKET_EVENTS.CLIENT_MESSAGE,
        payload: {
          userId,
          sessionId: keys.sessionId,
          room: DEFAULT_ROOM,
          roomId,
          content: SYSTEM_MESSAGES.USER_LEFT,
        },
        userId,
        sessionId: keys.sessionId,
        claims: {
          roomId,
        },
      });
    }
    socket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
  });

  on(SOCKET_EVENTS.STATUS, (msg) => {
    console.log('[Socket] STATUS received:', msg);
  });

  on('connect_error', (error: Error) => {
    console.error('[Socket] ✗ Connection error:', error);
  });

  on('error', (error) => {
    console.error('[Socket] ===== SOCKET ERROR =====', error);
  });

  on('reconnect', (attemptNumber) => {
    console.log(
      '[Socket] ✓ Socket reconnected after',
      attemptNumber,
      'attempts',
    );
    (window as any).__socket = socket;
  });

  on('reconnect_attempt', (attemptNumber) => {
    console.log('[Socket] Reconnect attempt:', attemptNumber);
  });

  on('reconnect_error', (error) => {
    console.error('[Socket] Reconnect error:', error);
  });

  on('reconnect_failed', () => {
    console.error('[Socket] ===== RECONNECT FAILED =====');
  });
};
