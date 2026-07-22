const LEGACY_BLOCKED_USERS_KEY = 'chat_blocked_users';
const USER_PUBLIC_KEYS_KEY = 'gpg_user_public_keys';

type UserPublicKeyEntry = {
  publicKey: string;
  blocked?: boolean;
};

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
        const maybeEntry = raw as { publicKey?: unknown; blocked?: unknown };
        const publicKey =
          typeof maybeEntry.publicKey === 'string' ? maybeEntry.publicKey : '';
        normalized[username] = {
          publicKey,
          blocked: !!maybeEntry.blocked,
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
        entries[username] = { ...existing, blocked: true };
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
  return Object.entries(entries)
    .filter(([, entry]) => !!entry.blocked)
    .map(([username]) => username);
}

export function isUserBlocked(username: string): boolean {
  if (!username) return false;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  return !!entries[username]?.blocked;
}

export function blockUser(username: string): void {
  if (typeof window === 'undefined' || !username) return;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  const existing = entries[username] || { publicKey: '' };
  entries[username] = { ...existing, blocked: true };
  writeUserKeyEntries(entries);
}

export function unblockUser(username: string): void {
  if (typeof window === 'undefined' || !username) return;
  const entries = migrateLegacyBlockedUsers(readUserKeyEntries());
  if (!entries[username]) {
    return;
  }
  entries[username] = { ...entries[username], blocked: false };
  writeUserKeyEntries(entries);
}
