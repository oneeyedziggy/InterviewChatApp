import { type Message } from '../../../types/types';
import { SOCKET_EVENTS } from '../../../constants';
import { getBlockedUsers } from '../../userSettings';
import { filterRoomsForUser } from '../../dmRooms';
import {
  applyEncryptedRoomDirectory,
  applyEncryptedUserDirectory,
} from '../identityDirectory';
import {
  ensureMessageId,
  scrubMessagesForLocalState,
  upsertPreservingReplyTo,
} from '../messageState';
import {
  buildCandidateRooms,
  mergeRoomsIntoList,
  normalizeIncomingRoomKey,
  normalizeRoomListEntries,
  resolveFallbackRoom,
} from '../roomKeys';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

export const registerNewRoomHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const {
    username,
    getRoomList,
    getCurrentRoom,
    setChatValues,
    setRoomList,
    setCurrentRoom,
  } = ctx;

  on(
    SOCKET_EVENTS.SERVER_NEW_ROOM,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_NEW_ROOM, async (data) => {
      const roomsBeforeUpdate = new Set(getRoomList());
      if ((await applyEncryptedRoomDirectory(data)) > 0) {
        ctx.reconcileCurrentRoomWithResolvedName('SERVER_NEW_ROOM');
      }
      if ((await applyEncryptedUserDirectory(data)) > 0) {
        ctx.refreshDisplayedUserLists();
      }

      if (data?.messages) {
        // Merge into existing history to avoid truncating loaded messages.
        setChatValues((prev) => {
          const merged = { ...prev };
          const blockedUsers = new Set(getBlockedUsers());
          const candidateRooms = buildCandidateRooms(
            Object.keys(prev),
            getRoomList(),
          );
          for (const [room, rawMessages] of Object.entries(data.messages)) {
            const normalizedRoom = normalizeIncomingRoomKey(
              room,
              candidateRooms,
              rawMessages as Message[],
            );
            const incomingMessages = scrubMessagesForLocalState(
              (rawMessages as Message[]).map((msg) => ensureMessageId(msg)),
              blockedUsers,
            );
            merged[normalizedRoom] = merged[normalizedRoom]
              ? scrubMessagesForLocalState(
                  upsertPreservingReplyTo(
                    merged[normalizedRoom],
                    incomingMessages,
                  ),
                  blockedUsers,
                )
              : incomingMessages;
          }
          return merged;
        });
      }

      if (Array.isArray(data?.rooms) && data.rooms.length > 0) {
        const nextRooms = filterRoomsForUser(data.rooms, username).map((room) =>
          normalizeIncomingRoomKey(room, data.rooms as string[]),
        );
        setRoomList((prev) => mergeRoomsIntoList(prev, nextRooms));
        const nextVisibleRooms = normalizeRoomListEntries([
          ...getRoomList(),
          ...nextRooms,
        ]);
        const newlyAddedRoom = nextRooms.find(
          (room) => !roomsBeforeUpdate.has(room),
        );
        if (newlyAddedRoom) {
          setCurrentRoom(newlyAddedRoom);
        }
        if (!nextVisibleRooms.includes(getCurrentRoom())) {
          setCurrentRoom(resolveFallbackRoom(nextVisibleRooms));
        }
      }
    }),
  );
};
