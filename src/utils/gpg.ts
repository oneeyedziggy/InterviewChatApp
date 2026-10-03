import * as openpgp from 'openpgp';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { getDmParticipants, isDmRoom } from './dmRooms';
import { getBlockedUsers } from './userSettings';
import {
  decryptPrivateKeyWithPassword,
  encryptPrivateKeyWithPassword,
  isEncryptedPrivateKeyEnvelope,
} from './crypto/privateKeyEnvelope';
import { base64ToBytes, bytesToBase64 } from './crypto/base64';
import {
  brokerClearAllPrivateKeys,
  brokerClearPrivateKey,
  brokerGetPrivateKey,
  brokerSetPrivateKey,
} from './privateKeyBroker';
import {
  getUserIdByUsername,
  requireUserIdByUsername,
  storeIdentityDirectories,
} from '@/utils/identityMap';
import {
  loadServerMemberships,
  mergeServerMemberships,
  type ServerMembership,
} from './serverRegistry';

const STORAGE_KEYS = {
  USERNAME: 'gpg_username',
  USER_ID: 'gpg_user_id',
  PRIVATE_KEY: 'gpg_private_key',
  PUBLIC_KEY: 'gpg_public_key',
  SESSION_ID: 'gpg_session_id',
  USER_PUBLIC_KEYS: 'gpg_user_public_keys', // Map of username -> public key
  ALL_USERS: 'gpg_all_users', // JSON array of all local usernames
};

const unlockedPrivateKeyCache = new Map<string, string>();
const SERVER_SIGNATURE_VERIFICATION_SKEW_MS = 5 * 60 * 1000;

export type StoredKeyMetadata = {
  username: string;
  userId?: string;
  publicKey: string;
  sessionId?: string;
  privateKeyEncrypted: string;
};

// Storage key prefix for per-user data
const getUserStorageKey = (username: string, key: string): string => {
  return `gpg_user_${username}_${key}`;
};

const getServerSessionMapKey = (username: string) =>
  getUserStorageKey(username, 'encryptedServerSessions');

const getServerPublicKeyMapKey = (username: string) =>
  getUserStorageKey(username, 'encryptedServerPublicKeys');

const activeServerId = (): string => {
  if (typeof window === 'undefined') return '';
  return (
    new URLSearchParams(window.location.search).get('server')?.trim() || ''
  );
};

const serverStorageId = (routeValue: string): string => {
  if (!routeValue) return '';
  return (
    loadServerMemberships().find(
      (membership) =>
        membership.serverId === routeValue || membership.alias === routeValue,
    )?.serverId || routeValue
  );
};

const activeServerStorageId = (): string => {
  const routeValue = activeServerId();
  return serverStorageId(routeValue);
};

const explicitServerStorageId = (serverId?: string): string => {
  if (serverId) {
    return serverStorageId(serverId);
  }
  return activeServerStorageId();
};

const readEncryptedServerSessions = async (
  username: string,
  privateKey: string,
): Promise<Record<string, string>> => {
  const encrypted = localStorage.getItem(getServerSessionMapKey(username));
  if (!encrypted) return {};
  try {
    const message = await openpgp.readMessage({ armoredMessage: encrypted });
    const result = await openpgp.decrypt({
      message,
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
    });
    const parsed = JSON.parse(result.data as string) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            ([serverId, sessionId]) =>
              serverId.trim() !== '' &&
              typeof sessionId === 'string' &&
              sessionId.trim() !== '',
          ),
        )
      : {};
  } catch {
    return {};
  }
};

const writeEncryptedServerSessions = async (
  username: string,
  publicKey: string,
  privateKey: string,
  sessions: Record<string, string>,
): Promise<void> => {
  const message = await openpgp.createMessage({
    text: JSON.stringify(sessions),
  });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKey }),
  });
  localStorage.setItem(getServerSessionMapKey(username), encrypted);
};

const readEncryptedServerPublicKeys = async (
  username: string,
  privateKey: string,
): Promise<Record<string, string>> => {
  const encrypted = localStorage.getItem(getServerPublicKeyMapKey(username));
  if (!encrypted) return {};
  try {
    const message = await openpgp.readMessage({ armoredMessage: encrypted });
    const result = await openpgp.decrypt({
      message,
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
    });
    const parsed = JSON.parse(result.data as string) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            ([serverId, serverPublicKey]) =>
              serverId.trim() !== '' &&
              typeof serverPublicKey === 'string' &&
              serverPublicKey.trim() !== '',
          ),
        )
      : {};
  } catch {
    return {};
  }
};

const writeEncryptedServerPublicKeys = async (
  username: string,
  publicKey: string,
  privateKey: string,
  serverPublicKeys: Record<string, string>,
): Promise<void> => {
  const message = await openpgp.createMessage({
    text: JSON.stringify(serverPublicKeys),
  });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKey }),
  });
  localStorage.setItem(getServerPublicKeyMapKey(username), encrypted);
};

export interface StoredKeys {
  username: string;
  userId?: string;
  privateKey: string;
  publicKey: string;
  serverPublicKey: string;
  sessionId?: string;
}

export type UserPublicKeyEntry = {
  publicKey: string;
  updatedAt?: number;
  blocked?: boolean;
  blockedAt?: number;
  blockedBy?: string[];
};

export type SharedAccountPackage = {
  username: string;
  privateKey: string;
  publicKey: string;
  serverPublicKey: string;
  serverMemberships?: ServerMembership[];
  userPubKeys?: Record<string, UserPublicKeyInput>;
  blockedUsers?: Record<
    string,
    {
      blockedAt?: number;
      blockedBy?: string[];
    }
  >;
};

export const encryptSharedAccountPackageForRecipient = async (
  accountPackage: SharedAccountPackage,
  recipientPublicKeyArmored: string,
): Promise<string> => {
  const recipientPublicKey = await openpgp.readKey({
    armoredKey: recipientPublicKeyArmored,
  });
  const message = await openpgp.createMessage({
    text: JSON.stringify(accountPackage),
  });

  return openpgp.encrypt({
    message,
    encryptionKeys: recipientPublicKey,
  });
};

export const decryptSharedAccountPackageForRecipient = async (
  encryptedArmored: string,
  recipientPrivateKeyArmored: string,
): Promise<SharedAccountPackage> => {
  const decryptedText = await decryptMessageForUser(
    encryptedArmored,
    recipientPrivateKeyArmored,
  );

  const parsed = JSON.parse(decryptedText) as SharedAccountPackage;
  if (
    !parsed ||
    typeof parsed.username !== 'string' ||
    typeof parsed.privateKey !== 'string' ||
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.serverPublicKey !== 'string'
  ) {
    throw new Error('Invalid shared account package payload');
  }

  return parsed;
};

type UserPublicKeyInput = string | UserPublicKeyEntry;

const normalizeUserPublicKeyEntries = (
  input: Record<string, UserPublicKeyInput> | null,
): Record<string, UserPublicKeyEntry> => {
  if (!input) return {};

  const normalized: Record<string, UserPublicKeyEntry> = {};
  for (const [username, raw] of Object.entries(input)) {
    if (typeof raw === 'string') {
      normalized[username] = { publicKey: raw, blocked: false };
      continue;
    }

    if (raw && typeof raw === 'object') {
      normalized[username] = {
        publicKey: raw.publicKey || '',
        updatedAt:
          typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
        blocked: !!raw.blocked,
        blockedAt:
          typeof raw.blockedAt === 'number' ? raw.blockedAt : undefined,
        blockedBy: Array.isArray(raw.blockedBy)
          ? raw.blockedBy.filter(
              (value): value is string =>
                typeof value === 'string' && value.trim() !== '',
            )
          : undefined,
      };
    }
  }

  return normalized;
};

const cacheUnlockedPrivateKey = async (
  username: string,
  privateKey: string,
): Promise<void> => {
  unlockedPrivateKeyCache.set(username, privateKey);
  await brokerSetPrivateKey(username, privateKey);
};

const getCachedPrivateKey = async (
  username: string,
): Promise<string | null> => {
  const fromMemory = unlockedPrivateKeyCache.get(username);
  if (fromMemory) {
    return fromMemory;
  }

  const fromBroker = await brokerGetPrivateKey(username);
  if (fromBroker) {
    unlockedPrivateKeyCache.set(username, fromBroker);
    return fromBroker;
  }

  return null;
};

const clearCachedPrivateKey = async (username: string): Promise<void> => {
  unlockedPrivateKeyCache.delete(username);
  await brokerClearPrivateKey(username);
};

/**
 * Generate a new GPG key pair for a user
 */
export const generateKeyPair = async (
  username: string,
): Promise<{
  privateKey: string;
  publicKey: string;
}> => {
  console.log('[GPG] Generating key pair for user:', username);

  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048,
    userIDs: [{ name: username, email: `${username}@chat.local` }],
    passphrase: '', // No passphrase for simplicity
  });

  // In openpgp v6, generateKey already returns armored strings
  const privateKeyArmored = privateKey;
  const publicKeyArmored = publicKey;

  console.log('[GPG] ✓ Key pair generated');

  return {
    privateKey: privateKeyArmored,
    publicKey: publicKeyArmored,
  };
};

/**
 * Store keys in localStorage for a specific user
 */
export const storeKeys = async (
  keys: StoredKeys,
  password: string,
): Promise<void> => {
  await storeKeysForUser(keys, true, password);
};

export const storeKeysForUser = async (
  keys: StoredKeys,
  setAsCurrent: boolean,
  password?: string,
): Promise<void> => {
  if (typeof window === 'undefined') return;

  let encryptedPrivateKey = keys.privateKey;
  if (isEncryptedPrivateKeyEnvelope(keys.privateKey)) {
    encryptedPrivateKey = keys.privateKey;
  } else {
    if (!password) {
      throw new Error('Password is required to store unencrypted private keys');
    }
    encryptedPrivateKey = await encryptPrivateKeyWithPassword(
      keys.privateKey,
      password,
    );
    await cacheUnlockedPrivateKey(keys.username, keys.privateKey);
  }

  // Store per-user data
  localStorage.setItem(
    getUserStorageKey(keys.username, 'privateKey'),
    encryptedPrivateKey,
  );
  localStorage.setItem(
    getUserStorageKey(keys.username, 'publicKey'),
    keys.publicKey,
  );
  if (keys.userId) {
    localStorage.setItem(
      getUserStorageKey(keys.username, 'userId'),
      keys.userId,
    );
  }
  if (keys.sessionId) {
    localStorage.setItem(
      getUserStorageKey(keys.username, 'sessionId'),
      keys.sessionId,
    );
  }

  if (setAsCurrent) {
    // Store current session user pointers.
    localStorage.setItem(STORAGE_KEYS.USERNAME, keys.username);
    if (keys.userId) {
      localStorage.setItem(STORAGE_KEYS.USER_ID, keys.userId);
    }
    localStorage.setItem(STORAGE_KEYS.PRIVATE_KEY, encryptedPrivateKey);
    localStorage.setItem(STORAGE_KEYS.PUBLIC_KEY, keys.publicKey);
    if (keys.sessionId) {
      localStorage.setItem(STORAGE_KEYS.SESSION_ID, keys.sessionId);
    }
  }

  // Add to all users list
  const allUsers = getAllLocalUsers();
  if (!allUsers.includes(keys.username)) {
    allUsers.push(keys.username);
    localStorage.setItem(STORAGE_KEYS.ALL_USERS, JSON.stringify(allUsers));
  }

  console.log('[GPG] ✓ Keys stored in localStorage for user:', keys.username);
};

export const loadStoredKeyMetadataForUser = (
  username: string,
): StoredKeyMetadata | null => {
  if (typeof window === 'undefined') return null;

  const privateKeyEncrypted = localStorage.getItem(
    getUserStorageKey(username, 'privateKey'),
  );
  const publicKey = localStorage.getItem(
    getUserStorageKey(username, 'publicKey'),
  );
  const userId = localStorage.getItem(getUserStorageKey(username, 'userId'));
  const sessionId = localStorage.getItem(
    getUserStorageKey(username, 'sessionId'),
  );

  if (!privateKeyEncrypted || !publicKey) {
    return null;
  }

  return {
    username,
    userId: userId || undefined,
    publicKey,
    sessionId: sessionId || undefined,
    privateKeyEncrypted,
  };
};

export const unlockStoredPrivateKeyForUser = async (
  username: string,
  password: string,
): Promise<boolean> => {
  const metadata = loadStoredKeyMetadataForUser(username);
  if (!metadata) {
    return false;
  }

  try {
    const privateKey = await decryptPrivateKeyWithPassword(
      metadata.privateKeyEncrypted,
      password,
    );
    await cacheUnlockedPrivateKey(username, privateKey);
    return true;
  } catch {
    return false;
  }
};

export const primeUnlockedPrivateKeyForUser = async (
  username: string,
  privateKey: string,
): Promise<void> => {
  await cacheUnlockedPrivateKey(username, privateKey);
};

export const clearUnlockedPrivateKeyForUser = async (
  username: string,
): Promise<void> => {
  await clearCachedPrivateKey(username);
};

export const loadKeysForUserUnlocked = async (
  username: string,
): Promise<StoredKeys | null> => {
  const metadata = loadStoredKeyMetadataForUser(username);
  if (!metadata) {
    return null;
  }

  const privateKey = await getCachedPrivateKey(username);
  if (!privateKey) {
    return null;
  }

  return {
    username: metadata.username,
    userId: metadata.userId,
    privateKey,
    publicKey: metadata.publicKey,
    serverPublicKey: '',
    sessionId: metadata.sessionId,
  };
};

export const updateStoredSessionForUser = async (params: {
  username: string;
  sessionId: string;
  userId?: string;
  serverPublicKey?: string;
  serverId?: string;
}): Promise<void> => {
  if (typeof window === 'undefined') return;

  const { username, sessionId, userId, serverPublicKey } = params;
  const resolvedServerId = explicitServerStorageId(params.serverId);
  const privateKey = await getCachedPrivateKey(username);
  const metadata = loadStoredKeyMetadataForUser(username);
  if (privateKey && metadata?.publicKey && resolvedServerId) {
    const sessions = await readEncryptedServerSessions(username, privateKey);
    sessions[resolvedServerId] = sessionId;
    await writeEncryptedServerSessions(
      username,
      metadata.publicKey,
      privateKey,
      sessions,
    );
    if (serverPublicKey) {
      const serverPublicKeys = await readEncryptedServerPublicKeys(
        username,
        privateKey,
      );
      serverPublicKeys[resolvedServerId] = serverPublicKey;
      await writeEncryptedServerPublicKeys(
        username,
        metadata.publicKey,
        privateKey,
        serverPublicKeys,
      );
    }
  }
  localStorage.setItem(getUserStorageKey(username, 'sessionId'), sessionId);
  localStorage.setItem(STORAGE_KEYS.USERNAME, username);
  localStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId);

  if (metadata) {
    localStorage.setItem(
      STORAGE_KEYS.PRIVATE_KEY,
      metadata.privateKeyEncrypted,
    );
    localStorage.setItem(STORAGE_KEYS.PUBLIC_KEY, metadata.publicKey);
  }

  if (userId) {
    localStorage.setItem(getUserStorageKey(username, 'userId'), userId);
    localStorage.setItem(STORAGE_KEYS.USER_ID, userId);
  }
};

export const clearServerSessionForUser = async (
  username: string,
  serverId: string,
): Promise<void> => {
  const privateKey = await getCachedPrivateKey(username);
  const metadata = loadStoredKeyMetadataForUser(username);
  if (!privateKey || !metadata?.publicKey || !serverId) return;
  const sessions = await readEncryptedServerSessions(username, privateKey);
  delete sessions[serverId];
  await writeEncryptedServerSessions(
    username,
    metadata.publicKey,
    privateKey,
    sessions,
  );
  const serverPublicKeys = await readEncryptedServerPublicKeys(
    username,
    privateKey,
  );
  delete serverPublicKeys[serverId];
  await writeEncryptedServerPublicKeys(
    username,
    metadata.publicKey,
    privateKey,
    serverPublicKeys,
  );
};

/**
 * Get all local usernames (users with private keys stored locally)
 * This function scans localStorage to find all users with stored keys
 */
export const getAllLocalUsers = (): string[] => {
  if (typeof window === 'undefined') return [];

  const usersSet = new Set<string>();

  // First, get users from the ALL_USERS list
  const stored = localStorage.getItem(STORAGE_KEYS.ALL_USERS);
  if (stored) {
    try {
      const usersFromList = JSON.parse(stored);
      usersFromList.forEach((user: string) => usersSet.add(user));
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Scan all localStorage keys to find users with stored private keys
  // This ensures we don't miss any users even if ALL_USERS list is out of sync
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('gpg_user_') && key.endsWith('_privateKey')) {
      // Extract username from key pattern: gpg_user_{username}_privateKey
      const match = key.match(/^gpg_user_(.+)_privateKey$/);
      if (match && match[1]) {
        usersSet.add(match[1]);
      }
    }
  }

  // Verify each user actually has a private key stored
  const verifiedUsers: string[] = [];
  usersSet.forEach((user) => {
    const privateKey = localStorage.getItem(
      getUserStorageKey(user, 'privateKey'),
    );
    if (privateKey) {
      verifiedUsers.push(user);
    }
  });

  // Update ALL_USERS list with all verified users (ensures it's always in sync)
  if (verifiedUsers.length > 0) {
    const uniqueUsers = Array.from(new Set(verifiedUsers));
    localStorage.setItem(STORAGE_KEYS.ALL_USERS, JSON.stringify(uniqueUsers));
    console.log('[GPG] Found', uniqueUsers.length, 'local users:', uniqueUsers);
  } else {
    // Clear ALL_USERS if no users found
    localStorage.removeItem(STORAGE_KEYS.ALL_USERS);
  }

  return verifiedUsers.sort();
};

/**
 * Get all users we have public keys for (local users + users whose public keys are stored)
 */
export const getAllUsersWithPublicKeys = (): string[] => {
  if (typeof window === 'undefined') return [];

  const usersSet = new Set<string>();

  // Add local users (users with private keys)
  const localUsers = getAllLocalUsers();
  localUsers.forEach((user) => usersSet.add(user));

  // Add users whose public keys we have stored
  const userPubKeys = loadUserPublicKeys();
  if (userPubKeys) {
    Object.keys(userPubKeys).forEach((user) => usersSet.add(user));
  }

  return Array.from(usersSet).sort();
};

/**
 * Check if a user is a local user (has private key stored)
 */
export const isLocalUser = (username: string): boolean => {
  if (typeof window === 'undefined') return false;

  // Check if user has private key stored
  const privateKey = localStorage.getItem(
    getUserStorageKey(username, 'privateKey'),
  );
  return !!privateKey;
};

/**
 * Load keys for a specific user
 */
export const loadKeysForUser = (username: string): StoredKeys | null => {
  const metadata = loadStoredKeyMetadataForUser(username);
  if (!metadata) {
    return null;
  }

  const privateKey = unlockedPrivateKeyCache.get(username);
  if (!privateKey) {
    return null;
  }

  return {
    username: metadata.username,
    userId: metadata.userId,
    privateKey,
    publicKey: metadata.publicKey,
    serverPublicKey: '',
    sessionId: metadata.sessionId,
  };
};

export const loadKeysForUserAsync = async (
  username: string,
): Promise<StoredKeys | null> => {
  const metadata = loadStoredKeyMetadataForUser(username);
  if (!metadata) {
    return null;
  }

  const privateKey = await getCachedPrivateKey(username);
  if (!privateKey) {
    return null;
  }

  const serverId = activeServerStorageId();
  const sessions = await readEncryptedServerSessions(username, privateKey);
  const serverPublicKeys = await readEncryptedServerPublicKeys(
    username,
    privateKey,
  );
  const sessionId = serverId
    ? sessions[serverId] || metadata.sessionId
    : metadata.sessionId;
  const serverPublicKey = serverId ? serverPublicKeys[serverId] || '' : '';
  return {
    username,
    userId: metadata.userId,
    privateKey,
    publicKey: metadata.publicKey,
    serverPublicKey,
    sessionId,
  };
};

/**
 * Load keys from localStorage
 */
export const loadKeys = (): StoredKeys | null => {
  if (typeof window === 'undefined') return null;

  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
  const userId = localStorage.getItem(STORAGE_KEYS.USER_ID);
  const publicKey = localStorage.getItem(STORAGE_KEYS.PUBLIC_KEY);
  const sessionId = localStorage.getItem(STORAGE_KEYS.SESSION_ID);
  const privateKey = username
    ? unlockedPrivateKeyCache.get(username) || null
    : null;

  if (!username || !privateKey || !publicKey) {
    console.log('[GPG] No unlocked keys available in volatile cache');
    return null;
  }

  console.log('[GPG] ✓ Keys loaded from localStorage');
  return {
    username,
    userId: userId || undefined,
    privateKey,
    publicKey,
    serverPublicKey: '',
    sessionId: sessionId || undefined,
  };
};

export const loadKeysAsync = async (): Promise<StoredKeys | null> => {
  if (typeof window === 'undefined') return null;

  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
  if (!username) {
    return null;
  }

  const metadata = loadStoredKeyMetadataForUser(username);
  if (!metadata) {
    return null;
  }

  const privateKey = await getCachedPrivateKey(username);
  if (!privateKey) {
    return null;
  }

  const serverId = activeServerStorageId();
  const sessions = await readEncryptedServerSessions(username, privateKey);
  const serverPublicKeys = await readEncryptedServerPublicKeys(
    username,
    privateKey,
  );
  const sessionId = serverId
    ? sessions[serverId] || metadata.sessionId
    : metadata.sessionId;
  const serverPublicKey = serverId ? serverPublicKeys[serverId] || '' : '';
  return {
    username,
    userId: metadata.userId,
    privateKey,
    publicKey: metadata.publicKey,
    serverPublicKey,
    sessionId,
  };
};

/**
 * Returns true if the armored string is a parseable OpenPGP private key.
 */
export const isValidPrivateKey = async (
  privateKeyArmored: string,
): Promise<boolean> => {
  if (!privateKeyArmored?.trim()) {
    return false;
  }

  try {
    await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    return true;
  } catch {
    return false;
  }
};

/**
 * Returns true if the current user has stored keys with a valid private key.
 */
export const hasValidStoredKeys = async (): Promise<boolean> => {
  const keys = await loadKeysAsync();
  if (!keys) {
    return false;
  }
  return isValidPrivateKey(keys.privateKey);
};

/**
 * Navigate to the logout page (which clears session and sends user to login).
 */
export const redirectToLogout = (): void => {
  if (typeof window === 'undefined') return;
  const serverId = activeServerId();
  const logoutPath = withBasePath('/logout/');
  window.location.href = serverId
    ? `${logoutPath}?server=${encodeURIComponent(serverId)}`
    : logoutPath;
};

/**
 * Force re-authentication by clearing the current session and sending user to login.
 *
 * Use this for auth guard failures to avoid depending on /logout route handling.
 */
export const forceReauthToLogin = (): void => {
  if (typeof window === 'undefined') return;

  const loginPath = withBasePath('/login/').replace(/\/+$/, '');
  const currentPath = window.location.pathname.replace(/\/+$/, '');
  const serverId = activeServerId();

  clearSession();

  // Avoid hard reload loops when a guard fires while we're already on login.
  if (currentPath === loginPath) {
    return;
  }

  window.location.href = serverId
    ? `${withBasePath('/login/')}?server=${encodeURIComponent(serverId)}`
    : withBasePath('/login/');
};

/**
 * Clear session for current user (logout) - keeps keys so user can log back in
 */
export const clearSession = (): void => {
  if (typeof window === 'undefined') return;

  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);

  if (username) {
    void clearCachedPrivateKey(username);
  }

  // Clear current session data
  localStorage.removeItem(STORAGE_KEYS.USERNAME);
  localStorage.removeItem(STORAGE_KEYS.USER_ID);
  localStorage.removeItem(STORAGE_KEYS.PRIVATE_KEY);
  localStorage.removeItem(STORAGE_KEYS.PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_ID);

  // Clear session ID from per-user data (but keep keys)
  if (username) {
    localStorage.removeItem(getUserStorageKey(username, 'sessionId'));
    // Keep the account key material for re-login.
  }

  console.log('[GPG] ✓ Session cleared (keys preserved for re-login)');
};

/**
 * Clear all stored keys for current user (full logout - use clearSession for normal logout)
 * This is used when we want to completely remove a user's data
 */
export const clearKeys = (): void => {
  if (typeof window === 'undefined') return;

  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);

  unlockedPrivateKeyCache.clear();
  if (username) {
    void clearCachedPrivateKey(username);
  }
  void brokerClearAllPrivateKeys();

  // Clear current user data
  localStorage.removeItem(STORAGE_KEYS.USERNAME);
  localStorage.removeItem(STORAGE_KEYS.USER_ID);
  localStorage.removeItem(STORAGE_KEYS.PRIVATE_KEY);
  localStorage.removeItem(STORAGE_KEYS.PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_ID);

  // Clear per-user data if username exists
  if (username) {
    localStorage.removeItem(getUserStorageKey(username, 'privateKey'));
    localStorage.removeItem(getUserStorageKey(username, 'publicKey'));
    localStorage.removeItem(getUserStorageKey(username, 'sessionId'));
  }

  console.log('[GPG] ✓ All keys cleared from localStorage');
};

/**
 * Delete a specific user's keys from localStorage
 */
export const deleteUserKeys = (username: string): void => {
  if (typeof window === 'undefined') return;

  void clearCachedPrivateKey(username);

  // Remove per-user data
  localStorage.removeItem(getUserStorageKey(username, 'privateKey'));
  localStorage.removeItem(getUserStorageKey(username, 'publicKey'));
  localStorage.removeItem(getUserStorageKey(username, 'userId'));
  localStorage.removeItem(getUserStorageKey(username, 'sessionId'));

  // Remove from all users list
  const allUsers = getAllLocalUsers();
  const updatedUsers = allUsers.filter((u) => u !== username);
  if (updatedUsers.length === 0) {
    localStorage.removeItem(STORAGE_KEYS.ALL_USERS);
  } else {
    localStorage.setItem(STORAGE_KEYS.ALL_USERS, JSON.stringify(updatedUsers));
  }

  // If this was the current user, clear current user data too
  const currentUser = localStorage.getItem(STORAGE_KEYS.USERNAME);
  if (currentUser === username) {
    clearKeys();
  }

  console.log('[GPG] ✓ Deleted keys for user:', username);
};

/**
 * Get server's public key from the server
 */
export const fetchServerPublicKey = async (): Promise<string> => {
  const response = await fetch(apiPath('/api/server-public-key'));
  if (!response.ok) {
    throw new Error('Failed to fetch server public key');
  }
  const data = await response.json();
  return data.publicKey;
};

const bytesToHex = (bytes: Uint8Array): string => {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

export const buildOpaqueUsernameEnvelope = async (
  username: string,
  ownerPublicKey: string,
): Promise<{ usernameHash: string; usernameCiphertext: string }> => {
  if (!ownerPublicKey || ownerPublicKey.trim() === '') {
    throw new Error(
      'Refusing to build a username envelope without the account public key',
    );
  }

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(username),
  );
  const usernameHash = bytesToHex(new Uint8Array(digest));
  const usernameCiphertext = await encryptForAllUsers(
    username,
    {},
    ownerPublicKey,
  );
  return { usernameHash, usernameCiphertext };
};

const submitChallengeResponse = async (
  userId: string,
  decryptedUUID: string,
  serverPublicKey: string,
): Promise<{ sessionId?: string; userId: string; error?: string }> => {
  const encryptedResponse = await encryptForServer(
    decryptedUUID,
    serverPublicKey,
  );

  const verifyResponse = await fetch(apiPath('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      encryptedUUID: encryptedResponse,
    }),
  });

  if (!verifyResponse.ok) {
    return { error: 'Challenge-response request failed', userId: '' };
  }

  const verifyData = await verifyResponse.json();
  return {
    sessionId: verifyData.sessionId,
    userId: verifyData.userId || '',
    error: verifyData.error,
  };
};

/**
 * Verify an encrypted challenge response, refreshing server public key once
 * if verification fails (e.g., after server key rotation).
 */
export const verifyChallengeResponseWithKeyRefresh = async (params: {
  userId: string;
  decryptedUUID: string;
  serverPublicKey: string;
}): Promise<{
  sessionId?: string;
  userId: string;
  error?: string;
  serverPublicKey: string;
}> => {
  const { userId, decryptedUUID } = params;
  let currentServerPublicKey = params.serverPublicKey;

  const initial = await submitChallengeResponse(
    userId,
    decryptedUUID,
    currentServerPublicKey,
  );
  if (initial.sessionId) {
    return {
      sessionId: initial.sessionId,
      userId: initial.userId,
      serverPublicKey: currentServerPublicKey,
    };
  }

  try {
    const refreshedServerPublicKey = await fetchServerPublicKey();
    if (refreshedServerPublicKey !== currentServerPublicKey) {
      currentServerPublicKey = refreshedServerPublicKey;
      const retried = await submitChallengeResponse(
        userId,
        decryptedUUID,
        currentServerPublicKey,
      );
      if (retried.sessionId) {
        return {
          sessionId: retried.sessionId,
          userId: retried.userId,
          serverPublicKey: currentServerPublicKey,
        };
      }

      return {
        error: retried.error || initial.error,
        userId: retried.userId,
        serverPublicKey: currentServerPublicKey,
      };
    }
  } catch {
    // Ignore fetch failure and return original verification error below.
  }

  return {
    error: initial.error,
    userId: initial.userId,
    serverPublicKey: currentServerPublicKey,
  };
};

/**
 * Decrypt a message with the user's private key
 */
export const decryptMessage = async (
  encryptedArmored: string,
  privateKeyArmored: string,
): Promise<string> => {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  const message = await openpgp.readMessage({
    armoredMessage: encryptedArmored,
  });

  const { data: decrypted } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
  });

  return decrypted.toString();
};

/**
 * Encrypt a message with the server's public key
 */
export const encryptForServer = async (
  plaintext: string,
  serverPublicKeyArmored: string,
): Promise<string> => {
  const serverPublicKey = await openpgp.readKey({
    armoredKey: serverPublicKeyArmored,
  });

  const message = await openpgp.createMessage({ text: plaintext });

  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: serverPublicKey,
  });

  // In openpgp v6, encrypt returns a string directly
  return encrypted;
};

export const signDetachedText = async (
  text: string,
  privateKeyArmored: string,
): Promise<string> => {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  const message = await openpgp.createMessage({ text });
  return openpgp.sign({
    message,
    signingKeys: privateKey,
    detached: true,
  });
};

export const verifyDetachedTextSignature = async (
  text: string,
  signatureArmored: string,
  publicKeyArmored: string,
  verificationDate?: Date,
): Promise<boolean> => {
  const effectiveVerificationDate =
    verificationDate || new Date(Date.now() + 5 * 60 * 1000);
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const signature = await openpgp.readSignature({
    armoredSignature: signatureArmored,
  });
  const message = await openpgp.createMessage({ text });
  const result = await openpgp.verify({
    message,
    signature,
    verificationKeys: publicKey,
    date: effectiveVerificationDate,
  });
  const first = result.signatures[0];
  if (!first) {
    return false;
  }
  await first.verified;
  return true;
};

/**
 * Store all user public keys
 */
export const storeUserPublicKeys = (
  userPubKeys: Record<string, UserPublicKeyInput>,
  userPubKeysUpdatedAt?: Record<string, number>,
): void => {
  if (typeof window === 'undefined') return;

  const existing = loadUserPublicKeyEntries() || {};
  const incoming = normalizeUserPublicKeyEntries(userPubKeys);
  const merged: Record<string, UserPublicKeyEntry> = { ...existing };

  for (const [username, nextEntry] of Object.entries(incoming)) {
    const prior = existing[username];
    const incomingUpdatedAtRaw = userPubKeysUpdatedAt?.[username];
    const incomingUpdatedAt =
      Number.isFinite(incomingUpdatedAtRaw) &&
      (incomingUpdatedAtRaw as number) > 0
        ? Math.trunc(incomingUpdatedAtRaw as number)
        : Number.isFinite(nextEntry.updatedAt) &&
            (nextEntry.updatedAt as number) > 0
          ? Math.trunc(nextEntry.updatedAt as number)
          : 0;
    const priorUpdatedAt =
      Number.isFinite(prior?.updatedAt) && (prior?.updatedAt as number) > 0
        ? Math.trunc(prior?.updatedAt as number)
        : 0;
    const shouldReplacePublicKey =
      !prior?.publicKey ||
      incomingUpdatedAt === 0 ||
      priorUpdatedAt === 0 ||
      incomingUpdatedAt >= priorUpdatedAt;

    merged[username] = {
      publicKey: shouldReplacePublicKey
        ? nextEntry.publicKey || prior?.publicKey || ''
        : prior?.publicKey || nextEntry.publicKey || '',
      updatedAt:
        incomingUpdatedAt > 0
          ? Math.max(priorUpdatedAt, incomingUpdatedAt)
          : priorUpdatedAt || undefined,
      blocked: prior?.blocked || nextEntry.blocked || false,
      blockedAt: prior?.blockedAt || nextEntry.blockedAt,
      blockedBy: Array.from(
        new Set([...(prior?.blockedBy || []), ...(nextEntry.blockedBy || [])]),
      ),
    };
  }

  localStorage.setItem(STORAGE_KEYS.USER_PUBLIC_KEYS, JSON.stringify(merged));
  console.log(
    '[GPG] ✓ Stored user public keys:',
    Object.keys(merged).length,
    'keys',
  );
};

export const loadUserPublicKeyEntries = (): Record<
  string,
  UserPublicKeyEntry
> | null => {
  if (typeof window === 'undefined') return null;

  const stored = localStorage.getItem(STORAGE_KEYS.USER_PUBLIC_KEYS);
  if (!stored) {
    console.log('[GPG] No user public keys found in localStorage');
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as Record<string, UserPublicKeyInput>;
    const entries = normalizeUserPublicKeyEntries(parsed);
    return entries;
  } catch (e) {
    console.error('[GPG] ✗ Failed to parse user public keys:', e);
    return null;
  }
};

/**
 * Load all user public keys
 */
export const loadUserPublicKeys = (): Record<string, string> | null => {
  const entries = loadUserPublicKeyEntries();
  if (!entries) return null;

  const keys: Record<string, string> = {};
  for (const [username, entry] of Object.entries(entries)) {
    if (entry.publicKey) {
      keys[username] = entry.publicKey;
    }
  }

  console.log(
    '[GPG] ✓ Loaded user public keys:',
    Object.keys(keys).length,
    'keys',
  );
  return keys;
};

export const importSharedAccountPackage = (
  fromUser: string,
  accountPackage: SharedAccountPackage,
): void => {
  if (typeof window === 'undefined') return;

  if (
    !accountPackage.username ||
    !accountPackage.privateKey ||
    !accountPackage.publicKey ||
    !accountPackage.serverPublicKey
  ) {
    console.warn('[GPG] Invalid shared account package received');
    return;
  }

  if (Array.isArray(accountPackage.serverMemberships)) {
    mergeServerMemberships(accountPackage.serverMemberships);
  }

  void storeKeysForUser(
    {
      username: accountPackage.username,
      privateKey: accountPackage.privateKey,
      publicKey: accountPackage.publicKey,
      serverPublicKey: accountPackage.serverPublicKey,
    },
    false,
  ).catch((error) => {
    console.warn(
      '[GPG] Skipped shared account private key import because encrypted storage now requires a password:',
      error,
    );
  });

  const mergedPubKeys: Record<string, UserPublicKeyInput> = {
    ...(accountPackage.userPubKeys || {}),
    [accountPackage.username]: {
      publicKey: accountPackage.publicKey,
      blocked: false,
    },
  };

  if (accountPackage.blockedUsers) {
    for (const [blockedUser, blockedInfo] of Object.entries(
      accountPackage.blockedUsers,
    )) {
      const existing =
        (mergedPubKeys[blockedUser] as UserPublicKeyEntry | undefined) ||
        ({ publicKey: '' } as UserPublicKeyEntry);

      const blockedBy = new Set([
        ...(existing.blockedBy || []),
        ...(blockedInfo.blockedBy || [fromUser]),
      ]);

      mergedPubKeys[blockedUser] = {
        ...existing,
        blocked: blockedBy.size > 0,
        blockedAt: blockedInfo.blockedAt || existing.blockedAt,
        blockedBy: Array.from(blockedBy),
      };
    }
  }

  storeUserPublicKeys(mergedPubKeys);
  console.log(
    '[GPG] ✓ Imported shared account package for',
    accountPackage.username,
  );
};

/**
 * Filter public keys for outbound encryption (respects blocks and DM room scope).
 */
export const filterPubKeysForEncryption = (
  userPubKeys: Record<string, UserPublicKeyInput>,
  options: { room?: string; blockedUsers?: string[] },
): Record<string, string> => {
  const entries = normalizeUserPublicKeyEntries(userPubKeys);
  const blocked = new Set(options.blockedUsers ?? getBlockedUsers());
  const filtered: Record<string, string> = {};

  for (const [user, entry] of Object.entries(entries)) {
    if (!blocked.has(user) && !entry.blocked && entry.publicKey) {
      filtered[user] = entry.publicKey;
    }
  }

  if (options.room && isDmRoom(options.room)) {
    const participants = getDmParticipants(options.room);
    if (participants) {
      const dmKeys: Record<string, string> = {};
      for (const p of participants) {
        if (filtered[p]) {
          dmKeys[p] = filtered[p];
        }
      }
      return dmKeys;
    }
  }

  return filtered;
};

type MessageEnvelopeV2 = {
  version: 'msg-v2';
  iv: string;
  ciphertext: string;
  keyEnvelopes: Record<string, string>;
};

const toOwnedBytes = (value: ArrayLike<number>): Uint8Array =>
  Uint8Array.from(value);

const parseMessageEnvelope = (value: string): MessageEnvelopeV2 | null => {
  try {
    const parsed = JSON.parse(value) as Partial<MessageEnvelopeV2>;
    if (
      parsed.version !== 'msg-v2' ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ciphertext !== 'string' ||
      !parsed.keyEnvelopes ||
      typeof parsed.keyEnvelopes !== 'object'
    ) {
      return null;
    }
    return parsed as MessageEnvelopeV2;
  } catch {
    return null;
  }
};

/** Encrypt the body once and wrap its random content key for each recipient. */
export const encryptForAllUsers = async (
  plaintext: string,
  userPubKeys: Record<string, string>,
  senderPublicKey?: string,
): Promise<string> => {
  const recipientKeys = new Set<string>();
  for (const armoredKey of Object.values(userPubKeys)) {
    if (typeof armoredKey === 'string' && armoredKey.trim() !== '') {
      recipientKeys.add(armoredKey);
    }
  }
  if (senderPublicKey && senderPublicKey.trim() !== '') {
    recipientKeys.add(senderPublicKey);
  }

  if (recipientKeys.size === 0) {
    throw new Error('No encryption recipients available');
  }

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    'raw',
    contentKey,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const bodyCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );

  const keyEnvelopes: Record<string, string> = {};
  let envelopeIndex = 0;
  for (const armoredKey of recipientKeys) {
    const encryptionKey = await openpgp.readKey({ armoredKey });
    const keyMessage = await openpgp.createMessage({
      text: bytesToBase64(contentKey),
    });
    keyEnvelopes[String(envelopeIndex)] = await openpgp.encrypt({
      message: keyMessage,
      encryptionKeys: encryptionKey,
    });
    envelopeIndex += 1;
  }

  const envelope: MessageEnvelopeV2 = {
    version: 'msg-v2',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(bodyCiphertext)),
    keyEnvelopes,
  };
  return JSON.stringify(envelope);
};

/**
 * Decrypt a message with the user's private key
 */
export const decryptMessageForUser = async (
  encryptedArmored: string,
  privateKeyArmored: string,
  options?: { suppressErrorLog?: boolean },
): Promise<string> => {
  const suppressErrorLog = options?.suppressErrorLog === true;

  try {
    const envelope = parseMessageEnvelope(encryptedArmored);
    const privateKey = await openpgp.readPrivateKey({
      armoredKey: privateKeyArmored,
    });

    if (envelope) {
      let rawContentKey: Uint8Array | string | undefined;
      for (const recipientKey of Object.values(envelope.keyEnvelopes)) {
        try {
          const keyMessage = await openpgp.readMessage({
            armoredMessage: recipientKey,
          });
          const result = await openpgp.decrypt({
            message: keyMessage,
            decryptionKeys: privateKey,
          });
          rawContentKey = result.data;
          break;
        } catch {
          // Try the next recipient envelope; only the intended recipient can unwrap one.
        }
      }
      if (!rawContentKey)
        throw new Error('Message is not encrypted for this user');
      const contentKey = toOwnedBytes(
        typeof rawContentKey === 'string'
          ? base64ToBytes(rawContentKey)
          : ArrayBuffer.isView(rawContentKey)
            ? new Uint8Array(
                rawContentKey.buffer,
                rawContentKey.byteOffset,
                rawContentKey.byteLength,
              )
            : new Uint8Array(rawContentKey as unknown as ArrayBuffer),
      );
      if (contentKey.byteLength !== 32) {
        throw new Error('Message key envelope contained an invalid key length');
      }
      const aesKey = await crypto.subtle.importKey(
        'raw',
        contentKey,
        'AES-GCM',
        false,
        ['decrypt'],
      );
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toOwnedBytes(base64ToBytes(envelope.iv)) },
        aesKey,
        toOwnedBytes(base64ToBytes(envelope.ciphertext)),
      );
      return new TextDecoder().decode(plaintext);
    }

    const message = await openpgp.readMessage({
      armoredMessage: encryptedArmored,
    });

    const { data: decrypted } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
    });

    return decrypted.toString();
  } catch (error) {
    if (!suppressErrorLog) {
      console.error('[GPG] ✗ Failed to decrypt message:', error);
    }
    throw error;
  }
};

export const encryptJsonForCurrentUser = async (
  value: unknown,
): Promise<string> => {
  const keys = await loadKeysAsync();
  if (!keys?.publicKey || !keys?.username) {
    throw new Error('Missing local key material for at-rest encryption');
  }

  return encryptForAllUsers(
    JSON.stringify(value),
    {},
    keys.publicKey,
  );
};

export const decryptJsonForCurrentUser = async <T>(
  encryptedArmored: string,
): Promise<T> => {
  const keys = await loadKeysAsync();
  if (!keys?.privateKey) {
    throw new Error('Missing local key material for at-rest decryption');
  }

  const raw = await decryptMessageForUser(encryptedArmored, keys.privateKey);
  return JSON.parse(raw) as T;
};

/**
 * Automatically re-establish session using stored credentials when session becomes invalid.
 * This prevents losing the message window context when server restarts.
 * Returns new sessionId if successful, null if re-login fails.
 */
let autoReloginInFlight: Promise<string | null> | null = null;

const attemptAutoReloginInternal = async (): Promise<string | null> => {
  try {
    const keys = await loadKeysAsync();
    if (!keys) {
      console.warn('[GPG] No stored keys available for auto-relogin');
      return null;
    }

    console.log('[GPG] Attempting auto-relogin for user:', keys.username);
    // Use the authoritative userId from storage. Falling back to the local
    // identity map (and worse, minting a brand-new random id via
    // requireUserIdByUsername) here would send the server a userId that
    // doesn't match this account's real registration, which the server
    // treats as a distinct/unknown user and rejects with "Username already
    // exists" — forcing a spurious logout.
    const locallyMappedUserId = getUserIdByUsername(keys.username);
    if (
      keys.userId &&
      locallyMappedUserId &&
      locallyMappedUserId !== keys.userId
    ) {
      console.warn(
        '[GPG] Auto-relogin: local identity map disagrees with stored keys.userId; using keys.userId as authoritative',
        { 'keys.userId': keys.userId, locallyMappedUserId },
      );
    }
    const userId =
      keys.userId ||
      locallyMappedUserId ||
      requireUserIdByUsername(keys.username);
    let serverPublicKey = keys.serverPublicKey;
    try {
      const activeServerPublicKey = await fetchServerPublicKey();
      if (activeServerPublicKey) {
        serverPublicKey = activeServerPublicKey;
      }
    } catch {
      // Keep the stored key as a fallback for legacy/offline recovery.
    }
    const opaqueIdentity = await buildOpaqueUsernameEnvelope(
      keys.username,
      keys.publicKey,
    );

    // Step 1: Send userId and public key to server
    const loginResponse = await fetch(apiPath('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        usernameHash: opaqueIdentity.usernameHash,
        usernameCiphertext: opaqueIdentity.usernameCiphertext,
        publicKey: keys.publicKey,
      }),
    });

    if (!loginResponse.ok) {
      console.warn('[GPG] Auto-relogin: initial login request failed');
      return null;
    }

    const loginData = await loginResponse.json();

    if (loginData.error) {
      console.warn(
        '[GPG] Auto-relogin: server returned error:',
        loginData.error,
        { userIdSent: userId },
      );
      return null;
    }

    // If new user was registered (unlikely after server restart), return sessionId
    if (loginData.sessionId && !loginData.challenge) {
      console.log('[GPG] ✓ Auto-relogin successful (new registration)');
      await updateStoredSessionForUser({
        username: keys.username,
        sessionId: loginData.sessionId,
        userId: loginData.userId || userId,
        serverPublicKey,
      });
      return loginData.sessionId;
    }

    // If we got a challenge, this is an existing user - perform challenge-response
    if (loginData.challenge) {
      console.log(
        '[GPG] Received challenge, performing challenge-response for auto-relogin',
      );

      try {
        // Decrypt the challenge with our private key
        const decryptedUUID = await decryptMessage(
          loginData.challenge,
          keys.privateKey,
        );

        const verifyData = await verifyChallengeResponseWithKeyRefresh({
          userId,
          decryptedUUID,
          serverPublicKey,
        });

        if (verifyData.error) {
          console.warn(
            '[GPG] Auto-relogin: challenge-response rejected:',
            verifyData.error,
          );
          return null;
        }

        if (verifyData.sessionId) {
          console.log('[GPG] ✓ Auto-relogin successful (challenge-response)');
          await updateStoredSessionForUser({
            username: keys.username,
            serverPublicKey: verifyData.serverPublicKey,
            sessionId: verifyData.sessionId,
            userId: verifyData.userId || userId,
          });
          return verifyData.sessionId;
        }

        console.warn('[GPG] Auto-relogin: no sessionId in challenge-response');
        return null;
      } catch (err) {
        console.error(
          '[GPG] Auto-relogin: failed during challenge-response:',
          err,
        );
        return null;
      }
    }

    console.warn('[GPG] Auto-relogin: unexpected response from server');
    return null;
  } catch (err) {
    console.error('[GPG] Auto-relogin failed:', err);
    return null;
  }
};

export const attemptAutoRelogin = (): Promise<string | null> => {
  if (autoReloginInFlight) {
    console.log('[GPG] Reusing in-flight auto-relogin attempt');
    return autoReloginInFlight;
  }

  autoReloginInFlight = attemptAutoReloginInternal().finally(() => {
    autoReloginInFlight = null;
  });
  return autoReloginInFlight;
};
