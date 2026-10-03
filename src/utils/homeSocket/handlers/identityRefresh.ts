import { SOCKET_EVENTS } from '../../../constants';
import { validateAndApplyIdentityRefresh } from '../identityDirectory';
import { normalizeRoomListEntries } from '../roomKeys';
import { withVerifiedPayload } from '../serverSignature';
import { type HomeSocketContext, type RegisterListener } from './context';

export const registerIdentityRefreshHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  on(
    SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
    withVerifiedPayload(
      SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
      async (data) => {
        const applied = await validateAndApplyIdentityRefresh(data);
        if (applied.roomApplied === 0 && applied.userApplied === 0) {
          return;
        }

        // Force a UI refresh so decrypted names replace ID fallbacks immediately.
        ctx.setRoomList((prev) => normalizeRoomListEntries(prev));
        ctx.refreshDisplayedUserLists();

        if (applied.roomApplied > 0) {
          ctx.reconcileCurrentRoomWithResolvedName(
            'identity directory refresh',
          );
        }

        console.log('[Socket] Applied identity directory refresh:', applied);
      },
    ),
  );
};
