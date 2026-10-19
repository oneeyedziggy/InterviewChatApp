import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeRightPanel } from './HomeRightPanel';
import { withBasePath } from '@/utils/appPaths';

vi.mock('@/utils/appPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/appPaths')>();
  return { ...actual, withBasePath: vi.fn(actual.withBasePath) };
});

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

  it('places invite actions before the Users heading in one grouped row', () => {
    const { container } = render(<HomeRightPanel />);
    const inviteActions = container.querySelector('.app-invite-actions');
    const usersHeading = screen.getByText('Users');

    expect(inviteActions).not.toBeNull();
    expect(inviteActions?.querySelectorAll('button')).toHaveLength(2);
    expect(
      inviteActions!.compareDocumentPosition(usersHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each(['/diagrams/', '/chatApp/diagrams/'])(
    'opens %s in a separate tab without logging out',
    async (href) => {
      vi.mocked(withBasePath).mockReturnValueOnce(href);
      render(<HomeRightPanel />);

      const link = screen.getByRole('link', { name: 'Architecture diagrams' });
      expect(link).toHaveAttribute('href', href);
      expect(withBasePath).toHaveBeenCalledWith('/diagrams/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');

      link.addEventListener('click', (event) => event.preventDefault());
      await userEvent.setup().click(link);
      expect(presenceState.handleLogout).not.toHaveBeenCalled();
    },
  );
});
