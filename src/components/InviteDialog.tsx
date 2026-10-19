import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { PrimaryButton } from './home/LayoutPrimitives';
import { AppModal } from './AppModal';
import { buildInviteUrl } from '../utils/inviteLinks';
import {
  captureInviteRoute,
  inviteScopeKey,
  isInviteScopeCurrent,
  isSafeInviteUrl,
  loadInviteUrls,
  saveInviteUrls,
  type InviteUrlScope,
  type InviteUrls,
} from '../utils/inviteUrlStore';

type InviteSummary = {
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  status: string;
  usedCount: number;
};

const readInviteTime = () => Date.now() / 1000;

export const isArchivedInvite = (
  invite: Pick<InviteSummary, 'createdAt' | 'expiresAt'>,
  now: number,
): boolean =>
  Number.isFinite(invite.createdAt) &&
  Number.isFinite(invite.expiresAt) &&
  invite.createdAt > 0 &&
  invite.expiresAt > invite.createdAt &&
  now > invite.createdAt + 2 * (invite.expiresAt - invite.createdAt);

const copyUrl = async (url: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {}
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = url;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Copy failed.');
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
};

export const InviteDialog = () => {
  const [inviteUrl, setInviteUrl] = useState('');
  const [error, setError] = useState('');
  const [copiedIds, setCopiedIds] = useState<Record<string, boolean>>({});
  const [showInviteManagement, setShowInviteManagement] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [urls, setUrls] = useState<InviteUrls>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [now, setNow] = useState(readInviteTime);
  const generation = useRef(0);
  const listRequest = useRef(0);
  const alive = useRef(true);
  const localUrls = useRef<{ key: string; urls: InviteUrls }>({
    key: '',
    urls: {},
  });

  useEffect(() => {
    alive.current = true;
    const reset = () => {
      generation.current += 1;
      listRequest.current += 1;
      localUrls.current = { key: '', urls: {} };
      setInviteUrl('');
      setShowInviteManagement(false);
      setInvites([]);
      setUrls({});
      setCopiedIds({});
      setError('');
      setLoaded(false);
      setLoading(false);
      setCreating(false);
      setRevoking('');
      setArchiveOpen(false);
    };
    window.addEventListener('popstate', reset);
    window.addEventListener('storage', reset);
    return () => {
      alive.current = false;
      generation.current += 1;
      window.removeEventListener('popstate', reset);
      window.removeEventListener('storage', reset);
    };
  }, []);

  useEffect(() => {
    if (!showInviteManagement) return;
    const timer = window.setInterval(() => setNow(readInviteTime()), 60_000);
    return () => window.clearInterval(timer);
  }, [showInviteManagement]);

  const captureOperation = () => ({
    route: captureInviteRoute(),
    path: apiPath('/api/invites'),
    revokePath: apiPath('/api/invites/revoke'),
    generation: generation.current,
  });
  type Operation = ReturnType<typeof captureOperation>;
  const current = async (operation: Operation, scope?: InviteUrlScope) => {
    if (!alive.current || operation.generation !== generation.current)
      return false;
    if (scope && !(await isInviteScopeCurrent(scope))) return false;
    const route = captureInviteRoute();
    return (
      alive.current &&
      operation.generation === generation.current &&
      route.origin === operation.route.origin &&
      route.serverId === operation.route.serverId
    );
  };
  const account = async (operation: Operation) => {
    const { loadKeysAsync } = await import('../utils/gpg');
    const keys = await loadKeysAsync();
    if (!(await current(operation))) return null;
    if (!keys?.userId || !keys.sessionId)
      throw new Error('Your session has expired. Please log in again.');
    const scope = {
      origin: operation.route.origin,
      serverId: operation.route.serverId,
      userId: keys.userId,
    };
    if (!(await current(operation, scope))) return null;
    const key = inviteScopeKey(scope);
    if (localUrls.current.key !== key) {
      localUrls.current = { key, urls: {} };
      setUrls({});
      setInvites([]);
      setInviteUrl('');
      setCopiedIds({});
    }
    return { keys, scope };
  };

  const loadInvites = async (
    operation = captureOperation(),
    scope?: InviteUrlScope,
  ) => {
    const request = ++listRequest.current;
    setLoading(true);
    setLoaded(false);
    setError('');
    let activeScope = scope;
    try {
      const credentials = scope ? { scope } : await account(operation);
      if (!credentials) return;
      activeScope = credentials.scope;
      const response = await fetch(operation.path);
      if (!response.ok) throw new Error('Unable to load invites.');
      const data: unknown = await response.json();
      if (
        !Array.isArray(data) ||
        !data.every(
          (entry) =>
            entry &&
            typeof entry.inviteId === 'string' &&
            typeof entry.createdAt === 'number' &&
            typeof entry.expiresAt === 'number' &&
            typeof entry.status === 'string',
        )
      ) {
        throw new Error('Unable to load invites.');
      }
      let recovered: InviteUrls = {};
      let cacheError = '';
      try {
        recovered = await loadInviteUrls(activeScope);
      } catch {
        cacheError =
          'Saved invite URLs could not be recovered on this browser.';
      }
      if (
        !(await current(operation, activeScope)) ||
        request !== listRequest.current
      )
        return;
      const merged = { ...recovered, ...localUrls.current.urls };
      localUrls.current = { key: inviteScopeKey(activeScope), urls: merged };
      setUrls(merged);
      setInvites(
        data.sort((first, second) => second.createdAt - first.createdAt),
      );
      setLoaded(true);
      setError(cacheError);
    } catch (inviteError) {
      if (await current(operation, activeScope))
        setError(
          inviteError instanceof Error
            ? inviteError.message
            : 'Unable to load invites.',
        );
    } finally {
      if (
        (await current(operation, activeScope)) &&
        request === listRequest.current
      )
        setLoading(false);
    }
  };

  const createInvite = async () => {
    const operation = captureOperation();
    setCreating(true);
    setError('');
    setCopiedIds({});
    setShowInviteManagement(false);
    let scope: InviteUrlScope | undefined;
    try {
      const credentials = await account(operation);
      if (!credentials) return;
      scope = credentials.scope;
      const response = await fetch(operation.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: credentials.keys.userId,
          sessionId: credentials.keys.sessionId,
        }),
      });
      const data = (await response.json()) as {
        code?: string;
        inviteId?: string;
        error?: string;
      };
      if (
        !response.ok ||
        typeof data.code !== 'string' ||
        !data.code.trim() ||
        typeof data.inviteId !== 'string' ||
        !data.inviteId.trim() ||
        data.inviteId.length > 256
      ) {
        throw new Error(data.error || 'Unable to create invite.');
      }
      if (!(await current(operation, scope))) return;
      const defaultUrl = new URL(withBasePath('/login'), scope.origin);
      defaultUrl.searchParams.set('invite', data.code);
      const url = scope.serverId
        ? buildInviteUrl({ ...operation.route, inviteCode: data.code })
        : defaultUrl.toString();
      if (!isSafeInviteUrl(url, scope))
        throw new Error('Unable to create a valid invite URL.');
      setInviteUrl(url);
      let recovered: InviteUrls = {};
      let persistenceError = '';
      try {
        recovered = await loadInviteUrls(scope);
      } catch {
        persistenceError =
          'Saved invite URLs could not be recovered on this browser.';
      }
      if (!(await current(operation, scope))) return;
      const merged = {
        ...recovered,
        ...localUrls.current.urls,
        [data.inviteId]: url,
      };
      localUrls.current = { key: inviteScopeKey(scope), urls: merged };
      setUrls(merged);
      try {
        await saveInviteUrls(scope, merged);
      } catch {
        persistenceError =
          'Invite created, but its URL could not be saved on this browser. Copy it before closing.';
      }
      if (await current(operation, scope)) setError(persistenceError);
    } catch (inviteError) {
      if (await current(operation, scope))
        setError(
          inviteError instanceof Error
            ? inviteError.message
            : 'Unable to create invite.',
        );
    } finally {
      if (alive.current && operation.generation === generation.current)
        setCreating(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    const operation = captureOperation();
    setRevoking(inviteId);
    setError('');
    let scope: InviteUrlScope | undefined;
    try {
      const credentials = await account(operation);
      if (!credentials) return;
      scope = credentials.scope;
      const response = await fetch(operation.revokePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: credentials.keys.userId,
          sessionId: credentials.keys.sessionId,
          inviteId,
        }),
      });
      if (!response.ok) throw new Error('Unable to revoke invite.');
      if (await current(operation, scope)) await loadInvites(operation, scope);
    } catch (inviteError) {
      if (await current(operation, scope))
        setError(
          inviteError instanceof Error
            ? inviteError.message
            : 'Unable to revoke invite.',
        );
    } finally {
      if (alive.current && operation.generation === generation.current)
        setRevoking('');
    }
  };

  const copyInvite = async (id: string, url: string) => {
    const operation = captureOperation();
    try {
      const credentials = await account(operation);
      if (!credentials || !isSafeInviteUrl(url, credentials.scope)) return;
      await copyUrl(url);
      if (await current(operation, credentials.scope)) {
        setCopiedIds((previous) => ({ ...previous, [id]: true }));
        setError('');
      }
    } catch {
      if (await current(operation)) setError('Unable to copy the invite URL.');
    }
  };

  const rows = (entries: InviteSummary[]) =>
    entries.map((invite) => {
      const url = Object.hasOwn(urls, invite.inviteId)
        ? urls[invite.inviteId]
        : '';
      return (
        <li key={invite.inviteId}>
          <div className="app-invite-row-meta">
            <span>
              {invite.status} · expires{' '}
              {new Date(invite.expiresAt * 1000).toLocaleString()}
            </span>
            {invite.status === 'active' && (
              <button
                type="button"
                className="app-secondary-button"
                disabled={!!revoking || loading}
                onClick={() => void revokeInvite(invite.inviteId)}
              >
                {revoking === invite.inviteId ? 'Revoking...' : 'Revoke'}
              </button>
            )}
          </div>
          <div className="app-invite-url-row">
            {url ? (
              <input
                className="app-text-input"
                readOnly
                value={url}
                aria-label={`Invite URL ${invite.inviteId}`}
              />
            ) : (
              <span className="app-invite-unavailable">
                URL unavailable on this browser
              </span>
            )}
            <button
              type="button"
              className="app-invite-copy"
              title={copiedIds[invite.inviteId] ? 'Copied' : 'Copy invite URL'}
              aria-label={`Copy invite URL ${invite.inviteId}`}
              disabled={!url}
              onClick={() => void copyInvite(invite.inviteId, url)}
            >
              {copiedIds[invite.inviteId] ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
            </button>
            {copiedIds[invite.inviteId] && <span role="status">Copied</span>}
          </div>
        </li>
      );
    });
  const regular = invites.filter((invite) => !isArchivedInvite(invite, now));
  const archived = invites.filter((invite) => isArchivedInvite(invite, now));
  const errorMessage = error && (
    <p className="app-invite-error" role="alert">
      {error}
    </p>
  );
  const openManagement = () => {
    setNow(readInviteTime());
    setInviteUrl('');
    setShowInviteManagement(true);
    setArchiveOpen(false);
    setCopiedIds({});
    void loadInvites();
  };

  return (
    <>
      <div className="app-invite-actions">
        <PrimaryButton
          type="button"
          aria-label="Create invite"
          disabled={creating || loading || !!revoking}
          onClick={() => void createInvite()}
        >
          <span className="app-invite-action-full">
            {creating ? 'Creating...' : 'Create invite'}
          </span>
          <span className="app-invite-action-short" aria-hidden="true">
            {creating ? 'Creating...' : 'Create'}
          </span>
        </PrimaryButton>
        <button
          type="button"
          className="app-secondary-button"
          aria-label="Manage invites"
          disabled={creating}
          onClick={openManagement}
        >
          <span className="app-invite-action-full">Manage invites</span>
          <span className="app-invite-action-short" aria-hidden="true">
            Manage
          </span>
        </button>
      </div>
      {!inviteUrl && !showInviteManagement && errorMessage}
      <AppModal
        open={!!inviteUrl}
        title="Invite link"
        onClose={() => setInviteUrl('')}
        actions={
          <>
            <button
              type="button"
              className="app-invite-copy"
              aria-label="Copy invite URL"
              title={copiedIds.created ? 'Copied' : 'Copy invite URL'}
              onClick={() => void copyInvite('created', inviteUrl)}
            >
              {copiedIds.created ? (
                <Check size={18} aria-hidden="true" />
              ) : (
                <Copy size={18} aria-hidden="true" />
              )}
            </button>
            {copiedIds.created && <span role="status">Copied</span>}
            <button
              type="button"
              className="app-secondary-button"
              onClick={() => setInviteUrl('')}
            >
              Close
            </button>
          </>
        }
      >
        <p className="app-dialog-message">
          Share this link with the person joining this server.
        </p>
        <input
          className="app-text-input app-dialog-invite-url"
          readOnly
          value={inviteUrl}
          aria-label="Invite URL"
        />
        {errorMessage}
      </AppModal>
      <AppModal
        open={showInviteManagement}
        title="Manage invites"
        className="app-dialog-card--invites"
        onClose={() => setShowInviteManagement(false)}
        actions={
          <button
            type="button"
            className="app-secondary-button"
            onClick={() => setShowInviteManagement(false)}
          >
            Close
          </button>
        }
      >
        {errorMessage}
        {loading && <p role="status">Loading invites...</p>}
        {!loading && !loaded && error && (
          <button
            type="button"
            className="app-secondary-button"
            onClick={() => void loadInvites()}
          >
            Retry
          </button>
        )}
        <div
          className="app-invite-main"
          role="region"
          aria-label="Recent invites"
          aria-busy={loading}
        >
          {!loading && loaded && !invites.length && (
            <p className="app-dialog-message">No invites have been created.</p>
          )}
          {!loading && loaded && invites.length > 0 && !regular.length && (
            <p className="app-dialog-message">All invites are archived.</p>
          )}
          {!loading && loaded && regular.length > 0 && (
            <ul className="app-invite-list">{rows(regular)}</ul>
          )}
        </div>
        {!loading && loaded && archived.length > 0 && (
          <div
            className={`app-invite-archive${archiveOpen ? ' app-invite-archive--open' : ''}`}
          >
            <button
              type="button"
              className="app-invite-disclosure"
              aria-expanded={archiveOpen}
              aria-controls="older-invites"
              onClick={() => setArchiveOpen((value) => !value)}
            >
              {archiveOpen ? (
                <ChevronDown size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}{' '}
              Older invites ({archived.length})
            </button>
            {archiveOpen && (
              <div
                id="older-invites"
                className="app-invite-archive-body"
                role="region"
                aria-label="Older invites"
              >
                <ul className="app-invite-list">{rows(archived)}</ul>
              </div>
            )}
          </div>
        )}
      </AppModal>
    </>
  );
};
