import { SOCKET_EVENTS } from '../../../constants';
import { asRecord } from '../payloadGuards';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

export const registerPresenceHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  on(
    SOCKET_EVENTS.SERVER_USER_LIST_UPDATE,
    withVerifiedPayload(SOCKET_EVENTS.SERVER_USER_LIST_UPDATE, (data) => {
      const record = asRecord(data);
      if (!record || !('loggedInUsers' in record || 'activeUsers' in record)) {
        console.warn('[Socket] ✗ Invalid user list format:', data);
        return;
      }

      ctx.applyPresence(record.loggedInUsers, record.activeUsers, {
        includeUserList: true,
      });
      if (record.userLastSeen) {
        ctx.setUserLastSeen(record.userLastSeen as Record<string, number>);
      }
    }),
  );
};
