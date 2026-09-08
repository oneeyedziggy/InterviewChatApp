import { apiPath } from '@/utils/appPaths';
import {
  attemptAutoRelogin,
  fetchServerPublicKey,
  hasValidStoredKeys,
  loadKeysAsync,
  updateStoredSessionForUser,
} from './gpg';
import { storeIdentityDirectories } from './identityMap';
import { loadServerMembershipsAsync } from './serverRegistry';

type InitializeSession = (
  sessionIdToVerify: string,
  usernameToSet: string,
) => void;

type RestoreSessionOptions = {
  isCancelled: () => boolean;
  initializeSession: InitializeSession;
  onForceReauth: () => void;
};

const sessionIdPreview = (value?: string) =>
  value ? `${value.slice(0, 8)}…(len ${value.length})` : '<empty>';

const activeServerIdFromUrl = () =>
  typeof window === 'undefined'
    ? ''
    : new URLSearchParams(window.location.search).get('server') || '';

const attemptAutoReloginWithRetry = async (): Promise<string | null> => {
  const firstAttempt = await attemptAutoRelogin();
  if (firstAttempt) {
    return firstAttempt;
  }

  console.warn('[Home] Auto-relogin failed once; retrying once before re-auth');
  return attemptAutoRelogin();
};

export const restoreSession = async ({
  isCancelled,
  initializeSession,
  onForceReauth,
}: RestoreSessionOptions): Promise<void> => {
  const storedKeys = await loadKeysAsync();
  const keysValid = await hasValidStoredKeys();
  console.log('[Home] restoreSession snapshot:', {
    activeServerId: activeServerIdFromUrl(),
    username: storedKeys?.username,
    userId: storedKeys?.userId,
    sessionId: sessionIdPreview(storedKeys?.sessionId),
    hasPrivateKey: !!storedKeys?.privateKey,
    keysValid,
  });

  if (!keysValid) {
    console.warn(
      '[Home] Forcing re-auth: no valid unlocked private key for the current account',
      {
        reason: storedKeys
          ? 'private key present but failed openpgp.readPrivateKey validation'
          : 'loadKeysAsync() returned null (missing username/metadata/cached private key)',
        username: storedKeys?.username,
      },
    );
    onForceReauth();
    return;
  }

  if (!storedKeys?.sessionId) {
    // An unlocked account with no server memberships stays on the home shell
    // so the user can create or join a server.
    const memberships = await loadServerMembershipsAsync();
    if (memberships.length === 0) {
      console.log(
        '[Home] No sessionId and no server memberships yet; staying on home shell',
      );
      return;
    }
    console.warn(
      '[Home] Forcing re-auth: account has server memberships but no sessionId for this server',
      { activeServerId: activeServerIdFromUrl(), memberships },
    );
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
      console.warn('[Home] /api/auth request failed; attempting auto-relogin', {
        status: resp.status,
        activeServerId: activeServerIdFromUrl(),
        sessionId: sessionIdPreview(storedKeys.sessionId),
      });
      const newSessionId = await attemptAutoReloginWithRetry();
      if (newSessionId && !isCancelled()) {
        console.log('[Home] Auto-relogin succeeded after /api/auth failure:', {
          newSessionId: sessionIdPreview(newSessionId),
        });
        initializeSession(newSessionId, storedKeys.username);
      } else {
        console.warn(
          '[Home] Forcing re-auth: /api/auth request failed and auto-relogin did not produce a session',
        );
        onForceReauth();
      }
      return;
    }

    const data = await resp.json();
    if (!data || !data.valid) {
      console.warn(
        '[Home] Session invalid on server; attempting auto-relogin',
        {
          activeServerId: activeServerIdFromUrl(),
          sessionId: sessionIdPreview(storedKeys.sessionId),
          serverResponse: data,
        },
      );
      const newSessionId = await attemptAutoReloginWithRetry();
      if (newSessionId && !isCancelled()) {
        console.log(
          '[Home] Auto-relogin succeeded after server rejected sessionId:',
          { newSessionId: sessionIdPreview(newSessionId) },
        );
        initializeSession(newSessionId, storedKeys.username);
      } else {
        console.warn(
          '[Home] Forcing re-auth: /api/auth reported the session invalid and auto-relogin did not produce a session',
        );
        onForceReauth();
      }
      return;
    }

    if (!isCancelled()) {
      if (data.userId && storedKeys.username) {
        storeIdentityDirectories({
          userDirectory: { [data.userId]: storedKeys.username },
          currentUserId: data.userId,
        });
        const activeServerId = activeServerIdFromUrl();
        let serverPublicKey = storedKeys.serverPublicKey;
        if (activeServerId && !serverPublicKey) {
          serverPublicKey = await fetchServerPublicKey();
        }
        await updateStoredSessionForUser({
          username: storedKeys.username,
          sessionId: storedKeys.sessionId,
          userId: data.userId,
          serverPublicKey,
        });
      }
      initializeSession(storedKeys.sessionId, storedKeys.username);
    }
  } catch (err) {
    console.error(
      '[Home] Failed to verify session with server (network/exception); attempting auto-relogin:',
      err,
    );
    const newSessionId = await attemptAutoReloginWithRetry();
    if (newSessionId && !isCancelled()) {
      console.log('[Home] Auto-relogin succeeded after /api/auth exception:', {
        newSessionId: sessionIdPreview(newSessionId),
      });
      initializeSession(newSessionId, storedKeys.username);
    } else {
      console.warn(
        '[Home] Forcing re-auth: /api/auth request threw and auto-relogin did not produce a session',
      );
      onForceReauth();
    }
  }
};
