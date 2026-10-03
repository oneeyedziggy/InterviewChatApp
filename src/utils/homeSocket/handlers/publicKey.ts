import { SOCKET_EVENTS } from '../../../constants';
import {
  loadKeysAsync,
  loadUserPublicKeyEntries,
  storeUserPublicKeys,
} from '../../gpg';
import {
  getRoomNameByRoomId,
  getUsernameByUserId,
  requireRoomIdByName,
  requireUserIdByUsername,
} from '../../identityMap';
import { maybeSendIdentityDirectoryRefresh } from '../identityDirectory';
import { maybeGrantNewMemberAccess } from '../outboundMutations';
import { normalizeRoomListEntries } from '../roomKeys';
import { deleteFromSet, deleteKeys } from '../unread';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

/** Unhides the key-transfer DM, flags it unread if new, and requests its data. */
const surfaceTransferDmRoom = async (
  ctx: HomeSocketContext,
  transferDmRoom: string,
) => {
  const {
    socket,
    username,
    session,
    getRoomList,
    getCurrentRoom,
    setLeftRooms,
    setHiddenDmUnreadBaseline,
    setRoomList,
    setRoomNotifications,
  } = ctx;
  session.forcedRoomPayloads.add(transferDmRoom);
  setLeftRooms((prev) => deleteFromSet(prev, [transferDmRoom]));
  setHiddenDmUnreadBaseline((prev) => deleteKeys(prev, [transferDmRoom]));

  const hadTransferRoom = getRoomList().includes(transferDmRoom);
  setRoomList((prev) =>
    prev.includes(transferDmRoom)
      ? prev
      : normalizeRoomListEntries([...prev, transferDmRoom]),
  );

  if (!hadTransferRoom && getCurrentRoom() !== transferDmRoom) {
    setRoomNotifications((prev) => ({
      ...prev,
      [transferDmRoom]: Math.max(prev[transferDmRoom] || 0, 1),
    }));
  }

  const keys = await loadKeysAsync();
  if (!keys?.sessionId) {
    return;
  }
  let roomId: string | undefined;
  try {
    roomId = requireRoomIdByName(transferDmRoom);
  } catch {
    roomId = undefined;
  }
  socket.emit(SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA, {
    userId: requireUserIdByUsername(username),
    sessionId: keys.sessionId,
    room: transferDmRoom,
    ...(roomId ? { roomId } : {}),
  });
};

const storeSenderKeyAndOnboard = async (
  ctx: HomeSocketContext,
  fromUserId: string,
  data: any,
) => {
  const { socket, authToken, username, getChatValues } = ctx;
  const userPubKeys = loadUserPublicKeyEntries() || {};
  const hadSenderKey = !!userPubKeys[fromUserId]?.publicKey;
  const nextUserPubKeys = {
    ...userPubKeys,
    [fromUserId]: {
      publicKey: data.publicKey,
      blocked: !!userPubKeys[fromUserId]?.blocked,
      blockedAt: userPubKeys[fromUserId]?.blockedAt,
      blockedBy: userPubKeys[fromUserId]?.blockedBy,
    },
  };

  storeUserPublicKeys(nextUserPubKeys, {
    [fromUserId]:
      typeof data.publicKeyUpdatedAt === 'number'
        ? data.publicKeyUpdatedAt
        : Date.now(),
  });

  if (hadSenderKey) {
    return;
  }

  await maybeSendIdentityDirectoryRefresh({
    socket,
    authToken,
    username,
    incomingUserPubKeys: nextUserPubKeys,
  });
  const grantArgs = {
    socket,
    authToken,
    username,
    newUserId: fromUserId,
    getChatValues,
  };
  await maybeGrantNewMemberAccess(grantArgs);
  // Chat state may not be hydrated yet; retry once shortly after.
  if (Object.keys(getChatValues()).length === 0) {
    window.setTimeout(() => {
      void maybeGrantNewMemberAccess(grantArgs);
    }, 1500);
  }
};

export const registerPublicKeyHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  on(
    SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED,
    withVerifiedPayload(
      SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED,
      async (data) => {
        if (typeof data?.fromUserId !== 'string' || !data?.publicKey) {
          return;
        }
        const fromUserId: string = data.fromUserId;
        const fromUser = getUsernameByUserId(fromUserId) || fromUserId;

        const transferDmRoom: string | undefined =
          typeof data.transferDmRoom === 'string' && data.transferDmRoom
            ? data.transferDmRoom
            : typeof data.transferDmRoomId === 'string'
              ? getRoomNameByRoomId(data.transferDmRoomId)
              : undefined;

        if (transferDmRoom) {
          await surfaceTransferDmRoom(ctx, transferDmRoom);
        }

        if (fromUser) {
          await storeSenderKeyAndOnboard(ctx, fromUserId, data);
        }
        console.log('[Socket] ✓ Stored public key from', fromUserId);
      },
    ),
  );
};
