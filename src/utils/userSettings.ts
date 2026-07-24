const LEGACY_BLOCKED_USERS_KEY = 'chat_blocked_users';
const USER_PUBLIC_KEYS_KEY = 'gpg_user_public_keys';

type UserPublicKeyEntry = {
  publicKey: string;
  blocked?: boolean;
  blockedAt?: number;
  blockedBy?: string[];
};

type BlockedUserExport = {
  blockedAt?: number;
  blockedBy: string[];
};

function getCurrentLocalUsername(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('gpg_username');
}

function isBlockedForUser(
  entry: UserPublicKeyEntry | undefined,
  localUsername: string | null,
): boolean {
  if (!entry) return false;
  if (!localUsername) return !!entry.blocked;

  if (Array.isArray(entry.blockedBy) && entry.blockedBy.length > 0) {
    return entry.blockedBy.includes(localUsername);
  }

  // Legacy fallback: blocked without blockedBy applies to current local user.
  return !!entry.blocked;
}

function readUserKeyEntries(): Record<string, UserPublicKeyEntry> {
  if (typeof window === 'undefined') return {};

  const stored = localStorage.getItem(USER_PUBLIC_KEYS_KEY);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const normalized: Record<string, UserPublicKeyEntry> = {};

    for (const [username, raw] of Object.entries(parsed)) {
      if (typeof raw === 'string') {
        normalized[username] = { publicKey: raw, blocked: false };
        continue;
      }

      if (raw && typeof raw === 'object') {
        const maybeEntry = raw as {
          publicKey?: unknown;
          blocked?: unknown;
          blockedAt?: unknown;
          blockedBy?: unknown;
        };
        const publicKey =
          typeof maybeEntry.publicKey === 'string' ? maybeEntry.publicKey : '';
        const blockedBy = Array.isArray(maybeEntry.blockedBy)
          ? maybeEntry.blockedBy.filter(
              (user): user is string => typeof user === 'string' && user !== '',
            )
          : undefined;
        normalized[username] = {
          publicKey,
          blocked: !!maybeEntry.blocked,
          blockedAt:
            typeof maybeEntry.blockedAt === 'number'
              ? maybeEntry.blockedAt
              : undefined,
          blockedBy,
        };
      }
    }

    return normalized;
  } catch {
    return {};
  }
}

function writeUserKeyEntries(
  entries: Record<string, UserPublicKeyEntry>,
): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(USER_PUBLIC_KEYS_KEY, JSON.stringify(entries));
}

function migrateLegacyBlockedUsers(
  entries: Record<string, UserPublicKeyEntry>,
): Record<string, UserPublicKeyEntry> {
  if (typeof window === 'undefined') return entries;

  const legacyRaw = localStorage.getItem(LEGACY_BLOCKED_USERS_KEY);
  if (!legacyRaw) return entries;

  try {
    const legacy = JSON.parse(legacyRaw);
    if (Array.isArray(legacy)) {
      for (const username of legacy) {
        if (typeof username !== 'string' || !username) continue;
        const existing = entries[username] || { publicKey: '' };
        const currentLocalUsername = getCurrentLocalUsername();
        const blockedBy = new Set(existing.blockedBy || []);
        if (currentLocalUsername) {
          blockedBy.add(currentLocalUsername);
        }
        entries[username] = {
          ...existing,
          blocked: true,
          blockedBy: Array.from(blockedBy),
        };
      }
      writeUserKeyEntries(entries);
    }
  } catch {
    // ignore bad legacy payload
  }

  localStorage.removeItem(LEGACY_BLOCKED_USERS_KEY);
  return entries;
}

export function getBlockedUsers(): string[] {
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  const currentLocalUsername = getCurrentLocalUsername();
  return Object.entries(entries)
    .filter(([, entry]) => isBlockedForUser(entry, currentLocalUsername))
    .map(([username]) => username);
}

export function isUserBlocked(username: string): boolean {
  if (!username) return false;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  const currentLocalUsername = getCurrentLocalUsername();
  return isBlockedForUser(entries[username], currentLocalUsername);
}

export function blockUser(username: string): void {
  if (typeof window === 'undefined' || !username) return;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  const existing = entries[username] || { publicKey: '' };
  const currentLocalUsername = getCurrentLocalUsername();
  const blockedBy = new Set(existing.blockedBy || []);
  if (currentLocalUsername) {
    blockedBy.add(currentLocalUsername);
  }
  entries[username] = {
    ...existing,
    blocked: true,
    blockedAt: Math.floor(Date.now() / 1000),
    blockedBy: Array.from(blockedBy),
  };
  writeUserKeyEntries(entries);
}

export function unblockUser(username: string): number | undefined {
  if (typeof window === 'undefined' || !username) return undefined;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  if (!entries[username]) {
    return undefined;
  }
  const blockedAt = entries[username].blockedAt;
  const currentLocalUsername = getCurrentLocalUsername();
  const blockedBy = new Set(entries[username].blockedBy || []);
  if (currentLocalUsername) {
    blockedBy.delete(currentLocalUsername);
  }

  const stillBlockedByOthers = blockedBy.size > 0;
  entries[username] = {
    ...entries[username],
    blocked: stillBlockedByOthers,
    blockedAt: stillBlockedByOthers ? entries[username].blockedAt : undefined,
    blockedBy: Array.from(blockedBy),
  };
  writeUserKeyEntries(entries);
  return blockedAt;
}

export function getBlockedUserExportsForCurrentUser(): Record<
  string,
  BlockedUserExport
> {
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  const currentLocalUsername = getCurrentLocalUsername();
  const exported: Record<string, BlockedUserExport> = {};

  for (const [username, entry] of Object.entries(entries)) {
    if (!isBlockedForUser(entry, currentLocalUsername)) {
      continue;
    }

    const blockedBy = Array.isArray(entry.blockedBy)
      ? entry.blockedBy.filter((value) => typeof value === 'string' && value)
      : currentLocalUsername
        ? [currentLocalUsername]
        : [];

    exported[username] = {
      blockedAt: entry.blockedAt,
      blockedBy,
    };
  }

  return exported;
}
