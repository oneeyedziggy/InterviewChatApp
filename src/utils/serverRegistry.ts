import { withServerQuery } from './appPaths';

const SERVER_MEMBERSHIPS_KEY = 'chat_server_memberships_v1';
export const serverMembershipsChangedEvent = 'chat-server-memberships-changed';

export type ServerMembership = {
  serverId: string;
  label: string;
  shorthand?: string;
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
    shorthand:
      typeof raw.shorthand === 'string' && raw.shorthand.trim() !== ''
        ? raw.shorthand.trim()
        : undefined,
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
  const canonicalByAlias = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  for (const membership of memberships) {
    if (membership.alias && membership.alias !== membership.serverId) {
      const existing = canonicalByAlias.get(membership.alias);
      if (existing && existing !== membership.serverId) {
        ambiguousAliases.add(membership.alias);
      } else {
        canonicalByAlias.set(membership.alias, membership.serverId);
      }
    }
  }
  for (const membership of memberships) {
    const serverId =
      (membership.alias && membership.alias !== membership.serverId) ||
      ambiguousAliases.has(membership.serverId)
        ? membership.serverId
        : canonicalByAlias.get(membership.serverId) || membership.serverId;
    const key = `${serverId}\u0000${membership.userId}`;
    const previous = byServerAndUser.get(key);
    byServerAndUser.set(key, {
      ...previous,
      ...membership,
      serverId,
      shorthand: membership.shorthand || previous?.shorthand,
      alias:
        membership.alias ||
        previous?.alias ||
        (serverId !== membership.serverId ? membership.serverId : undefined),
    });
  }
  return Array.from(byServerAndUser.values());
};

const normalizedLabel = (label: string) => label.trim().toLocaleLowerCase();

const createServerShorthand = (
  membership: ServerMembership,
  existing: ServerMembership[],
): string => {
  const characters = Array.from(membership.label.trim());
  const first = (characters[0] || 'S').toLocaleUpperCase();
  const firstTwo = characters.slice(0, 2).join('').toLocaleUpperCase() || first;
  const used = new Set(
    existing
      .map((entry) => entry.shorthand?.toLocaleLowerCase())
      .filter((value): value is string => !!value),
  );
  const sameNameCount = existing.filter(
    (entry) =>
      normalizedLabel(entry.label) === normalizedLabel(membership.label),
  ).length;
  const ordinal = sameNameCount + 1;

  for (const candidate of [first, firstTwo]) {
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }

  for (let suffix = ordinal; suffix <= 9; suffix += 1) {
    const firstCandidate = `${first}${suffix}`;
    if (!used.has(firstCandidate.toLocaleLowerCase())) return firstCandidate;
  }

  for (let suffix = ordinal; suffix <= 9; suffix += 1) {
    const secondCandidate = `${firstTwo}${suffix}`;
    if (!used.has(secondCandidate.toLocaleLowerCase())) return secondCandidate;
  }

  for (let length = 3; length <= characters.length; length += 1) {
    const candidate = characters.slice(0, length).join('').toLocaleUpperCase();
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }

  let fallbackOrdinal = Math.max(ordinal, 1);
  let fallback = `${firstTwo}${fallbackOrdinal}`;
  while (used.has(fallback.toLocaleLowerCase())) {
    fallbackOrdinal += 1;
    fallback = `${firstTwo}${fallbackOrdinal}`;
  }
  return fallback;
};

const ensureServerShorthands = (
  memberships: ServerMembership[],
): ServerMembership[] => {
  const assigned: ServerMembership[] = [];
  for (const membership of memberships) {
    const shorthand = membership.shorthand?.trim();
    const used = assigned.some(
      (entry) =>
        entry.shorthand?.toLocaleLowerCase() === shorthand?.toLocaleLowerCase(),
    );
    assigned.push({
      ...membership,
      shorthand:
        shorthand && !used
          ? shorthand
          : createServerShorthand(membership, assigned),
    });
  }
  return assigned;
};

export const loadServerMemberships = (): ServerMembership[] => {
  if (typeof window === 'undefined') return [];

  const stored = localStorage.getItem(SERVER_MEMBERSHIPS_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    const memberships = ensureServerShorthands(
      dedupeMemberships(
        parsed
          .map(normalizeMembership)
          .filter((membership): membership is ServerMembership => !!membership),
      ),
    );
    if (JSON.stringify(memberships) !== JSON.stringify(parsed)) {
      localStorage.setItem(SERVER_MEMBERSHIPS_KEY, JSON.stringify(memberships));
    }
    return memberships;
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
  const merged = ensureServerShorthands(
    dedupeMemberships([...loadServerMemberships(), ...normalized]),
  );
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
