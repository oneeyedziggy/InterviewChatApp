import { withBasePath } from './appPaths';
import { loadServerMemberships } from './serverRegistry';

export type InviteUrlScope = {
  origin: string;
  serverId: string;
  userId: string;
};
export type InviteUrls = Record<string, string>;

export const captureInviteRoute = () => {
  const routeServer =
    new URLSearchParams(window.location.search).get('server')?.trim() || '';
  const memberships = loadServerMemberships();
  const exact = memberships.find((entry) => entry.serverId === routeServer);
  const aliases = memberships.filter((entry) => entry.alias === routeServer);
  const membership =
    exact ||
    (new Set(aliases.map((entry) => entry.serverId)).size === 1
      ? aliases[0]
      : undefined);
  return {
    origin: window.location.origin,
    serverId: routeServer ? membership?.serverId || routeServer : '',
    serverLabel: routeServer ? membership?.label : undefined,
  };
};

export const inviteScopeKey = (scope: InviteUrlScope): string =>
  `invite-urls:v1:${JSON.stringify([scope.origin, scope.serverId, scope.userId])}`;

export const isInviteScopeCurrent = async (
  scope: InviteUrlScope,
): Promise<boolean> => {
  const { loadKeysAsync } = await import('./gpg');
  const keys = await loadKeysAsync();
  const route = captureInviteRoute();
  return (
    route.origin === scope.origin &&
    route.serverId === scope.serverId &&
    keys?.userId === scope.userId
  );
};

export const isSafeInviteUrl = (
  value: unknown,
  scope: InviteUrlScope,
): value is string => {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === scope.origin &&
      url.pathname === withBasePath('/login') &&
      (url.searchParams.get('server') || '') === scope.serverId &&
      url.searchParams.getAll('server').length <= 1 &&
      url.searchParams.getAll('invite').length === 1 &&
      !!url.searchParams.get('invite')?.trim()
    );
  } catch {
    return false;
  }
};

export const loadInviteUrls = async (
  scope: InviteUrlScope,
): Promise<InviteUrls> => {
  if (!scope.userId || !(await isInviteScopeCurrent(scope))) return {};
  const encrypted = localStorage.getItem(inviteScopeKey(scope));
  if (!encrypted) return {};
  const { decryptJsonForCurrentUser } = await import('./gpg');
  const payload = await decryptJsonForCurrentUser<unknown>(encrypted);
  if (!(await isInviteScopeCurrent(scope))) return {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid local invite cache.');
  const stored = payload as {
    version?: unknown;
    scope?: unknown;
    urls?: unknown;
  };
  if (
    stored.version !== 1 ||
    JSON.stringify(stored.scope) !==
      JSON.stringify([scope.origin, scope.serverId, scope.userId]) ||
    !stored.urls ||
    typeof stored.urls !== 'object' ||
    Array.isArray(stored.urls)
  )
    throw new Error('Invalid local invite cache.');
  return Object.fromEntries(
    Object.entries(stored.urls).filter(
      ([inviteId, url]) =>
        inviteId.trim() &&
        inviteId.length <= 256 &&
        isSafeInviteUrl(url, scope),
    ),
  );
};

export const saveInviteUrls = async (
  scope: InviteUrlScope,
  urls: InviteUrls,
): Promise<void> => {
  if (!scope.userId || !(await isInviteScopeCurrent(scope)))
    throw new Error('Invite account or server changed.');
  const safeUrls = Object.fromEntries(
    Object.entries(urls).filter(
      ([inviteId, url]) =>
        inviteId.trim() &&
        inviteId.length <= 256 &&
        isSafeInviteUrl(url, scope),
    ),
  );
  const { encryptJsonForCurrentUser } = await import('./gpg');
  const encrypted = await encryptJsonForCurrentUser({
    version: 1,
    scope: [scope.origin, scope.serverId, scope.userId],
    urls: safeUrls,
  });
  if (!(await isInviteScopeCurrent(scope)))
    throw new Error('Invite account or server changed.');
  localStorage.setItem(inviteScopeKey(scope), encrypted);
};
