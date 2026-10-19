import { withBasePath } from './appPaths';

export type ParsedInviteLink = {
  serverId: string;
  inviteCode: string;
  serverLabel: string;
};

export const buildInviteUrl = (params: {
  origin: string;
  inviteCode: string;
  serverId: string;
  serverLabel?: string;
}): string => {
  const url = new URL(withBasePath('/login'), params.origin);
  url.searchParams.set('invite', params.inviteCode);
  url.searchParams.set('server', params.serverId);
  if (params.serverLabel?.trim()) {
    url.hash = new URLSearchParams({
      serverLabel: params.serverLabel.trim(),
    }).toString();
  }
  return url.toString();
};

export const parseInviteUrl = (
  value: string,
  origin: string,
): ParsedInviteLink => {
  let url: URL;
  try {
    url = new URL(value.trim(), origin);
  } catch {
    throw new Error('Paste a valid invite link.');
  }

  if (url.origin !== new URL(origin).origin) {
    throw new Error('Invite links must come from this chat server.');
  }
  if (url.pathname !== withBasePath('/login')) {
    throw new Error('This link is not a chat server invite.');
  }

  const inviteCode = url.searchParams.get('invite')?.trim() || '';
  const serverId = url.searchParams.get('server')?.trim() || '';
  if (!inviteCode || !serverId) {
    throw new Error('The invite link is missing its server or invite code.');
  }

  const serverLabel =
    new URLSearchParams(url.hash.slice(1)).get('serverLabel')?.trim() || '';
  return { serverId, inviteCode, serverLabel };
};
