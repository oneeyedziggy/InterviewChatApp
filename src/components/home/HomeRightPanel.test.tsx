import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeRightPanel } from './HomeRightPanel';

const presenceMock = vi.hoisted(() => ({
  useHomePresence: vi.fn(),
}));

let presenceState: any = null;

vi.mock('../../contexts/home/useHomePageSelectors', () => ({
  useHomePresence: presenceMock.useHomePresence,
}));

describe('HomeRightPanel', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as any;

    presenceState = {
      username: 'alice',
      loggedInUsers: ['alice', 'bob'],
      activeUsers: ['carol'],
      userLastSeen: { alice: 20, bob: 10, carol: 5 },
      blockedUsers: [],
      activeJoinRequests: [
        {
          room: 'general',
          roomId: 'room-1',
          requestingUser: 'dave',
          requestingUserId: 'user-dave',
        },
        {
          room: 'random',
          roomId: 'room-2',
          requestingUser: 'erin',
          requestingUserId: 'user-erin',
        },
      ],
      currentRoom: 'general',
      handleMessageUser: vi.fn(),
      handleSendPublicKeyToUser: vi.fn(),
      handleBlockUser: vi.fn(),
      handleUnblockUser: vi.fn(),
      handleVoteJoin: vi.fn(),
      handleLogout: vi.fn(),
    };
    presenceMock.useHomePresence.mockReturnValue(presenceState);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the user list and room join requests', async () => {
    const user = userEvent.setup();

    render(<HomeRightPanel />);

    expect(screen.getByText(/theme/i)).toBeInTheDocument();
    expect(screen.getByText(/users/i)).toBeInTheDocument();
    expect(screen.getByText(/dave would like to join/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/erin would like to join/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /accept/i }));
    expect(presenceState.handleVoteJoin).toHaveBeenCalledWith(
      'user-dave',
      'dave',
      'room-1',
      'general',
      true,
    );

    await user.click(screen.getByRole('button', { name: /deny/i }));
    expect(presenceState.handleVoteJoin).toHaveBeenCalledWith(
      'user-dave',
      'dave',
      'room-1',
      'general',
      false,
    );

    await user.click(screen.getByRole('button', { name: /logout/i }));
    expect(presenceState.handleLogout).toHaveBeenCalledTimes(1);
  });
});
