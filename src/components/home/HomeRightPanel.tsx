import { UserListPanel } from '../UserListPanel';
import { ThemeToggleStretch } from '../ThemeToggle';
import Link from 'next/link';
import {
  SidePanel,
  PrimaryButton,
  MobilePanelHeader,
  VerticalResizableSections,
} from './LayoutPrimitives';
import { useHomePresence } from '../../contexts/home/useHomePageSelectors';
import { withBasePath } from '@/utils/appPaths';
import { InviteDialog } from '../InviteDialog';
import { AppModal } from '../AppModal';
import { useState } from 'react';

const BUILD_STAMP = process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'unknown-build';
const rightSidebarSectionTitleStyle = {
  color: 'var(--app-muted)',
  fontSize: '12px',
  fontWeight: 700,
  letterSpacing: '0.02em',
  textTransform: 'uppercase' as const,
  whiteSpace: 'nowrap' as const,
};

export const HomeRightPanel = () => {
  const [keyTransferUser, setKeyTransferUser] = useState<string | null>(null);
  const [keyTransferPassword, setKeyTransferPassword] = useState('');
  const [isKeyTransferPending, setIsKeyTransferPending] = useState(false);
  const {
    username,
    loggedInUsers,
    activeUsers,
    userLastSeen,
    blockedUsers,
    activeJoinRequests,
    currentRoom,
    handleMessageUser,
    handleSendPublicKeyToUser,
    handleBlockUser,
    handleUnblockUser,
    handleVoteJoin,
    handleLogout,
  } = useHomePresence();

  return (
    <SidePanel aria-label="Users, logout, and additional info panel">
      <MobilePanelHeader title="People" previousSlide={1} />
      <VerticalResizableSections
        storageKey="home.layout.right.usersSectionPct"
        defaultTopSize={82}
        top={
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-2 flex items-center gap-2 pr-1">
              <span style={rightSidebarSectionTitleStyle}>Theme</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ThemeToggleStretch compact />
              </div>
            </div>
            <div style={{ marginBottom: '5px' }}>
              <span style={rightSidebarSectionTitleStyle}>Users</span>
            </div>
            <div className="mb-2">
              <InviteDialog />
            </div>
            <UserListPanel
              currentUsername={username}
              loggedInUsers={loggedInUsers}
              activeUsers={activeUsers}
              userLastSeen={userLastSeen}
              blockedUsers={blockedUsers}
              onMessageUser={handleMessageUser}
              onSendPublicKey={(user) => {
                setKeyTransferPassword('');
                setKeyTransferUser(user);
              }}
              onBlockUser={handleBlockUser}
              onUnblockUser={handleUnblockUser}
            />
            <AppModal
              open={!!keyTransferUser}
              title="Verify your password"
              onClose={() => {
                if (!isKeyTransferPending) setKeyTransferUser(null);
              }}
              actions={
                <>
                  <button
                    type="button"
                    className="app-secondary-button"
                    onClick={() => setKeyTransferUser(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="app-primary-button"
                    disabled={!keyTransferPassword || isKeyTransferPending}
                    onClick={() => {
                      if (!keyTransferUser) return;
                      void (async () => {
                        setIsKeyTransferPending(true);
                        await handleSendPublicKeyToUser(
                          keyTransferUser,
                          keyTransferPassword,
                        );
                        setIsKeyTransferPending(false);
                        setKeyTransferPassword('');
                        setKeyTransferUser(null);
                      })();
                    }}
                  >
                    {isKeyTransferPending ? 'Verifying...' : 'Verify and send'}
                  </button>
                </>
              }
            >
              <p className="app-dialog-message">
                Re-enter your AES password to authorize sending this encrypted
                private-key bundle.
              </p>
              <input
                className="app-text-input app-dialog-password-input"
                type="password"
                autoFocus
                value={keyTransferPassword}
                onChange={(event) => setKeyTransferPassword(event.target.value)}
                aria-label="AES password"
              />
            </AppModal>
          </div>
        }
        bottom={
          <div className="flex h-full min-h-0 flex-col gap-2 border-t border-app-border pt-2">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeJoinRequests
                .filter((req) => req.room === currentRoom)
                .map((req) => (
                  <div
                    key={`${req.roomId}:${req.requestingUserId}`}
                    className="mb-2 rounded-md border border-app-border bg-amber-100 p-2"
                  >
                    <div className="mb-2 text-xs text-app-fg">
                      {req.requestingUser} would like to join
                    </div>
                    <div className="flex gap-2">
                      <PrimaryButton
                        type="button"
                        onClick={() =>
                          handleVoteJoin(
                            req.requestingUserId,
                            req.requestingUser,
                            req.roomId,
                            req.room,
                            true,
                          )
                        }
                        className="flex-1 bg-emerald-600 px-2 py-1 text-xs"
                      >
                        Accept
                      </PrimaryButton>
                      <PrimaryButton
                        type="button"
                        onClick={() =>
                          handleVoteJoin(
                            req.requestingUserId,
                            req.requestingUser,
                            req.roomId,
                            req.room,
                            false,
                          )
                        }
                        className="flex-1 bg-red-500 px-2 py-1 text-xs"
                      >
                        Deny
                      </PrimaryButton>
                    </div>
                  </div>
                ))}
            </div>
            <PrimaryButton
              type="button"
              onClick={() => void handleLogout()}
              className="w-full bg-red-600"
            >
              Logout
            </PrimaryButton>
            <div className="text-center text-[11px] font-semibold text-app-muted">
              Build: {BUILD_STAMP}
            </div>
            <div className="flex justify-end">
              <Link
                href={withBasePath('/diagrams/')}
                className="inline-flex items-center rounded-md border border-app-border bg-app-surface px-2 py-1 text-[11px] font-semibold text-app-muted transition-colors duration-150 hover:bg-app-panel hover:text-app-fg"
              >
                Architecture diagrams
              </Link>
            </div>
          </div>
        }
      />
    </SidePanel>
  );
};
