import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import { apiPathForServer, withBasePath } from '@/utils/appPaths';
import {
  clearServerSessionForUser,
  loadKeysForServerAsync,
} from '../utils/gpg';
import { AppModal } from './AppModal';
import { ContextMenuItem, ContextMenuSurface } from './styled/ContextMenu';
import {
  CONTEXT_MENU_CLOSE_EVENT,
  closeOtherContextMenus,
} from '../utils/contextMenuEvents';
import { createServerForCurrentUser } from '../utils/serverCreation';
import { parseInviteUrl } from '../utils/inviteLinks';
import { joinServerFromInvite } from '../utils/serverJoining';
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
  const [serverInput, setServerInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const [createError, setCreateError] = useState('');
  const [serverMenu, setServerMenu] = useState<{
    membership: ServerMembership;
    anchor: DOMRect;
  } | null>(null);
  const inputValue = serverInput.trim();
  const isJoinInput = (() => {
    if (!inputValue) return false;
    try {
      parseInviteUrl(inputValue, window.location.origin);
      return true;
    } catch {
      return /^(?:[a-z][a-z\d+.-]*:|\/|\?|www\.|[^\s/]+\.[a-z]{2,}(?:[/:?#]|$))/i.test(
        inputValue,
      );
    }
  })();

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

  useEffect(() => {
    if (!serverMenu) return;
    const close = () => setServerMenu(null);
    document.addEventListener('mousedown', close);
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, close);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, close);
    };
  }, [serverMenu]);

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

  const submitServer = async () => {
    if (!inputValue || submissionPending.current) return;
    submissionPending.current = true;
    setIsSubmitting(true);
    setCreateError('');
    try {
      if (isJoinInput) {
        const invite = parseInviteUrl(inputValue, window.location.origin);
        const joined = await joinServerFromInvite(invite);
        openServer(joined.membership, {
          sessionId: joined.sessionId,
          username: joined.username,
        });
      } else {
        const created = await createServerForCurrentUser(inputValue);
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
      }
      setServerInput('');
      setIsCreateOpen(false);
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message
          : isJoinInput
            ? 'Unable to join this server.'
            : 'Unable to create a server.',
      );
    } finally {
      submissionPending.current = false;
      setIsSubmitting(false);
    }
  };

  const leaveServer = async (membership: ServerMembership) => {
    const keys = await loadKeysForServerAsync(membership.serverId);
    if (!keys?.userId || !keys.sessionId) return;
    const confirmed = window.confirm(
      'Leave this server? You will lose access to its messages, and all local data for this server will be deleted.',
    );
    if (!confirmed) return;
    const response = await fetch(
      apiPathForServer('/api/leave-server', membership.serverId),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: keys.userId,
          sessionId: keys.sessionId,
        }),
      },
    );
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
      data-labels-collapsed={collapsed}
      aria-label="Servers"
    >
      <button
        type="button"
        className="app-server-tabs-toggle"
        aria-label={
          collapsed ? 'Show server names' : 'Show server abbreviations'
        }
        title={collapsed ? 'Show server names' : 'Show server abbreviations'}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? '»' : '«'}
      </button>
      <div className="app-server-tabs-list">
        {memberships.map((membership) => {
          const isActive =
            (membership.alias || membership.serverId) === activeServerId;
          return (
            <div
              key={membership.serverId}
              className={`app-server-tab-row${isActive ? ' app-server-tab-row--active' : ''}`}
            >
              <button
                type="button"
                className={`app-server-tab${isActive ? ' app-server-tab--active' : ''}`}
                title={membership.label}
                aria-label={membership.label}
                onClick={() => openServer(membership)}
                onContextMenu={(event) => event.preventDefault()}
              >
                <span aria-hidden="true">
                  {collapsed
                    ? membership.shorthand
                    : membership.label.slice(0, 1).toUpperCase()}
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
                        (
                        {
                          unreadByServer[
                            membership.alias || membership.serverId
                          ]
                        }
                        )
                      </span>
                    )}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="app-server-tab-menu-button"
                aria-label={`Actions for ${membership.label}`}
                title={`Actions for ${membership.label}`}
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation();
                  const anchor = event.currentTarget.getBoundingClientRect();
                  setServerMenu((current) => {
                    const next =
                      current?.membership.serverId === membership.serverId
                        ? null
                        : { membership, anchor };
                    if (!current) closeOtherContextMenus();
                    return next;
                  });
                }}
              >
                <Ellipsis size={17} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="app-server-tab app-server-tab--add"
          aria-label="Add a server"
          title="Add a server"
          onClick={() => {
            setCreateError('');
            setIsCreateOpen(true);
          }}
        >
          +
        </button>
      </div>
      {serverMenu &&
        createPortal(
          <ContextMenuSurface
            $top={serverMenu.anchor.bottom + 4}
            $left={Math.max(8, serverMenu.anchor.left - 120)}
            $zIndex={12010}
            $minWidth={140}
            onMouseDown={(event: MouseEvent<HTMLElement>) =>
              event.stopPropagation()
            }
          >
            <ContextMenuItem
              type="button"
              $danger
              onClick={() => {
                const { membership } = serverMenu;
                setServerMenu(null);
                void leaveServer(membership);
              }}
            >
              Leave server
            </ContextMenuItem>
          </ContextMenuSurface>,
          document.body,
        )}
      <AppModal
        open={isCreateOpen}
        title="Add/Join a server"
        onClose={() => setIsCreateOpen(false)}
        showCloseButton
        closeDisabled={isSubmitting}
        actions={
          <button
            type="button"
            className="app-primary-button"
            disabled={!inputValue || isSubmitting}
            onClick={() => void submitServer()}
          >
            {isJoinInput
              ? isSubmitting
                ? 'Joining...'
                : 'Join server'
              : isSubmitting
                ? 'Creating...'
                : 'Create server'}
          </button>
        }
      >
        <label className="app-dialog-field">
          <span className="app-auth-label">Server name or invite link</span>
          <input
            className="app-text-input"
            autoFocus
            value={serverInput}
            disabled={isSubmitting}
            onChange={(event) => {
              setServerInput(event.target.value);
              setCreateError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && inputValue && !isSubmitting) {
                event.preventDefault();
                void submitServer();
              }
            }}
          />
        </label>
        {createError && (
          <span role="alert" className="app-auth-error">
            {createError}
          </span>
        )}
      </AppModal>
    </aside>
  );
};
