import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { InviteDialog, isArchivedInvite } from './InviteDialog';

const mocks = vi.hoisted(() => ({
  loadKeysAsync: vi.fn(),
  loadServerMemberships: vi.fn(),
  encryptJsonForCurrentUser: vi.fn(),
  decryptJsonForCurrentUser: vi.fn(),
}));
vi.mock('../utils/gpg', () => mocks);
vi.mock('../utils/serverRegistry', () => mocks);
const origin = window.location.origin;
const url = `${origin}/login?invite=secret&server=canonical#serverLabel=Friends`;
const recent = {
  inviteId: 'new-id',
  createdAt: Date.now() / 1000,
  expiresAt: Date.now() / 1000 + 86400,
  status: 'active',
  usedCount: 0,
};
const fetchMock = vi.fn();
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/?server=friendly');
  mocks.loadKeysAsync.mockResolvedValue({
    userId: 'alice-id',
    sessionId: 'session',
  });
  mocks.loadServerMemberships.mockReturnValue([
    { serverId: 'canonical', alias: 'friendly', label: 'Friends' },
  ]);
  mocks.encryptJsonForCurrentUser.mockImplementation(
    async (value) => `cipher:${JSON.stringify(value)}`,
  );
  mocks.decryptJsonForCurrentUser.mockImplementation(async (value) =>
    JSON.parse(value.slice(7)),
  );
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('InviteDialog', () => {
  it('creates, encrypts, reloads by ID, copies independently, and revokes', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ code: 'secret', inviteId: 'new-id' }),
    );
    const first = render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(
      await screen.findByRole('textbox', { name: 'Invite URL' }),
    ).toHaveValue(url);
    await waitFor(() =>
      expect(mocks.encryptJsonForCurrentUser).toHaveBeenCalled(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invites?server=friendly',
      expect.objectContaining({
        body: JSON.stringify({ userId: 'alice-id', sessionId: 'session' }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite URL' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(url);
    first.unmount();
    fetchMock.mockResolvedValueOnce(
      response([
        recent,
        { ...recent, inviteId: 'old-unavailable', status: 'used' },
      ]),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    expect(
      await screen.findByRole('textbox', { name: 'Invite URL new-id' }),
    ).toHaveValue(url);
    expect(
      screen.getByRole('button', { name: 'Copy invite URL old-unavailable' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy invite URL new-id' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    fetchMock
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response([{ ...recent, status: 'revoked' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Revoke' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('textbox', { name: 'Invite URL new-id' }),
    ).toHaveValue(url);
  });

  it('shows loading, failure and retry without an empty flash', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(
      screen.queryByText('No invites have been created.'),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    resolve(response({}, false));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load',
    );
    expect(
      screen.queryByText('No invites have been created.'),
    ).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(response([]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('No invites have been created.'),
    ).toBeInTheDocument();
  });

  it('archives older invites in an initially collapsed bottom disclosure', async () => {
    const now = Date.now() / 1000;
    fetchMock.mockResolvedValueOnce(
      response([
        recent,
        {
          ...recent,
          inviteId: 'archived',
          createdAt: now - 300,
          expiresAt: now - 200,
          status: 'expired',
        },
      ]),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    const toggle = await screen.findByRole('button', {
      name: 'Older invites (1)',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('button', { name: 'Copy invite URL archived' }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(screen.getByRole('region', { name: 'Older invites' })).getByRole(
        'button',
        { name: 'Copy invite URL archived' },
      ),
    ).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveClass('app-dialog-card--invites');
    fireEvent.click(toggle);
    expect(
      screen.queryByRole('region', { name: 'Older invites' }),
    ).not.toBeInTheDocument();
  });
  it.each([199, 200, 201])('archive threshold at now=%s', (now) => {
    expect(isArchivedInvite({ createdAt: 100, expiresAt: 150 }, now)).toBe(
      now > 200,
    );
  });
  it.each([
    { createdAt: NaN, expiresAt: 150 },
    { createdAt: 100, expiresAt: 100 },
    { createdAt: 150, expiresAt: 100 },
  ])('keeps invalid lifetime %j in the main list', (invite) => {
    expect(isArchivedInvite(invite, 1000)).toBe(false);
  });

  it('preserves default-server URLs without a server query', async () => {
    window.history.replaceState({}, '', '/');
    fetchMock.mockResolvedValueOnce(
      response({ inviteId: 'default-id', code: 'default-code' }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(
      await screen.findByRole('textbox', { name: 'Invite URL' }),
    ).toHaveValue(`${origin}/login?invite=default-code`);
  });

  it('retains a newly created link when storage fails', async () => {
    mocks.encryptJsonForCurrentUser.mockRejectedValueOnce(
      new Error('Storage unavailable'),
    );
    fetchMock.mockResolvedValueOnce(
      response({ inviteId: 'new-id', code: 'secret' }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be saved',
    );
    expect(screen.getByRole('textbox', { name: 'Invite URL' })).toHaveValue(
      url,
    );
  });

  it('ignores an in-flight create response after switching server', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    window.history.replaceState({}, '', '/?server=other');
    fireEvent(window, new PopStateEvent('popstate'));
    resolve(response({ inviteId: 'new-id', code: 'secret' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create invite' }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it('does not apply a create response after switching account', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    mocks.loadKeysAsync.mockResolvedValue({
      userId: 'bob-id',
      sessionId: 'bob-session',
    });
    resolve(response({ inviteId: 'new-id', code: 'secret' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create invite' }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mocks.encryptJsonForCurrentUser).not.toHaveBeenCalled();
  });

  it('does not apply late list summaries after switching server', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    window.history.replaceState({}, '', '/?server=other');
    fireEvent(window, new PopStateEvent('popstate'));
    resolve(response([recent]));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Revoke' }),
    ).not.toBeInTheDocument();
  });

  it('renders an all-archived list with the main region and bottom disclosure', async () => {
    fetchMock.mockResolvedValueOnce(
      response([
        { ...recent, createdAt: 100, expiresAt: 200, status: 'expired' },
      ]),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    expect(
      await screen.findByText('All invites are archived.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older invites (1)' }));
    expect(
      screen.getByRole('region', { name: 'Recent invites' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Older invites' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('shows summaries and unavailable URLs when encrypted recovery fails', async () => {
    localStorage.setItem(
      `invite-urls:v1:${JSON.stringify([origin, 'canonical', 'alice-id'])}`,
      'corrupt',
    );
    mocks.decryptJsonForCurrentUser.mockRejectedValueOnce(
      new Error('Bad encrypted payload'),
    );
    fetchMock.mockResolvedValueOnce(response([recent]));
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be recovered',
    );
    expect(
      screen.getByText('URL unavailable on this browser'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy invite URL new-id' }),
    ).toBeDisabled();
  });

  it('tracks copied feedback independently for each available row', async () => {
    const secondUrl = `${origin}/login?invite=second&server=canonical`;
    localStorage.setItem(
      `invite-urls:v1:${JSON.stringify([origin, 'canonical', 'alice-id'])}`,
      `cipher:${JSON.stringify({
        version: 1,
        scope: [origin, 'canonical', 'alice-id'],
        urls: { 'new-id': url, 'second-id': secondUrl },
      })}`,
    );
    fetchMock.mockResolvedValueOnce(
      response([recent, { ...recent, inviteId: 'second-id', status: 'used' }]),
    );
    render(<InviteDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage invites' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy invite URL new-id' }),
    );
    await screen.findByRole('status');
    expect(
      screen.getByRole('button', { name: 'Copy invite URL second-id' }),
    ).toHaveAttribute('title', 'Copy invite URL');
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy invite URL second-id' }),
    );
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(secondUrl);
  });

  it.each([true, false])(
    'uses clipboard fallback and checks execCommand success=%s',
    async (success) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
      });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: vi.fn().mockReturnValue(success),
      });
      fetchMock.mockResolvedValueOnce(
        response({ inviteId: 'new-id', code: 'secret' }),
      );
      render(<InviteDialog />);
      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
      await screen.findByRole('textbox', { name: 'Invite URL' });
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Manage invites' }),
        ).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Copy invite URL' }));
      if (success)
        expect(await screen.findByRole('status')).toHaveTextContent('Copied');
      else
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Unable to copy',
        );
      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
    },
  );
});
