import { useState } from 'react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { PrimaryButton } from './home/LayoutPrimitives';
import { AppModal } from './AppModal';
import { loadServerMemberships } from '../utils/serverRegistry';

type InviteSummary = {
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  status: string;
  usedCount: number;
};

export const InviteDialog = () => {
  const [inviteUrl, setInviteUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [showInviteManagement, setShowInviteManagement] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);

  const createInvite = async () => {
    setError('');
    setCopied(false);
    const { loadKeysAsync } = await import('../utils/gpg');
    const keys = await loadKeysAsync();
    if (!keys?.userId || !keys.sessionId) {
      setError('Your session has expired. Please log in again.');
      return;
    }
    try {
      const response = await fetch(apiPath('/api/invites'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: keys.userId,
          sessionId: keys.sessionId,
        }),
      });
      const data = (await response.json()) as { code?: string; error?: string };
      if (!response.ok || !data.code)
        throw new Error(data.error || 'Unable to create invite.');
      const serverId = new URLSearchParams(window.location.search).get(
        'server',
      );
      const query = new URLSearchParams({ invite: data.code });
      if (serverId) {
        query.set('server', serverId);
        const membership = loadServerMemberships().find(
          (entry) => entry.serverId === serverId || entry.alias === serverId,
        );
        if (membership?.label) query.set('serverLabel', membership.label);
      }
      setInviteUrl(
        `${window.location.origin}${withBasePath('/login')}?${query}`,
      );
      await loadInvites();
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : 'Unable to create invite.',
      );
    }
  };

  const loadInvites = async () => {
    try {
      const response = await fetch(apiPath('/api/invites'));
      if (!response.ok) throw new Error('Unable to load invites.');
      setInvites((await response.json()) as InviteSummary[]);
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : 'Unable to load invites.',
      );
    }
  };

  const revokeInvite = async (inviteId: string) => {
    const { loadKeysAsync } = await import('../utils/gpg');
    const keys = await loadKeysAsync();
    if (!keys?.userId || !keys.sessionId) {
      setError('Your session has expired. Please log in again.');
      return;
    }
    const response = await fetch(apiPath('/api/invites/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: keys.userId,
        sessionId: keys.sessionId,
        inviteId,
      }),
    });
    if (!response.ok) {
      setError('Unable to revoke invite.');
      return;
    }
    await loadInvites();
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
      } else {
        const input = document.createElement('textarea');
        input.value = inviteUrl;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      setCopied(true);
    } catch {
      setError('Unable to copy the invite URL.');
    }
  };

  return (
    <>
      <PrimaryButton type="button" onClick={() => void createInvite()}>
        Create invite
      </PrimaryButton>
      <button
        type="button"
        className="app-secondary-button"
        onClick={() => {
          setShowInviteManagement(true);
          void loadInvites();
        }}
      >
        Manage invites
      </button>
      <AppModal
        open={!!inviteUrl}
        title="Invite link"
        onClose={() => setInviteUrl('')}
        actions={
          <>
            <PrimaryButton type="button" onClick={() => void copyInvite()}>
              {copied ? 'Copied' : 'Copy link'}
            </PrimaryButton>
            <button
              type="button"
              className="app-secondary-button"
              onClick={() => setInviteUrl('')}
            >
              Close
            </button>
          </>
        }
      >
        <p className="app-dialog-message">
          Share this link with the person joining this server.
        </p>
        <input
          className="app-text-input app-dialog-invite-url"
          readOnly
          value={inviteUrl}
          aria-label="Invite URL"
        />
      </AppModal>
      <AppModal
        open={showInviteManagement}
        title="Manage invites"
        onClose={() => setShowInviteManagement(false)}
        actions={
          <button
            type="button"
            className="app-secondary-button"
            onClick={() => setShowInviteManagement(false)}
          >
            Close
          </button>
        }
      >
        {invites.length === 0 ? (
          <p className="app-dialog-message">No invites have been created.</p>
        ) : (
          <ul className="app-invite-list">
            {invites.map((invite) => (
              <li key={invite.inviteId}>
                <span>
                  {invite.status} · expires{' '}
                  {new Date(invite.expiresAt * 1000).toLocaleString()}
                </span>
                {invite.status === 'active' && (
                  <button
                    type="button"
                    className="app-secondary-button"
                    onClick={() => void revokeInvite(invite.inviteId)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AppModal>
      {error && <span role="alert">{error}</span>}
    </>
  );
};
