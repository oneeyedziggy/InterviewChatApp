import { UserListPanel } from '../UserListPanel';
import { ThemeToggle } from '../ThemeToggle';
import {
  SidePanel,
  PrimaryButton,
  VerticalResizableSections,
} from './LayoutPrimitives';
import { useHomePresence } from '../../contexts/home/useHomePageSelectors';

const BUILD_STAMP = process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'unknown-build';

export function HomeRightPanel() {
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
    <SidePanel>
      <VerticalResizableSections
        storageKey="home.layout.right.usersSectionPct"
        defaultTopSize={82}
        top={
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-2 flex justify-start">
              <ThemeToggle compact />
            </div>
            <UserListPanel
              currentUsername={username}
              loggedInUsers={loggedInUsers}
              activeUsers={activeUsers}
              userLastSeen={userLastSeen}
              blockedUsers={blockedUsers}
              onMessageUser={handleMessageUser}
              onSendPublicKey={handleSendPublicKeyToUser}
              onBlockUser={handleBlockUser}
              onUnblockUser={handleUnblockUser}
            />
          </div>
        }
        bottom={
          <div className="flex h-full min-h-0 flex-col gap-2 border-t border-app-border pt-2">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeJoinRequests
                .filter((req) => req.room === currentRoom)
                .map((req) => (
                  <div
                    key={`${req.room}:${req.requestingUser}`}
                    className="mb-2 rounded-md border border-app-border bg-amber-100 p-2"
                  >
                    <div className="mb-2 text-xs text-app-fg">
                      {req.requestingUser} would like to join
                    </div>
                    <div className="flex gap-2">
                      <PrimaryButton
                        type="button"
                        onClick={() =>
                          handleVoteJoin(req.requestingUser, req.room, true)
                        }
                        className="flex-1 bg-emerald-600 px-2 py-1 text-xs"
                      >
                        Accept
                      </PrimaryButton>
                      <PrimaryButton
                        type="button"
                        onClick={() =>
                          handleVoteJoin(req.requestingUser, req.room, false)
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
          </div>
        }
      />
    </SidePanel>
  );
}
