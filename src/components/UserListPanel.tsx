import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';
import { ScrollableDiv } from './styled/ScrollableDiv';
import { ConfirmPopover } from './ConfirmPopover';
import {
  CONTEXT_MENU_CLOSE_EVENT,
  closeOtherContextMenus,
} from '../utils/contextMenuEvents';
import { isUserBlocked } from '../utils/userSettings';

const MenuButton = styled.button`
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
  color: #555;

  &:hover {
    color: #000;
  }
`;

const UserRow = styled.div<{
  $isSelf?: boolean;
  $loggedIn?: boolean;
  $blocked?: boolean;
}>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #556;
  background-color: ${(p) => (p.$isSelf ? '#b8ccee' : '#e5edf9')};
  color: ${(p) =>
    p.$blocked
      ? '#6b7790'
      : p.$isSelf
        ? '#0c1b33'
        : p.$loggedIn
          ? '#27486c'
          : '#516b8d'};
  font-weight: ${(p) => (p.$isSelf ? 700 : p.$loggedIn ? 500 : 400)};
  margin: 0 0 2px;
  padding: 2px 4px 2px 8px;
  font-size: 12px;
  position: relative;
`;

const UserName = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ContextMenu = styled.div<{ $top: number; $left: number }>`
  position: fixed;
  left: ${(p) => `${p.$left}px`};
  top: ${(p) => `${p.$top}px`};
  z-index: 6000;
  background: #12304f;
  border: 1px solid #5d83ae;
  border-radius: 4px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
  min-width: 140px;
`;

const MenuItem = styled.button`
  display: block;
  width: 100%;
  text-align: left;
  padding: 4px 10px;
  border: none;
  background: #12304f;
  color: #c9e7ff;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;

  &:hover {
    background: #e7f1fb;
    color: #12304f;
  }

  &:not(:last-child) {
    border-bottom: 1px solid #2c537b;
  }
`;

const SectionLabel = styled.div`
  font-size: 11px;
  color: #666;
  margin-top: 4px;
  margin-bottom: 2px;
  font-weight: bold;
`;

type PendingAction =
  | { type: 'block'; user: string; anchor: DOMRect }
  | { type: 'sendKey'; user: string; anchor: DOMRect };

type UserListPanelProps = {
  currentUsername: string;
  loggedInUsers: string[];
  activeUsers: string[];
  userLastSeen: Record<string, number>;
  blockedUsers: string[];
  onMessageUser: (user: string) => void;
  onSendPublicKey: (user: string) => void;
  onBlockUser: (user: string) => void;
};

function UserListEntry({
  user,
  loggedIn,
  currentUsername,
  blocked,
  onMessageUser,
  onSendPublicKey,
  onBlockUser,
}: {
  user: string;
  loggedIn: boolean;
  currentUsername: string;
  blocked: boolean;
  onMessageUser: (user: string) => void;
  onSendPublicKey: (user: string) => void;
  onBlockUser: (user: string) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const isSelf = user === currentUsername;

  useEffect(() => {
    if (!menuAnchor) return;
    const close = () => setMenuAnchor(null);
    const closeViaSharedSignal = () => setMenuAnchor(null);
    document.addEventListener('mousedown', close);
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, closeViaSharedSignal);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener(
        CONTEXT_MENU_CLOSE_EVENT,
        closeViaSharedSignal,
      );
    };
  }, [menuAnchor]);

  const openConfirm = (type: 'block' | 'sendKey', e: React.MouseEvent) => {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuAnchor(null);
    closeOtherContextMenus();
    setPending({ type, user, anchor });
  };

  if (isSelf) {
    return (
      <UserRow $isSelf $loggedIn={loggedIn}>
        <UserName>
          {user} {loggedIn ? '🟢' : '⚫'}
        </UserName>
      </UserRow>
    );
  }

  return (
    <UserRow $loggedIn={loggedIn} $blocked={blocked}>
      <UserName>
        {user} {blocked ? '🚫' : loggedIn ? '🟢' : '⚫'}
      </UserName>
      <MenuButton
        type="button"
        aria-label={`Actions for ${user}`}
        onClick={(e) => {
          e.stopPropagation();
          const anchor = (
            e.currentTarget as HTMLElement
          ).getBoundingClientRect();
          setPending(null);
          setMenuAnchor((current) => {
            const next = current ? null : anchor;
            if (!current) {
              closeOtherContextMenus();
            }
            return next;
          });
        }}
      >
        ⋯
      </MenuButton>
      {menuAnchor &&
        createPortal(
          <ContextMenu
            $top={menuAnchor.bottom + 4}
            $left={Math.max(8, menuAnchor.right - 140)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <MenuItem
              type="button"
              onClick={() => {
                setMenuAnchor(null);
                onMessageUser(user);
              }}
            >
              Message
            </MenuItem>
            <MenuItem type="button" onClick={(e) => openConfirm('sendKey', e)}>
              Send private key
            </MenuItem>
            <MenuItem type="button" onClick={(e) => openConfirm('block', e)}>
              Block
            </MenuItem>
          </ContextMenu>,
          document.body,
        )}
      {pending?.type === 'block' && pending.user === user && (
        <ConfirmPopover
          message={`Block ${user}? You will no longer see their messages or encrypt for them.`}
          confirmLabel="Block"
          variant="danger"
          anchorRect={pending.anchor}
          onConfirm={() => {
            onBlockUser(user);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.type === 'sendKey' && pending.user === user && (
        <ConfirmPopover
          message={`Send your public key to ${user}?`}
          confirmLabel="Send"
          variant="primary"
          anchorRect={pending.anchor}
          onConfirm={() => {
            onSendPublicKey(user);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </UserRow>
  );
}

export function UserListPanel({
  currentUsername,
  loggedInUsers,
  activeUsers,
  userLastSeen,
  blockedUsers,
  onMessageUser,
  onSendPublicKey,
  onBlockUser,
}: UserListPanelProps) {
  const sortByLastSeen = useCallback(
    (a: string, b: string) => (userLastSeen[b] || 0) - (userLastSeen[a] || 0),
    [userLastSeen],
  );

  const filteredLoggedIn = loggedInUsers
    .filter((u) => u !== 'undefined')
    .sort(sortByLastSeen);
  const filteredActive = activeUsers
    .filter((u) => u !== 'undefined' && !loggedInUsers.includes(u))
    .sort(sortByLastSeen);

  return (
    <>
      <div style={{ marginBottom: '5px' }}>Users:</div>
      <ScrollableDiv $padding="0px" $border="none" $marginLeft="8px">
        {filteredLoggedIn.length > 0 && (
          <>
            <SectionLabel>Logged In ({filteredLoggedIn.length}):</SectionLabel>
            {filteredLoggedIn.map((user) => (
              <UserListEntry
                key={user}
                user={user}
                loggedIn
                currentUsername={currentUsername}
                blocked={blockedUsers.includes(user) || isUserBlocked(user)}
                onMessageUser={onMessageUser}
                onSendPublicKey={onSendPublicKey}
                onBlockUser={onBlockUser}
              />
            ))}
          </>
        )}
        {filteredActive.length > 0 && (
          <>
            <SectionLabel
              style={{
                marginTop: filteredLoggedIn.length > 0 ? '8px' : '4px',
              }}
            >
              Active (Not Logged In) ({filteredActive.length}):
            </SectionLabel>
            {filteredActive.map((user) => (
              <UserListEntry
                key={user}
                user={user}
                loggedIn={false}
                currentUsername={currentUsername}
                blocked={blockedUsers.includes(user) || isUserBlocked(user)}
                onMessageUser={onMessageUser}
                onSendPublicKey={onSendPublicKey}
                onBlockUser={onBlockUser}
              />
            ))}
          </>
        )}
        {filteredLoggedIn.length === 0 && filteredActive.length === 0 && (
          <div style={{ fontSize: '12px', color: '#999', padding: '4px' }}>
            No users
          </div>
        )}
      </ScrollableDiv>
    </>
  );
}
