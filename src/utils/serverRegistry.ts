import { withServerQuery } from './appPaths';

const SERVER_MEMBERSHIPS_KEY = 'chat_server_memberships_v1';
export const serverMembershipsChangedEvent = 'chat-server-memberships-changed';

export type ServerMembership = {
  serverId: string;
  label: string;
  alias?: string;
  username: string;
  userId: string;
};

const normalizeMembership = (value: unknown): ServerMembership | null => {
  if (!value || typeof value !== 'object') return null;

  const raw = value as Partial<ServerMembership>;
  if (
    typeof raw.serverId !== 'string' ||
    raw.serverId.trim() === '' ||
    typeof raw.label !== 'string' ||
    raw.label.trim() === '' ||
    typeof raw.username !== 'string' ||
    raw.username.trim() === '' ||
    typeof raw.userId !== 'string' ||
    raw.userId.trim() === ''
  ) {
    return null;
  }

  return {
    serverId: raw.serverId.trim(),
    label: raw.label.trim(),
    alias:
      typeof raw.alias === 'string' && raw.alias.trim() !== ''
        ? raw.alias.trim()
        : undefined,
    username: raw.username.trim(),
    userId: raw.userId.trim(),
  };
};

const dedupeMemberships = (memberships: ServerMembership[]) => {
  const byServerAndUser = new Map<string, ServerMembership>();
  for (const membership of memberships) {
    byServerAndUser.set(
      `${membership.serverId}\u0000${membership.username}`,
      membership,
    );
  }
  return Array.from(byServerAndUser.values());
};

export const loadServerMemberships = (): ServerMembership[] => {
  if (typeof window === 'undefined') return [];

  const stored = localStorage.getItem(SERVER_MEMBERSHIPS_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return dedupeMemberships(
      parsed
        .map(normalizeMembership)
        .filter((membership): membership is ServerMembership => !!membership),
    );
  } catch {
    return [];
  }
};

const saveServerMemberships = (memberships: ServerMembership[]): void => {
  if (typeof window === 'undefined') return;
  const normalized = dedupeMemberships(memberships);
  localStorage.setItem(SERVER_MEMBERSHIPS_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new Event(serverMembershipsChangedEvent));
};

export const loadServerMembershipsAsync = async (): Promise<
  ServerMembership[]
> => loadServerMemberships();

export const mergeServerMemberships = (
  memberships: ServerMembership[],
): ServerMembership[] => {
  const normalized = memberships
    .map(normalizeMembership)
    .filter((membership): membership is ServerMembership => !!membership);
  const merged = dedupeMemberships([...loadServerMemberships(), ...normalized]);
  saveServerMemberships(merged);
  return merged;
};

export const upsertServerMembership = (
  membership: ServerMembership,
): ServerMembership[] => mergeServerMemberships([membership]);

export const removeServerMembership = (
  serverId: string,
): ServerMembership[] => {
  const remaining = loadServerMemberships().filter(
    (membership) => membership.serverId !== serverId,
  );
  saveServerMemberships(remaining);
  return remaining;
};

export { withServerQuery };
