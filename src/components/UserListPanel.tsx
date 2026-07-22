import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';
import { ScrollableDiv } from './styled/ScrollableDiv';
import { ContextMenuItem, ContextMenuSurface } from './styled/ContextMenu';
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
  border: 1px solid ${(p) => (p.$blocked ? '#c8cfd9' : '#556')};
  background-color: ${(p) =>
    p.$blocked ? '#f2f4f7' : p.$isSelf ? '#b8ccee' : '#e5edf9'};
  color: ${(p) =>
    p.$blocked
      ? '#9ca8ba'
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

  &:hover {
    color: ${(p) => (p.$blocked ? '#4e5d73' : 'inherit')};
  }
`;

const UserName = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  onUnblockUser: (user: string) => void;
};

function UserListEntry({
  user,
  loggedIn,
  currentUsername,
  blocked,
  onMessageUser,
  onSendPublicKey,
  onBlockUser,
  onUnblockUser,
}: {
  user: string;
  loggedIn: boolean;
  currentUsername: string;
  blocked: boolean;
  onMessageUser: (user: string) => void;
  onSendPublicKey: (user: string) => void;
  onBlockUser: (user: string) => void;
  onUnblockUser: (user: string) => void;
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
        {user} {blocked ? '⊘' : loggedIn ? '🟢' : '⚫'}
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
          <ContextMenuSurface
            $top={menuAnchor.bottom + 4}
            $left={Math.max(8, menuAnchor.right - 140)}
            $zIndex={12010}
            $minWidth={150}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <ContextMenuItem
              type="button"
              onClick={() => {
                setMenuAnchor(null);
                onMessageUser(user);
              }}
            >
              Message
            </ContextMenuItem>
            <ContextMenuItem
              type="button"
              onClick={(e) => openConfirm('sendKey', e)}
            >
              Send private key
            </ContextMenuItem>
            {blocked ? (
              <ContextMenuItem
                type="button"
                onClick={() => {
                  setMenuAnchor(null);
                  onUnblockUser(user);
                }}
              >
                Unblock
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                type="button"
                $danger
                onClick={(e) => openConfirm('block', e)}
              >
                Block
              </ContextMenuItem>
            )}
          </ContextMenuSurface>,
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
  onUnblockUser,
}: UserListPanelProps) {
  const sortByLastSeen = useCallback(
    (a: string, b: string) => (userLastSeen[b] || 0) - (userLastSeen[a] || 0),
    [userLastSeen],
  );

  const blockedSet = new Set(blockedUsers.filter((u) => u !== 'undefined'));

  const loggedInSorted = loggedInUsers
    .filter((u) => u !== 'undefined')
    .sort(sortByLastSeen);
  const activeSorted = activeUsers
    .filter((u) => u !== 'undefined' && !loggedInUsers.includes(u))
    .sort(sortByLastSeen);

  const filteredLoggedIn = loggedInSorted.filter((u) => !blockedSet.has(u));
  const filteredActive = activeSorted.filter((u) => !blockedSet.has(u));

  const blockedFromLists = [...loggedInSorted, ...activeSorted].filter((u) =>
    blockedSet.has(u),
  );
  const blockedDetached = blockedUsers.filter(
    (u) =>
      u !== 'undefined' &&
      !loggedInSorted.includes(u) &&
      !activeSorted.includes(u),
  );
  const blockedList = Array.from(
    new Set([...blockedFromLists, ...blockedDetached]),
  ).sort(sortByLastSeen);

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
                onUnblockUser={onUnblockUser}
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
                onUnblockUser={onUnblockUser}
              />
            ))}
          </>
        )}
        {blockedList.length > 0 && (
          <>
            <SectionLabel
              style={{
                marginTop:
                  filteredLoggedIn.length > 0 || filteredActive.length > 0
                    ? '8px'
                    : '4px',
              }}
            >
              Blocked ({blockedList.length}):
            </SectionLabel>
            {blockedList.map((user) => (
              <UserListEntry
                key={user}
                user={user}
                loggedIn={false}
                currentUsername={currentUsername}
                blocked
                onMessageUser={onMessageUser}
                onSendPublicKey={onSendPublicKey}
                onBlockUser={onBlockUser}
                onUnblockUser={onUnblockUser}
              />
            ))}
          </>
        )}
        {filteredLoggedIn.length === 0 &&
          filteredActive.length === 0 &&
          blockedList.length === 0 && (
            <div style={{ fontSize: '12px', color: '#999', padding: '4px' }}>
              No users
            </div>
          )}
      </ScrollableDiv>
    </>
  );
}
