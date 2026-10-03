import { useEffect, useState } from 'react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { clearServerSessionForUser, loadKeysAsync } from '../utils/gpg';
import { AppModal } from './AppModal';
import { createServerForCurrentUser } from '../utils/serverCreation';
import {
  loadServerMemberships,
  loadServerMembershipsAsync,
  serverMembershipsChangedEvent,
  removeServerMembership,
  type ServerMembership,
} from '../utils/serverRegistry';

export const ServerTabsPanel = () => {
  const [memberships, setMemberships] = useState<ServerMembership[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [activeServerId, setActiveServerId] = useState('');
  const [unreadByServer, setUnreadByServer] = useState<Record<string, number>>(
    {},
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newServerLabel, setNewServerLabel] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    const refresh = () => {
      setMemberships(loadServerMemberships());
      void loadServerMembershipsAsync().then(setMemberships);
      setActiveServerId(
        new URLSearchParams(window.location.search).get('server') || '',
      );
    };
    refresh();
    window.addEventListener(serverMembershipsChangedEvent, refresh);
    window.addEventListener('storage', refresh);
    const handleUnread = (event: Event) => {
      const detail = (
        event as CustomEvent<{ serverKey?: string; unread?: number }>
      ).detail;
      const serverKey = detail?.serverKey;
      if (!serverKey) return;
      setUnreadByServer((previous) => ({
        ...previous,
        [serverKey]: Math.max(0, detail.unread || 0),
      }));
    };
    window.addEventListener('tenant-unread-changed', handleUnread);
    return () => {
      window.removeEventListener(serverMembershipsChangedEvent, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('tenant-unread-changed', handleUnread);
    };
  }, []);

  const openServer = (
    membership: ServerMembership,
    sessionHandoff?: { sessionId: string; username: string },
  ) => {
    const server = membership.alias || membership.serverId;
    if (server === activeServerId && !sessionHandoff) {
      return;
    }
    window.history.pushState(
      {},
      '',
      `${withBasePath('/')}?server=${encodeURIComponent(server)}`,
    );
    window.dispatchEvent(
      new CustomEvent('popstate', {
        detail: sessionHandoff,
      }),
    );
    setActiveServerId(server);
  };

  const submitCreateServer = async () => {
    setIsCreating(true);
    setCreateError('');
    try {
      const created = await createServerForCurrentUser(newServerLabel);
      setNewServerLabel('');
      setIsCreateOpen(false);
      openServer(
        {
          serverId: created.serverId,
          alias: created.alias,
          label: created.label,
          username: created.username,
          userId: created.userId,
        },
        { sessionId: created.sessionId, username: created.username },
      );
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Unable to create a server.',
      );
    } finally {
      setIsCreating(false);
    }
  };

  const leaveServer = async (membership: ServerMembership) => {
    if ((membership.alias || membership.serverId) !== activeServerId) {
      openServer(membership);
      return;
    }
    const keys = await loadKeysAsync();
    if (!keys?.userId || !keys.sessionId) return;
    const confirmed = window.confirm(
      'Leave this server? You will lose access to its messages, and all local data for this server will be deleted.',
    );
    if (!confirmed) return;
    const response = await fetch(apiPath('/api/leave-server'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: keys.userId, sessionId: keys.sessionId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setCreateError(data.error || 'Unable to leave server.');
      return;
    }
    await clearServerSessionForUser(keys.username, membership.serverId);
    const remaining = removeServerMembership(membership.serverId);
    if ((membership.alias || membership.serverId) === activeServerId) {
      const next = remaining[0];
      if (next) openServer(next);
      else window.history.pushState({}, '', withBasePath('/'));
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  };

  return (
    <aside
      className={`app-server-tabs-panel${collapsed ? ' app-server-tabs-panel--collapsed' : ''}`}
      aria-label="Servers"
    >
      <button
        type="button"
        className="app-server-tabs-toggle"
        aria-label={collapsed ? 'Expand servers' : 'Collapse servers'}
        title={collapsed ? 'Expand servers' : 'Collapse servers'}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? '»' : '«'}
      </button>
      <div className="app-server-tabs-list">
        {memberships.map((membership) => (
          <button
            key={membership.serverId}
            type="button"
            className={`app-server-tab${(membership.alias || membership.serverId) === activeServerId ? ' app-server-tab--active' : ''}`}
            title={membership.label}
            aria-label={membership.label}
            onClick={() => openServer(membership)}
            onContextMenu={(event) => {
              event.preventDefault();
              void leaveServer(membership);
            }}
          >
            <span aria-hidden="true">
              {collapsed ? '🗄️' : membership.label.slice(0, 1).toUpperCase()}
            </span>
            {!collapsed && (
              <span className="app-server-tab-label">
                {membership.label}
                {(unreadByServer[membership.alias || membership.serverId] ||
                  0) > 0 && (
                  <span
                    aria-label={`${unreadByServer[membership.alias || membership.serverId]} unread messages`}
                  >
                    {' '}
                    ({unreadByServer[membership.alias || membership.serverId]})
                  </span>
                )}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="app-server-tab app-server-tab--add"
          aria-label="Create a new server"
          title="Create a new server"
          onClick={() => {
            setCreateError('');
            setIsCreateOpen(true);
          }}
        >
          +
        </button>
      </div>
      <AppModal
        open={isCreateOpen}
        title="Create a new server"
        onClose={() => setIsCreateOpen(false)}
        actions={
          <>
            <button
              type="button"
              className="app-secondary-button"
              onClick={() => setIsCreateOpen(false)}
              disabled={isCreating}
            >
              Cancel
            </button>
            <button
              type="button"
              className="app-primary-button"
              disabled={!newServerLabel.trim() || isCreating}
              onClick={() => void submitCreateServer()}
            >
              {isCreating ? 'Creating...' : 'Create server'}
            </button>
          </>
        }
      >
        <label className="app-dialog-field">
          <span className="app-auth-label">Server name</span>
          <input
            className="app-text-input"
            autoFocus
            value={newServerLabel}
            onChange={(event) => setNewServerLabel(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                newServerLabel.trim() &&
                !isCreating
              ) {
                event.preventDefault();
                void submitCreateServer();
              }
            }}
          />
        </label>
        {createError && <span className="app-auth-error">{createError}</span>}
      </AppModal>
    </aside>
  );
};
