import { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { ScrollableDiv } from './styled/ScrollableDiv';
import { ConfirmPopover } from './ConfirmPopover';
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

const UserRow = styled.div<{ $isSelf?: boolean; $loggedIn?: boolean; $blocked?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #556;
  background-color: ${(p) => (p.$isSelf ? '#aab' : '#fffff00')};
  color: ${(p) => (p.$blocked ? '#bbb' : p.$loggedIn ? '#000' : '#999')};
  font-weight: ${(p) => (p.$isSelf ? 700 : p.$loggedIn ? 400 : 300)};
  margin: 0;
  padding: 2px 4px 2px 5px;
  font-size: 12px;
  position: relative;
`;

const UserName = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ContextMenu = styled.div`
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 999;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  min-width: 140px;
`;

const MenuItem = styled.button`
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: white;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: #f0f0f0;
  }

  &:not(:last-child) {
    border-bottom: 1px solid #eee;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const isSelf = user === currentUsername;

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const openConfirm = (type: 'block' | 'sendKey', e: React.MouseEvent) => {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuOpen(false);
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
    <UserRow ref={rowRef} $loggedIn={loggedIn} $blocked={blocked}>
      <UserName>
        {user} {blocked ? '🚫' : loggedIn ? '🟢' : '⚫'}
      </UserName>
      <MenuButton
        type="button"
        aria-label={`Actions for ${user}`}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
      >
        ⋯
      </MenuButton>
      {menuOpen && (
        <ContextMenu onMouseDown={(e) => e.stopPropagation()}>
          <MenuItem
            type="button"
            onClick={() => {
              setMenuOpen(false);
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
        </ContextMenu>
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
    [userLastSeen]
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
      <ScrollableDiv $padding="0px">
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
