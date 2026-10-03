import { SOCKET_EVENTS } from '../../../constants';
import type { JoinRequest } from '../../../contexts/home/homePageTypes';
import { getUsernameByUserId } from '../../identityMap';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

const isSameRequest = (
  req: JoinRequest,
  requestingUserId: string,
  roomId: string,
) => req.requestingUserId === requestingUserId && req.roomId === roomId;

export const registerJoinRequestHandlers = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const { setActiveJoinRequests, setRoomMembers } = ctx;

  const removeJoinRequest = (requestingUserId: string, roomId: string) =>
    setActiveJoinRequests((prev) =>
      prev.filter((req) => !isSameRequest(req, requestingUserId, roomId)),
    );

  on(
    SOCKET_EVENTS.SERVER_JOIN_REQUEST,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_JOIN_REQUEST, (data) => {
      if (
        data?.type !== 'joinRequest' ||
        !data?.requestingUserId ||
        !data?.room ||
        !data?.roomId
      ) {
        return;
      }
      const requestingUser =
        getUsernameByUserId(data.requestingUserId) || data.requestingUserId;

      setActiveJoinRequests((prev) =>
        prev.some((req) =>
          isSameRequest(req, data.requestingUserId, data.roomId),
        )
          ? prev
          : [
              ...prev,
              {
                requestingUserId: data.requestingUserId,
                requestingUser,
                roomId: data.roomId,
                room: data.room,
                timestamp: data.timestamp || Date.now(),
              },
            ],
      );
    }),
  );

  on(
    SOCKET_EVENTS.SERVER_JOIN_APPROVED,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_JOIN_APPROVED, (data) => {
      if (
        data?.type !== 'joinApproved' ||
        !data?.requestingUserId ||
        !data?.roomId
      ) {
        return;
      }
      removeJoinRequest(data.requestingUserId, data.roomId);
      setRoomMembers((prev) => {
        const updated = { ...prev };
        if (!updated[data.roomId]) {
          updated[data.roomId] = new Set();
        }
        updated[data.roomId].add(data.requestingUserId);
        return updated;
      });
    }),
  );

  on(
    SOCKET_EVENTS.SERVER_JOIN_DENIED,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_JOIN_DENIED, (data) => {
      if (
        data?.type === 'joinDenied' &&
        data?.requestingUserId &&
        data?.roomId
      ) {
        removeJoinRequest(data.requestingUserId, data.roomId);
      }
    }),
  );
};
