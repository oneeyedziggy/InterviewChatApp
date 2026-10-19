import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTabsPanel } from './ServerTabsPanel';
import { createServerForCurrentUser } from '../utils/serverCreation';
import { joinServerFromInvite } from '../utils/serverJoining';

vi.mock('../utils/gpg', () => ({
  clearServerSessionForUser: vi.fn(),
  loadKeysAsync: vi.fn(),
  loadKeysForServerAsync: vi.fn().mockResolvedValue({
    username: 'alice',
    userId: 'alice-id',
    sessionId: 'server-session',
  }),
}));
vi.mock('../utils/serverCreation', () => ({
  createServerForCurrentUser: vi.fn(),
}));
vi.mock('../utils/serverJoining', () => ({ joinServerFromInvite: vi.fn() }));
vi.mock('../utils/serverRegistry', () => ({
  loadServerMemberships: () => [
    { serverId: 'one', label: 'First Server', shorthand: 'FS' },
  ],
  loadServerMembershipsAsync: async () => [
    { serverId: 'one', label: 'First Server', shorthand: 'FS' },
  ],
  serverMembershipsChangedEvent: 'memberships-changed',
  removeServerMembership: vi.fn(),
}));

const openDialog = async () => {
  render(<ServerTabsPanel />);
  await userEvent.click(screen.getByRole('button', { name: 'Add a server' }));
  return screen.getByLabelText('Server name or invite link');
};

describe('ServerTabsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    vi.mocked(createServerForCurrentUser).mockResolvedValue({
      serverId: 'new-server',
      alias: 'new',
      label: 'New',
      username: 'alice',
      userId: 'alice-id',
      sessionId: 'session',
    });
    vi.mocked(joinServerFromInvite).mockResolvedValue({
      membership: {
        serverId: 'joined',
        label: 'Joined',
        username: 'alice',
        userId: 'alice-id',
      },
      username: 'alice',
      sessionId: 'joined-session',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('has one input, an adaptive action and a close X instead of Cancel', async () => {
    const input = await openDialog();
    expect(
      screen.getByRole('dialog', { name: 'Add/Join a server' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create server' }),
    ).toBeDisabled();
    fireEvent.change(input, { target: { value: '  ' } });
    expect(
      screen.getByRole('button', { name: 'Create server' }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('creates a trimmed name on Enter and preserves session handoff', async () => {
    const input = await openDialog();
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate);
    fireEvent.change(input, { target: { value: '  New  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(createServerForCurrentUser).toHaveBeenCalledWith('New');
    expect(joinServerFromInvite).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?server=new');
    expect(popstate.mock.calls[0][0].detail).toEqual({
      sessionId: 'session',
      username: 'alice',
    });
    window.removeEventListener('popstate', popstate);
  });

  it.each(['absolute', 'relative'])(
    'joins a valid %s invite instead of creating',
    async (kind) => {
      const input = await openDialog();
      const path = '/login?invite=code&server=joined';
      fireEvent.change(input, {
        target: {
          value:
            kind === 'absolute' ? `${window.location.origin}${path}` : path,
        },
      });
      await userEvent.click(
        screen.getByRole('button', { name: 'Join server' }),
      );
      expect(joinServerFromInvite).toHaveBeenCalledWith({
        serverId: 'joined',
        inviteCode: 'code',
        serverLabel: '',
      });
      expect(createServerForCurrentUser).not.toHaveBeenCalled();
      expect(window.location.search).toBe('?server=joined');
    },
  );

  it.each([
    'https://foreign.example/login?invite=x&server=y',
    '/login?invite=x',
    '/wrong?invite=x&server=y',
    'https://[invalid',
    'www.example.com',
  ])('rejects URL-like input %s without creating', async (value) => {
    const input = await openDialog();
    fireEvent.change(input, { target: { value } });
    await userEvent.click(screen.getByRole('button', { name: 'Join server' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(input).toHaveValue(value);
    expect(createServerForCurrentUser).not.toHaveBeenCalled();
    expect(joinServerFromInvite).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Friends' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create server' })).toBeEnabled();
  });

  it('locks input and dismissal during submission and retains failed drafts', async () => {
    let rejectRequest!: (error: Error) => void;
    vi.mocked(createServerForCurrentUser).mockReturnValue(
      new Promise((_, reject) => {
        rejectRequest = reject;
      }),
    );
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'Friends' } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create server' }),
    );
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(createServerForCurrentUser).toHaveBeenCalledTimes(1);
    await act(async () => rejectRequest(new Error('Create failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Create failed');
    expect(input).toHaveValue('Friends');
    expect(input).toBeEnabled();
  });

  it('toggles labels while preserving full accessible names', async () => {
    render(<ServerTabsPanel />);
    await screen.findByText('First Server');
    await userEvent.click(
      screen.getByRole('button', { name: 'Show server abbreviations' }),
    );
    expect(
      screen.getByRole('button', { name: 'First Server' }),
    ).toHaveTextContent('FS');
    expect(screen.queryByText('First Server')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Show server names' }),
    );
    expect(screen.getByText('First Server')).toBeInTheDocument();
  });

  it('offers Leave server from the ellipsis menu for an inactive tab', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ServerTabsPanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for First Server' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Leave server' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/leave-server?server=one',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          userId: 'alice-id',
          sessionId: 'server-session',
        }),
      }),
    );
  });
});
