import { apiPath } from '@/utils/appPaths';
import { attemptAutoRelogin, hasValidStoredKeys, loadKeys } from './gpg';

type InitializeSession = (
  sessionIdToVerify: string,
  usernameToSet: string,
) => void;

type RestoreSessionOptions = {
  isCancelled: () => boolean;
  initializeSession: InitializeSession;
  onForceReauth: () => void;
};

export async function restoreSession({
  isCancelled,
  initializeSession,
  onForceReauth,
}: RestoreSessionOptions): Promise<void> {
  const storedKeys = loadKeys();
  const keysValid = await hasValidStoredKeys();

  if (!keysValid || !storedKeys?.sessionId) {
    onForceReauth();
    return;
  }

  try {
    const resp = await fetch(apiPath('/api/auth'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: storedKeys.sessionId }),
    });

    if (!resp.ok) {
      console.warn('[Home] /api/auth request failed; attempting auto-relogin');
      const newSessionId = await attemptAutoRelogin();
      if (newSessionId && !isCancelled()) {
        initializeSession(newSessionId, storedKeys.username);
      } else {
        onForceReauth();
      }
      return;
    }

    const data = await resp.json();
    if (!data || !data.valid) {
      console.warn('[Home] Session invalid on server; attempting auto-relogin');
      const newSessionId = await attemptAutoRelogin();
      if (newSessionId && !isCancelled()) {
        initializeSession(newSessionId, storedKeys.username);
      } else {
        console.warn('[Home] Auto-relogin failed; forcing manual re-login');
        onForceReauth();
      }
      return;
    }

    if (!isCancelled()) {
      initializeSession(storedKeys.sessionId, storedKeys.username);
    }
  } catch (err) {
    console.error('[Home] Failed to verify session with server:', err);
    const newSessionId = await attemptAutoRelogin();
    if (newSessionId && !isCancelled()) {
      initializeSession(newSessionId, storedKeys.username);
    } else {
      onForceReauth();
    }
  }
}
