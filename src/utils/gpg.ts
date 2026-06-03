import * as openpgp from 'openpgp';
import { getDmParticipants, isDmRoom } from './dmRooms';
import { getBlockedUsers } from './userSettings';

const STORAGE_KEYS = {
  USERNAME: 'gpg_username',
  PRIVATE_KEY: 'gpg_private_key',
  PUBLIC_KEY: 'gpg_public_key',
  SERVER_PUBLIC_KEY: 'gpg_server_public_key',
  SESSION_ID: 'gpg_session_id',
  USER_PUBLIC_KEYS: 'gpg_user_public_keys', // Map of username -> public key
  ALL_USERS: 'gpg_all_users', // JSON array of all local usernames
};

// Storage key prefix for per-user data
const getUserStorageKey = (username: string, key: string): string => {
  return `gpg_user_${username}_${key}`;
};

export interface StoredKeys {
  username: string;
  privateKey: string;
  publicKey: string;
  serverPublicKey: string;
  sessionId?: string;
}

/**
 * Generate a new GPG key pair for a user
 */
export async function generateKeyPair(username: string): Promise<{
  privateKey: string;
  publicKey: string;
}> {
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
}

/**
 * Store keys in localStorage for a specific user
 */
export function storeKeys(keys: StoredKeys): void {
  if (typeof window === 'undefined') return;
  
  // Store per-user data
  localStorage.setItem(getUserStorageKey(keys.username, 'privateKey'), keys.privateKey);
  localStorage.setItem(getUserStorageKey(keys.username, 'publicKey'), keys.publicKey);
  localStorage.setItem(getUserStorageKey(keys.username, 'serverPublicKey'), keys.serverPublicKey);
  if (keys.sessionId) {
    localStorage.setItem(getUserStorageKey(keys.username, 'sessionId'), keys.sessionId);
  }
  
  // Store current user (for backward compatibility)
  localStorage.setItem(STORAGE_KEYS.USERNAME, keys.username);
  localStorage.setItem(STORAGE_KEYS.PRIVATE_KEY, keys.privateKey);
  localStorage.setItem(STORAGE_KEYS.PUBLIC_KEY, keys.publicKey);
  localStorage.setItem(STORAGE_KEYS.SERVER_PUBLIC_KEY, keys.serverPublicKey);
  if (keys.sessionId) {
    localStorage.setItem(STORAGE_KEYS.SESSION_ID, keys.sessionId);
  }
  
  // Add to all users list
  const allUsers = getAllLocalUsers();
  if (!allUsers.includes(keys.username)) {
    allUsers.push(keys.username);
    localStorage.setItem(STORAGE_KEYS.ALL_USERS, JSON.stringify(allUsers));
  }
  
  console.log('[GPG] ✓ Keys stored in localStorage for user:', keys.username);
}

/**
 * Get all local usernames (users with private keys stored locally)
 * This function scans localStorage to find all users with stored keys
 */
export function getAllLocalUsers(): string[] {
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
  
  // Also check for legacy single user
  const legacyUser = localStorage.getItem(STORAGE_KEYS.USERNAME);
  if (legacyUser) {
    usersSet.add(legacyUser);
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
  usersSet.forEach(user => {
    const privateKey = localStorage.getItem(getUserStorageKey(user, 'privateKey'));
    const legacyPrivateKey = user === legacyUser ? localStorage.getItem(STORAGE_KEYS.PRIVATE_KEY) : null;
    
    if (privateKey || legacyPrivateKey) {
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
}

/**
 * Get all users we have public keys for (local users + users whose public keys are stored)
 */
export function getAllUsersWithPublicKeys(): string[] {
  if (typeof window === 'undefined') return [];
  
  const usersSet = new Set<string>();
  
  // Add local users (users with private keys)
  const localUsers = getAllLocalUsers();
  localUsers.forEach(user => usersSet.add(user));
  
  // Add users whose public keys we have stored
  const userPubKeys = loadUserPublicKeys();
  if (userPubKeys) {
    Object.keys(userPubKeys).forEach(user => usersSet.add(user));
  }
  
  return Array.from(usersSet).sort();
}

/**
 * Check if a user is a local user (has private key stored)
 */
export function isLocalUser(username: string): boolean {
  if (typeof window === 'undefined') return false;
  
  // Check if user has private key stored
  const privateKey = localStorage.getItem(getUserStorageKey(username, 'privateKey'));
  if (privateKey) return true;
  
  // Check legacy storage
  const legacyUser = localStorage.getItem(STORAGE_KEYS.USERNAME);
  if (legacyUser === username) {
    const legacyPrivateKey = localStorage.getItem(STORAGE_KEYS.PRIVATE_KEY);
    return !!legacyPrivateKey;
  }
  
  return false;
}

/**
 * Load keys for a specific user
 */
export function loadKeysForUser(username: string): StoredKeys | null {
  if (typeof window === 'undefined') return null;
  
  const privateKey = localStorage.getItem(getUserStorageKey(username, 'privateKey'));
  const publicKey = localStorage.getItem(getUserStorageKey(username, 'publicKey'));
  const serverPublicKey = localStorage.getItem(getUserStorageKey(username, 'serverPublicKey'));
  const sessionId = localStorage.getItem(getUserStorageKey(username, 'sessionId'));

  if (!privateKey || !publicKey || !serverPublicKey) {
    return null;
  }

  return {
    username,
    privateKey,
    publicKey,
    serverPublicKey,
    sessionId: sessionId || undefined,
  };
}

/**
 * Load keys from localStorage
 */
export function loadKeys(): StoredKeys | null {
  if (typeof window === 'undefined') return null;
  
  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
  const privateKey = localStorage.getItem(STORAGE_KEYS.PRIVATE_KEY);
  const publicKey = localStorage.getItem(STORAGE_KEYS.PUBLIC_KEY);
  const serverPublicKey = localStorage.getItem(STORAGE_KEYS.SERVER_PUBLIC_KEY);
  const sessionId = localStorage.getItem(STORAGE_KEYS.SESSION_ID);

  if (!username || !privateKey || !publicKey || !serverPublicKey) {
    console.log('[GPG] No keys found in localStorage');
    return null;
  }

  console.log('[GPG] ✓ Keys loaded from localStorage');
  return {
    username,
    privateKey,
    publicKey,
    serverPublicKey,
    sessionId: sessionId || undefined,
  };
}

/**
 * Returns true if the armored string is a parseable OpenPGP private key.
 */
export async function isValidPrivateKey(privateKeyArmored: string): Promise<boolean> {
  if (!privateKeyArmored?.trim()) {
    return false;
  }

  try {
    await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the current user has stored keys with a valid private key.
 */
export async function hasValidStoredKeys(): Promise<boolean> {
  const keys = loadKeys();
  if (!keys) {
    return false;
  }
  return isValidPrivateKey(keys.privateKey);
}

/**
 * Navigate to the logout page (clears session, then sends user to login).
 */
export function redirectToLogout(): void {
  if (typeof window === 'undefined') return;
  window.location.href = '/logout';
}

/**
 * Clear session for current user (logout) - keeps keys so user can log back in
 */
export function clearSession(): void {
  if (typeof window === 'undefined') return;
  
  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
  
  // Clear current session data (legacy storage)
  localStorage.removeItem(STORAGE_KEYS.USERNAME);
  localStorage.removeItem(STORAGE_KEYS.PRIVATE_KEY);
  localStorage.removeItem(STORAGE_KEYS.PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SERVER_PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_ID);
  
  // Clear session ID from per-user data (but keep keys)
  if (username) {
    localStorage.removeItem(getUserStorageKey(username, 'sessionId'));
    // Note: We keep the private key, public key, and server public key
    // so the user can log back in without regenerating keys
  }
  
  console.log('[GPG] ✓ Session cleared (keys preserved for re-login)');
}

/**
 * Clear all stored keys for current user (full logout - use clearSession for normal logout)
 * This is used when we want to completely remove a user's data
 */
export function clearKeys(): void {
  if (typeof window === 'undefined') return;
  
  const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
  
  // Clear current user data
  localStorage.removeItem(STORAGE_KEYS.USERNAME);
  localStorage.removeItem(STORAGE_KEYS.PRIVATE_KEY);
  localStorage.removeItem(STORAGE_KEYS.PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SERVER_PUBLIC_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_ID);
  
  // Clear per-user data if username exists
  if (username) {
    localStorage.removeItem(getUserStorageKey(username, 'privateKey'));
    localStorage.removeItem(getUserStorageKey(username, 'publicKey'));
    localStorage.removeItem(getUserStorageKey(username, 'serverPublicKey'));
    localStorage.removeItem(getUserStorageKey(username, 'sessionId'));
  }
  
  console.log('[GPG] ✓ All keys cleared from localStorage');
}

/**
 * Delete a specific user's keys from localStorage
 */
export function deleteUserKeys(username: string): void {
  if (typeof window === 'undefined') return;
  
  // Remove per-user data
  localStorage.removeItem(getUserStorageKey(username, 'privateKey'));
  localStorage.removeItem(getUserStorageKey(username, 'publicKey'));
  localStorage.removeItem(getUserStorageKey(username, 'serverPublicKey'));
  localStorage.removeItem(getUserStorageKey(username, 'sessionId'));
  
  // Remove from all users list
  const allUsers = getAllLocalUsers();
  const updatedUsers = allUsers.filter(u => u !== username);
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
}

/**
 * Get server's public key from the server
 */
export async function fetchServerPublicKey(): Promise<string> {
  const response = await fetch('/api/server-public-key');
  if (!response.ok) {
    throw new Error('Failed to fetch server public key');
  }
  const data = await response.json();
  return data.publicKey;
}

/**
 * Decrypt a message with the user's private key
 */
export async function decryptMessage(
  encryptedArmored: string,
  privateKeyArmored: string
): Promise<string> {
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
}

/**
 * Encrypt a message with the server's public key
 */
export async function encryptForServer(
  plaintext: string,
  serverPublicKeyArmored: string
): Promise<string> {
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
}

/**
 * Store all user public keys
 */
export function storeUserPublicKeys(userPubKeys: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  
  localStorage.setItem(STORAGE_KEYS.USER_PUBLIC_KEYS, JSON.stringify(userPubKeys));
  console.log('[GPG] ✓ Stored user public keys:', Object.keys(userPubKeys).length, 'keys');
}

/**
 * Load all user public keys
 */
export function loadUserPublicKeys(): Record<string, string> | null {
  if (typeof window === 'undefined') return null;
  
  const stored = localStorage.getItem(STORAGE_KEYS.USER_PUBLIC_KEYS);
  if (!stored) {
    console.log('[GPG] No user public keys found in localStorage');
    return null;
  }

  try {
    const keys = JSON.parse(stored);
    console.log('[GPG] ✓ Loaded user public keys:', Object.keys(keys).length, 'keys');
    return keys;
  } catch (e) {
    console.error('[GPG] ✗ Failed to parse user public keys:', e);
    return null;
  }
}

/**
 * Filter public keys for outbound encryption (respects blocks and DM room scope).
 */
export function filterPubKeysForEncryption(
  userPubKeys: Record<string, string>,
  options: { room?: string; blockedUsers?: string[] }
): Record<string, string> {
  const blocked = new Set(options.blockedUsers ?? getBlockedUsers());
  const filtered: Record<string, string> = {};

  for (const [user, key] of Object.entries(userPubKeys)) {
    if (!blocked.has(user)) {
      filtered[user] = key;
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
}

/**
 * Encrypt a message with all user public keys (including sender's own key)
 * Returns a map of username -> encrypted message
 */
export async function encryptForAllUsers(
  plaintext: string,
  userPubKeys: Record<string, string>,
  senderPublicKey?: string,
  senderUsername?: string
): Promise<Record<string, string>> {
  const encryptedMap: Record<string, string> = {};
  const message = await openpgp.createMessage({ text: plaintext });

  // Always encrypt for sender so they can decrypt their own messages later
  if (senderPublicKey && senderUsername) {
    try {
      const senderKey = await openpgp.readKey({
        armoredKey: senderPublicKey,
      });
      const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: senderKey,
      });
      encryptedMap[senderUsername] = encrypted;
    } catch (error) {
      console.error(`[GPG] ✗ Failed to encrypt for sender ${senderUsername}:`, error);
    }
  }

  // Encrypt for each user
  const encryptionPromises = Object.entries(userPubKeys).map(async ([username, publicKeyArmored]) => {
    // Skip if already encrypted for sender
    if (username === senderUsername) return;
    
    try {
      const publicKey = await openpgp.readKey({
        armoredKey: publicKeyArmored,
      });

      const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: publicKey,
      });

      // In openpgp v6, encrypt returns a string directly
      encryptedMap[username] = encrypted;
    } catch (error) {
      console.error(`[GPG] ✗ Failed to encrypt for user ${username}:`, error);
    }
  });

  await Promise.all(encryptionPromises);
  console.log('[GPG] ✓ Encrypted message for', Object.keys(encryptedMap).length, 'users');
  
  return encryptedMap;
}

/**
 * Decrypt a message with the user's private key
 */
export async function decryptMessageForUser(
  encryptedArmored: string,
  privateKeyArmored: string
): Promise<string> {
  try {
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
  } catch (error) {
    console.error('[GPG] ✗ Failed to decrypt message:', error);
    throw error;
  }
}

/**
 * Automatically re-establish session using stored credentials when session becomes invalid.
 * This prevents losing the message window context when server restarts.
 * Returns new sessionId if successful, null if re-login fails.
 */
export async function attemptAutoRelogin(): Promise<string | null> {
  try {
    const keys = loadKeys();
    if (!keys) {
      console.warn('[GPG] No stored keys available for auto-relogin');
      return null;
    }

    console.log('[GPG] Attempting auto-relogin for user:', keys.username);

    // Step 1: Send username and public key to server
    const loginResponse = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: keys.username,
        publicKey: keys.publicKey,
      }),
    });

    if (!loginResponse.ok) {
      console.warn('[GPG] Auto-relogin: initial login request failed');
      return null;
    }

    const loginData = await loginResponse.json();

    if (loginData.error) {
      console.warn('[GPG] Auto-relogin: server returned error:', loginData.error);
      return null;
    }

    // If new user was registered (unlikely after server restart), return sessionId
    if (loginData.sessionId && !loginData.challenge) {
      console.log('[GPG] ✓ Auto-relogin successful (new registration)');
      // Store the new session ID
      storeKeys({
        ...keys,
        sessionId: loginData.sessionId,
      });
      return loginData.sessionId;
    }

    // If we got a challenge, this is an existing user - perform challenge-response
    if (loginData.challenge) {
      console.log('[GPG] Received challenge, performing challenge-response for auto-relogin');

      try {
        // Decrypt the challenge with our private key
        const decryptedUUID = await decryptMessage(
          loginData.challenge,
          keys.privateKey
        );

        // Encrypt the UUID with server's public key
        const encryptedResponse = await encryptForServer(
          decryptedUUID,
          keys.serverPublicKey
        );

        // Send the encrypted response
        const verifyResponse = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: keys.username,
            encryptedUUID: encryptedResponse,
          }),
        });

        if (!verifyResponse.ok) {
          console.warn('[GPG] Auto-relogin: challenge-response request failed');
          return null;
        }

        const verifyData = await verifyResponse.json();

        if (verifyData.error) {
          console.warn('[GPG] Auto-relogin: challenge-response rejected:', verifyData.error);
          return null;
        }

        if (verifyData.sessionId) {
          console.log('[GPG] ✓ Auto-relogin successful (challenge-response)');
          // Store the new session ID
          storeKeys({
            ...keys,
            sessionId: verifyData.sessionId,
          });
          return verifyData.sessionId;
        }

        console.warn('[GPG] Auto-relogin: no sessionId in challenge-response');
        return null;
      } catch (err) {
        console.error('[GPG] Auto-relogin: failed during challenge-response:', err);
        return null;
      }
    }

    console.warn('[GPG] Auto-relogin: unexpected response from server');
    return null;
  } catch (err) {
    console.error('[GPG] Auto-relogin failed:', err);
    return null;
  }
}

