import { SOCKET_EVENTS } from '../../../constants';
import { loadUserPublicKeyEntries, storeUserPublicKeys } from '../../gpg';
import {
  getUsernameByUserId,
  requireUserIdByUsername,
} from '../../identityMap';
import { isSyntheticSystemDmRoom, normalizeRoomListEntries } from '../roomKeys';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

const pickString = (
  primary: unknown,
  fallback: Record<string, unknown>,
  key: string,
): string =>
  (typeof primary === 'string' && primary) ||
  (typeof fallback[key] === 'string' ? (fallback[key] as string) : '');

export const registerAccessRequestHandlers = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  const { username, setRoomList, setCurrentRoom } = ctx;

  // Shows the request in a DM named after the other user.
  on(
    SOCKET_EVENTS.SERVER_ACCESS_REQUEST,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_ACCESS_REQUEST, (data) => {
      if (!data?.requestAccess) {
        return;
      }
      const requestAccess = data.requestAccess as Record<string, unknown>;
      const requestingUserId = pickString(
        data.requestingUserId,
        requestAccess,
        'requestingUserId',
      );
      const originalSenderId = pickString(
        data.originalSenderId,
        requestAccess,
        'originalSenderId',
      );
      const requestingUser =
        (requestingUserId
          ? getUsernameByUserId(requestingUserId)
          : undefined) || requestingUserId;
      // Server picks the room name per recipient (original sender sees @requestingUser).
      const dmRoom = data?.requestRoom;

      if (!dmRoom) {
        console.warn(
          '[AccessRequest] ⚠ No requestRoom provided in SERVER_ACCESS_REQUEST',
        );
        return;
      }

      if (!requestingUserId || !originalSenderId) {
        console.warn(
          '[AccessRequest] ⚠ Missing sender ids in SERVER_ACCESS_REQUEST',
        );
        return;
      }

      if (data?.requestingUserPubKey && requestingUser) {
        const userPubKeys = loadUserPublicKeyEntries() || {};
        userPubKeys[requestingUser] = {
          publicKey: data.requestingUserPubKey,
          updatedAt:
            typeof data.requestingUserPubKeyUpdatedAt === 'number'
              ? data.requestingUserPubKeyUpdatedAt
              : undefined,
          blocked: !!userPubKeys[requestingUser]?.blocked,
        };
        storeUserPublicKeys(userPubKeys);
      } else {
        console.warn(
          '[AccessRequest] ⚠ No public key provided for requesting user:',
          requestingUser,
        );
      }

      // Only the original sender adds the room here; the requester gets it via SERVER_MESSAGE.
      if (originalSenderId === requireUserIdByUsername(username)) {
        setRoomList((prev) => {
          if (isSyntheticSystemDmRoom(dmRoom) || prev.includes(dmRoom)) {
            return prev;
          }
          return normalizeRoomListEntries([...prev, dmRoom]);
        });
        setCurrentRoom(dmRoom);
      }
    }),
  );

  on(
    SOCKET_EVENTS.SERVER_ACCESS_DENIED,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_ACCESS_DENIED, (data) => {
      if (data?.accessDenied) {
        alert(
          `Access to your message in ${data.accessDenied.originalRoom} was denied by the original sender.`,
        );
      }
    }),
  );
};
