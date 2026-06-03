const BLOCKED_USERS_KEY = 'chat_blocked_users';

export function getBlockedUsers(): string[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(BLOCKED_USERS_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export function isUserBlocked(username: string): boolean {
  return getBlockedUsers().includes(username);
}

export function blockUser(username: string): void {
  if (typeof window === 'undefined' || !username) return;
  const blocked = getBlockedUsers();
  if (!blocked.includes(username)) {
    localStorage.setItem(BLOCKED_USERS_KEY, JSON.stringify([...blocked, username]));
  }
}

export function unblockUser(username: string): void {
  if (typeof window === 'undefined' || !username) return;
  const blocked = getBlockedUsers().filter((u) => u !== username);
  if (blocked.length === 0) {
    localStorage.removeItem(BLOCKED_USERS_KEY);
  } else {
    localStorage.setItem(BLOCKED_USERS_KEY, JSON.stringify(blocked));
  }
}
