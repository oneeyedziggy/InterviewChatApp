export type ServerMembership = {
  serverId: string;
  alias?: string;
  label: string;
  username?: string;
  userId?: string;
};

const STORAGE_KEY = 'chat_server_memberships_v1';
const MEMBERSHIPS_CHANGED_EVENT = 'chat-server-memberships-changed';
let membershipCache: ServerMembership[] | null = null;

const isMembership = (value: unknown): value is ServerMembership => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ServerMembership>;
  return (
    typeof candidate.serverId === 'string' &&
    candidate.serverId.trim() !== '' &&
    typeof candidate.label === 'string' &&
    candidate.label.trim() !== '' &&
    (candidate.alias === undefined || typeof candidate.alias === 'string') &&
    (candidate.username === undefined ||
      typeof candidate.username === 'string') &&
    (candidate.userId === undefined || typeof candidate.userId === 'string')
  );
};

const sanitize = (values: unknown): ServerMembership[] => {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, ServerMembership>();
  for (const value of values) {
    if (isMembership(value)) unique.set(value.serverId, value);
  }
  return [...unique.values()];
};

const readRawMemberships = (): ServerMembership[] => {
  if (typeof window === 'undefined') return [];
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
};

export const loadServerMemberships = (): ServerMembership[] => {
  if (typeof window === 'undefined') return [];
  if (!membershipCache) membershipCache = readRawMemberships();
  return [...membershipCache];
};

export const loadServerMembershipsAsync = async (): Promise<
  ServerMembership[]
> => {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [...(membershipCache || [])];
  }
  try {
    const { decryptJsonForCurrentUser } = await import('./gpg');
    const persistedMemberships = sanitize(
      await decryptJsonForCurrentUser<unknown>(raw),
    );
    membershipCache = sanitize([
      ...(membershipCache || []),
      ...persistedMemberships,
    ]);
  } catch {
    const legacy = readRawMemberships();
    membershipCache = sanitize([...(membershipCache || []), ...legacy]);
    if (legacy.length > 0) {
      try {
        const { encryptJsonForCurrentUser } = await import('./gpg');
        localStorage.setItem(
          STORAGE_KEY,
          await encryptJsonForCurrentUser(membershipCache),
        );
      } catch {
        // Migrate after the account is unlocked.
      }
    }
  }
  return [...(membershipCache || [])];
};

export const saveServerMemberships = (
  memberships: ServerMembership[],
): void => {
  if (typeof window === 'undefined') return;
  membershipCache = sanitize(memberships);
  window.dispatchEvent(new Event(MEMBERSHIPS_CHANGED_EVENT));
  void persistServerMemberships();
};

export const persistServerMemberships = async (): Promise<void> => {
  if (typeof window === 'undefined' || !membershipCache) return;
  try {
    const { encryptJsonForCurrentUser } = await import('./gpg');
    localStorage.setItem(
      STORAGE_KEY,
      await encryptJsonForCurrentUser(membershipCache),
    );
  } catch {
    // Keep the updated registry in memory until the account is unlocked.
  }
};

export const upsertServerMembership = (
  membership: ServerMembership,
): ServerMembership[] => {
  const memberships = loadServerMemberships();
  memberships.push(membership);
  saveServerMemberships(memberships);
  return loadServerMemberships();
};

export const mergeServerMemberships = (
  incoming: ServerMembership[],
): ServerMembership[] => {
  const memberships = loadServerMemberships();
  saveServerMemberships([...memberships, ...incoming]);
  return loadServerMemberships();
};

export const removeServerMembership = (
  serverId: string,
): ServerMembership[] => {
  const memberships = loadServerMemberships().filter(
    (membership) => membership.serverId !== serverId,
  );
  saveServerMemberships(memberships);
  return memberships;
};

export const getActiveServerId = (): string => {
  if (typeof window === 'undefined') return '';
  return (
    new URLSearchParams(window.location.search).get('server')?.trim() || ''
  );
};

export const getActiveServerAlias = (): string => {
  if (typeof window === 'undefined') return '';
  return (
    new URLSearchParams(window.location.search).get('server')?.trim() || ''
  );
};

export const withServerQuery = (
  path: string,
  serverId = getActiveServerId(),
): string => {
  if (!serverId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}server=${encodeURIComponent(serverId)}`;
};

export const serverMembershipStorageKey = STORAGE_KEY;
export const serverMembershipsChangedEvent = MEMBERSHIPS_CHANGED_EVENT;
