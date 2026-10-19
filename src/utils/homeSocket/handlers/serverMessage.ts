import { type Message, type Messages } from '../../../types/types';
import { SOCKET_EVENTS } from '../../../constants';
import { loadKeysAsync, storeUserPublicKeys } from '../../gpg';
import {
  getUserIdByUsername,
  storeIdentityDirectories,
} from '../../identityMap';
import { getBlockedUsers } from '../../userSettings';
import { isDmRoom, isUserInDmRoom } from '../../dmRooms';
import { mergeMessageWindow } from '../../messageWindow';
import {
  applyEncryptedRoomDirectory,
  applyEncryptedUserDirectory,
  maybeSendIdentityDirectoryRefresh,
} from '../identityDirectory';
import {
  decryptIncomingMessage,
  filterBlockedAuthors,
  scrubMessagesForLocalState,
  upsertPreservingReplyTo,
} from '../messageState';
import {
  buildCandidateRooms,
  isSyntheticSystemDmRoom,
  mergeRoomsIntoList,
  normalizeIncomingRoomKey,
  normalizeRoomListEntries,
  resolveFallbackRoom,
} from '../roomKeys';
import {
  applyUnreadIncrements,
  computeUnreadIncrements,
  deleteFromSet,
  deleteKeys,
  selectDmRoomsToUnhide,
} from '../unread';
import { dispatchRoomWindowLoaded } from '../events';
import { withVerifiedPayload } from '../serverSignature';
import { handleAccessGrant } from './accessGrant';
import { type HomeSocketContext, type RegisterListener } from './context';

const touchUserLastSeen = (ctx: HomeSocketContext, messages: unknown) => {
  ctx.setUserLastSeen((prev) => {
    const updated = { ...prev };
    Object.values(messages as Record<string, unknown>).forEach(
      (roomMessages) => {
        if (!Array.isArray(roomMessages)) return;
        roomMessages.forEach((msg: Message) => {
          const userRef =
            (typeof msg.userId === 'string' && msg.userId) ||
            msg.username ||
            '';
          if (userRef) {
            updated[userRef] = Date.now();
          }
        });
      },
    );
    return updated;
  });
};

const decryptVisibleRoomMessages = async (
  ctx: HomeSocketContext,
  wireMessages: Record<string, unknown>,
): Promise<Messages> => {
  const { username, session, getLeftRooms, getRoomList } = ctx;
  const keys = await loadKeysAsync();
  const currentUserId = username
    ? keys?.userId || getUserIdByUsername(username) || ''
    : '';
  const decryptedMessages: Messages = {};
  const candidateRooms = buildCandidateRooms(getRoomList());

  for (const [room, messages] of Object.entries(wireMessages)) {
    const normalizedRoom = normalizeIncomingRoomKey(
      room,
      candidateRooms,
      messages as Message[],
    );
    const isHiddenRoom =
      getLeftRooms().has(normalizedRoom) &&
      !session.forcedRoomPayloads.has(normalizedRoom);
    // Hidden channels stay hidden; DMs can force resurfacing.
    if (isHiddenRoom && !isDmRoom(normalizedRoom)) continue;

    const visibleRoomMessages = filterBlockedAuthors(
      messages as Message[],
      new Set(getBlockedUsers()),
    );
    // Ignore updates with no visible messages (important for blocked-user DMs).
    if (visibleRoomMessages.length === 0) {
      session.forcedRoomPayloads.delete(normalizedRoom);
      continue;
    }

    const decryptedForRoom = await Promise.all(
      visibleRoomMessages.map((msg) =>
        decryptIncomingMessage(msg, keys, currentUserId, {
          normalizeDecrypted: false,
        }),
      ),
    );
    decryptedMessages[normalizedRoom] = [
      ...(decryptedMessages[normalizedRoom] || []),
      ...decryptedForRoom,
    ];
    session.forcedRoomPayloads.delete(normalizedRoom);
  }

  return decryptedMessages;
};

const unhideDmRooms = (ctx: HomeSocketContext, rooms: string[]) => {
  if (rooms.length === 0) return;
  ctx.setLeftRooms((prev) => deleteFromSet(prev, rooms));
  ctx.setHiddenDmUnreadBaseline((prev) => deleteKeys(prev, rooms));
};

const applyIncomingMessages = async (ctx: HomeSocketContext, data: any) => {
  const {
    username,
    getCurrentRoom,
    getChatValues,
    getRoomList,
    getLeftRooms,
    getRoomNotifications,
    getHiddenDmUnreadBaseline,
    setChatValues,
    setRoomNotifications,
    setRoomList,
    setCurrentRoom,
  } = ctx;
  const decryptedMessages = await decryptVisibleRoomMessages(
    ctx,
    data.messages,
  );

  // Compute unread deltas from the current snapshot before scheduling state
  // updates, so unread logic never sees an empty increment map.
  const currentRoom = getCurrentRoom();
  const unreadIncrements = computeUnreadIncrements(
    decryptedMessages,
    getChatValues(),
    currentRoom,
    new Set(getBlockedUsers()),
  );

  const mergeDirection =
    data?.messageWindowDirection === 'older' ? 'older' : 'newer';
  setChatValues((prev) => {
    const merged = { ...prev };
    const blockedUsers = new Set(getBlockedUsers());
    for (const [room, messages] of Object.entries(decryptedMessages)) {
      merged[room] = scrubMessagesForLocalState(
        merged[room]
          ? mergeMessageWindow(
              upsertPreservingReplyTo(merged[room], messages),
              [],
              mergeDirection,
            )
          : messages,
        blockedUsers,
      );
    }
    return merged;
  });

  if (data?.messageWindowDirection) {
    dispatchRoomWindowLoaded({
      direction: data.messageWindowDirection,
      room: Object.keys(data.messages)[0],
      hasMore: data.hasMore === true,
    });
  }

  const nextRoomNotifications = applyUnreadIncrements(
    getRoomNotifications(),
    unreadIncrements,
    currentRoom,
  );
  setRoomNotifications((prev) =>
    applyUnreadIncrements(prev, unreadIncrements, currentRoom),
  );

  unhideDmRooms(
    ctx,
    selectDmRoomsToUnhide({
      increments: unreadIncrements,
      nextNotifications: nextRoomNotifications,
      hiddenRooms: getLeftRooms(),
      hiddenDmUnreadBaseline: getHiddenDmUnreadBaseline(),
      username,
    }),
  );

  const roomsToList = Object.keys(decryptedMessages).filter(
    (room) =>
      !isSyntheticSystemDmRoom(room) &&
      (!isDmRoom(room) || isUserInDmRoom(room, username)),
  );
  setRoomList((prev) => mergeRoomsIntoList(prev, roomsToList));

  const nextVisibleRooms = normalizeRoomListEntries([
    ...getRoomList(),
    ...Object.keys(decryptedMessages),
  ]);
  if (!nextVisibleRooms.includes(getCurrentRoom())) {
    setCurrentRoom(resolveFallbackRoom(nextVisibleRooms));
  }
};

export const registerServerMessageHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const { socket, authToken, username, setRoomMembers, setUserLastSeen } = ctx;

  on(
    SOCKET_EVENTS.SERVER_MESSAGE,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_MESSAGE, async (data) => {
      if ((await applyEncryptedRoomDirectory(data)) > 0) {
        ctx.reconcileCurrentRoomWithResolvedName('SERVER_MESSAGE');
      }
      if ((await applyEncryptedUserDirectory(data)) > 0) {
        ctx.refreshDisplayedUserLists();
      }

      if (data?.currentUserId) {
        storeIdentityDirectories({ currentUserId: data.currentUserId });
      }

      if (data?.messages) {
        touchUserLastSeen(ctx, data.messages);
      }

      if (data?.accessGrant) {
        await handleAccessGrant(ctx, data);
        return;
      }

      if (data?.messages) {
        await applyIncomingMessages(ctx, data);
      }

      // User lists only update from explicit loggedInUsers/activeUsers payloads.
      if (
        data?.loggedInUsers !== undefined ||
        data?.activeUsers !== undefined
      ) {
        ctx.applyPresence(data.loggedInUsers, data.activeUsers, {
          includeUserList: true,
        });
      }

      if (data?.roomMembers) {
        setRoomMembers((prev) => {
          const updated = { ...prev };
          for (const [room, members] of Object.entries(data.roomMembers)) {
            updated[room] = new Set(members as string[]);
          }
          return updated;
        });
      }

      if (data?.userLastSeen) {
        setUserLastSeen(data.userLastSeen as Record<string, number>);
      }

      if (data?.userPubKeys) {
        storeUserPublicKeys(
          data.userPubKeys,
          (data.userPubKeysUpdatedAt as Record<string, number>) || undefined,
        );
        await maybeSendIdentityDirectoryRefresh({
          socket,
          authToken,
          username,
          incomingUserPubKeys: data.userPubKeys,
        });
      }
    }),
  );
};
