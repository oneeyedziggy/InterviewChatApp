import { type Message, type Messages } from '../../../types/types';
import { SOCKET_EVENTS } from '../../../constants';
import { loadKeysAsync, storeUserPublicKeys } from '../../gpg';
import {
  getCurrentUserId,
  getRoomIdByName,
  getRoomNameByRoomId,
  requireUserIdByUsername,
  storeIdentityDirectories,
} from '../../identityMap';
import { getBlockedUsers } from '../../userSettings';
import { filterRoomsForUser } from '../../dmRooms';
import {
  applyEncryptedRoomDirectory,
  applyEncryptedUserDirectory,
  maybeSendIdentityDirectoryRefresh,
} from '../identityDirectory';
import {
  decryptIncomingMessage,
  filterBlockedAuthors,
  scrubMessagesForLocalState,
  upsertByIdentity,
} from '../messageState';
import {
  normalizeIncomingRoomKey,
  normalizeRoomListEntries,
  resolvePersistedCurrentRoom,
  toDisplayUsers,
} from '../roomKeys';
import { ensureDefaultRoomExists } from '../outboundMutations';
import { dispatchRoomWindowLoaded } from '../events';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

const applyInitialMessages = async (ctx: HomeSocketContext, data: any) => {
  const { username, getRoomList, setChatValues } = ctx;
  const keys = await loadKeysAsync();
  const currentUserId = username ? requireUserIdByUsername(username) : '';
  const decryptedMessages: Messages = {};
  const blockedUsers = new Set(getBlockedUsers());
  const scopedRoomsForFallback = normalizeRoomListEntries(
    Array.isArray(data.rooms)
      ? filterRoomsForUser(data.rooms, username)
      : getRoomList(),
  );

  for (const [room, messages] of Object.entries(data.messages)) {
    const normalizedRoom = normalizeIncomingRoomKey(
      room,
      scopedRoomsForFallback,
    );
    const decryptedForRoom = await Promise.all(
      filterBlockedAuthors(messages as Message[], blockedUsers).map((msg) =>
        decryptIncomingMessage(msg, keys, currentUserId, {
          normalizeDecrypted: true,
        }),
      ),
    );
    decryptedMessages[normalizedRoom] = scrubMessagesForLocalState(
      [...(decryptedMessages[normalizedRoom] || []), ...decryptedForRoom],
      blockedUsers,
    );
  }

  console.log(
    '[Socket] ✓ Setting chat values, count:',
    Object.keys(decryptedMessages).length,
  );
  setChatValues((prev) => {
    const merged = { ...prev };
    for (const [room, incoming] of Object.entries(decryptedMessages)) {
      merged[room] = upsertByIdentity(merged[room] || [], incoming);
    }
    return merged;
  });

  if (data.messageWindowDirection) {
    dispatchRoomWindowLoaded({
      direction: data.messageWindowDirection,
      room: data.messageWindow?.room,
      hasMore: data.messageWindow?.hasMore,
    });
  }
};

const applyInitialRooms = (ctx: HomeSocketContext, rooms: string[]) => {
  const { username, session, getCurrentRoom, setRoomList, setCurrentRoom } =
    ctx;
  const scopedRooms = filterRoomsForUser(rooms, username).map((room) =>
    normalizeIncomingRoomKey(room, rooms),
  );
  const normalizedRooms = normalizeRoomListEntries(scopedRooms).map(
    (room) => getRoomNameByRoomId(room) || room,
  );
  console.log('[Socket] ✓ Setting room list:', normalizedRooms.length);
  setRoomList(normalizedRooms);
  const resolvedCurrentRoom = resolvePersistedCurrentRoom(
    normalizedRooms,
    session.preferredRoomFromPrefs,
    getCurrentRoom(),
  );
  const canonicalCurrentRoom =
    getRoomNameByRoomId(resolvedCurrentRoom) || resolvedCurrentRoom;
  if (canonicalCurrentRoom !== getCurrentRoom()) {
    setCurrentRoom(canonicalCurrentRoom);
  }
};

const requestCurrentRoomData = async (
  ctx: HomeSocketContext,
  currentUserIdHint: string | undefined,
) => {
  const keys = await loadKeysAsync();
  const currentRoom = ctx.getCurrentRoom();
  const roomId = getRoomIdByName(currentRoom);
  const currentUserId = currentUserIdHint || getCurrentUserId();
  if (keys?.sessionId && currentUserId && currentRoom && roomId) {
    ctx.socket.emit(SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA, {
      username: ctx.username,
      userId: currentUserId,
      sessionId: keys.sessionId,
      room: currentRoom,
      roomId,
    });
  }
};

export const registerInitialDataHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const {
    socket,
    authToken,
    username,
    setUserList,
    setLoggedInUsers,
    setActiveUsers,
  } = ctx;

  on(
    SOCKET_EVENTS.INITIAL_DATA,
    withVerifiedPayload(SOCKET_EVENTS.INITIAL_DATA, async (data) => {
      console.log('[Socket] ===== INITIAL_DATA RECEIVED =====');

      const decryptedRoomCount = await applyEncryptedRoomDirectory(data);
      const decryptedUserCount = await applyEncryptedUserDirectory(data);
      console.log(
        '[Socket] Decrypted identity directories from INITIAL_DATA:',
        { roomNames: decryptedRoomCount, userNames: decryptedUserCount },
      );

      if (data?.userPubKeys) {
        await maybeSendIdentityDirectoryRefresh({
          socket,
          authToken,
          username,
          incomingUserPubKeys: data.userPubKeys,
        });
      }

      if (data?.currentUserId) {
        storeIdentityDirectories({ currentUserId: data.currentUserId });
      }

      if (data?.userPubKeys) {
        storeUserPublicKeys(
          data.userPubKeys,
          (data.userPubKeysUpdatedAt as Record<string, number>) || undefined,
        );
      } else {
        console.warn('[Socket] ✗ No userPubKeys in INITIAL_DATA');
      }

      if (data?.messages) {
        await applyInitialMessages(ctx, data);
      } else {
        console.warn('[Socket] ✗ No messages in INITIAL_DATA');
      }

      if (data?.rooms) {
        applyInitialRooms(ctx, data.rooms as string[]);
      } else {
        console.warn('[Socket] ✗ No rooms in INITIAL_DATA');
      }

      ctx.refreshDisplayedUserLists();

      if (data?.users) {
        setUserList(toDisplayUsers(data.users));
      } else {
        console.warn('[Socket] ✗ No users in INITIAL_DATA');
      }

      if (data?.loggedInUsers || data?.activeUsers) {
        ctx.applyPresence(data.loggedInUsers, data.activeUsers);
      } else if (data?.users) {
        setLoggedInUsers(toDisplayUsers(data.users || []));
        setActiveUsers([]);
      }

      await ensureDefaultRoomExists({
        socket,
        authToken,
        username,
        roomIdsFromServer: data?.rooms,
        incomingUserPubKeys: data?.userPubKeys,
      });

      await requestCurrentRoomData(ctx, data.currentUserId);

      console.log('[Socket] ===== INITIAL_DATA PROCESSING COMPLETE =====');
    }),
  );
};
