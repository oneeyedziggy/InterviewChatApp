import { SOCKET_EVENTS } from '../../../constants';
import { loadKeysAsync } from '../../gpg';
import { requireUserIdByUsername } from '../../identityMap';
import { sessionIdPreview } from '../../homeSession';
import { type HomeSocketContext, type RegisterListener } from './context';

const USER_MESSAGES_BY_CODE = new Map<string, string>([
  ['session_expired', 'Session expired. Please log in again.'],
  ['unauthorized', 'Unauthorized action.'],
  ['not_owner', 'You can only edit or delete your own messages.'],
  [
    'room_exists',
    'A room with that name already exists. Please choose a different room name.',
  ],
]);

const logAuthDiagnostics = async (
  ctx: HomeSocketContext,
  action: string,
  code: string,
) => {
  const { username, authToken } = ctx;
  const keys = await loadKeysAsync();
  console.warn(
    '[ActionResult] Auth diagnostic snapshot at time of rejection (compare against server "[auth]"/"session mismatch" logs to see which sessionId/userId pairing the server actually has on file):',
    {
      action,
      code,
      contextUsername: username,
      authTokenPreview: sessionIdPreview(authToken),
      'keys.userId (from loadKeysAsync)': keys?.userId,
      'keys.sessionId (from loadKeysAsync, per-server)': sessionIdPreview(
        keys?.sessionId,
      ),
      'requireUserIdByUsername(username)': username
        ? requireUserIdByUsername(username)
        : '<no username>',
      activeServerIdInUrl:
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('server')
          : undefined,
    },
  );
};

export const registerActionResultHandler = (
  ctx: HomeSocketContext,
  on: RegisterListener,
) => {
  on(SOCKET_EVENTS.SERVER_ACTION_RESULT, async (result) => {
    const action = result?.action || 'action';
    const success = !!result?.success;
    const code = result?.code || 'unknown';
    const message = result?.message || 'Request failed';

    if (success) {
      console.log(`[ActionResult] ${action} success: ${message}`);
      return;
    }

    if (action === 'identityRefresh') {
      console.warn(
        '[ActionResult] Identity refresh was not accepted; continuing authenticated session',
        { code, message },
      );
      return;
    }

    alert(USER_MESSAGES_BY_CODE.get(code) ?? `${action} failed: ${message}`);
    console.warn('[ActionResult] rejected:', { action, code, message });
    if (code === 'unauthorized' || code === 'session_expired') {
      await logAuthDiagnostics(ctx, action, code);
    }
  });
};
