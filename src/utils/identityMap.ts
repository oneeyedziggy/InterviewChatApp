type IdentityDirectories = {
  userDirectory?: Record<string, string>; // userId -> username
  roomDirectory?: Record<string, string>; // roomId -> roomName
  userDirectoryUpdatedAt?: Record<string, number>; // userId -> unix ms UTC
  roomDirectoryUpdatedAt?: Record<string, number>; // roomId -> unix ms UTC
  currentUserId?: string;
};

type IdentityState = {
  userIdToName: Record<string, string>;
  userNameToId: Record<string, string>;
  roomIdToName: Record<string, string>;
  roomNameToId: Record<string, string>;
  userIdUpdatedAt: Record<string, number>;
  roomIdUpdatedAt: Record<string, number>;
  currentUserId?: string;
};

const USER_ID_TO_NAME = 'identity_user_id_to_name';
const USER_NAME_TO_ID = 'identity_user_name_to_id';
const ROOM_ID_TO_NAME = 'identity_room_id_to_name';
const ROOM_NAME_TO_ID = 'identity_room_name_to_id';
const CURRENT_USER_ID = 'identity_current_user_id';
const ENCRYPTED_IDENTITY_STATE = 'identity_state_enc_v1';
const IDENTITY_SECRET = 'identity_secret_v1';

let identityCache: IdentityState | null = null;

function safeParseMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) {
        next[k] = v;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function safeParseNumberMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || k.trim() === '') {
        continue;
      }
      const numeric =
        typeof v === 'number'
          ? v
          : typeof v === 'string'
            ? Number.parseInt(v, 10)
            : NaN;
      if (Number.isFinite(numeric) && numeric > 0) {
        next[k] = Math.trunc(numeric);
      }
    }
    return next;
  } catch {
    return {};
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getOrCreateIdentitySecret(): string {
  if (typeof window === 'undefined') return '';

  const existing = localStorage.getItem(IDENTITY_SECRET);
  if (existing && existing.trim() !== '') {
    return existing;
  }

  const secret =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(IDENTITY_SECRET, secret);
  return secret;
}

function readIdentitySecret(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(IDENTITY_SECRET) || '';
}

function collectIdentityKeyCandidates(): string[] {
  if (typeof window === 'undefined') return [];

  const candidates = new Set<string>();

  const legacyPublicKey = localStorage.getItem('gpg_public_key') || '';
  const legacyPrivateKey = localStorage.getItem('gpg_private_key') || '';
  if (legacyPublicKey || legacyPrivateKey) {
    candidates.add(`${legacyPublicKey}|${legacyPrivateKey}`);
  }

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('gpg_user_') || !key.endsWith('_privateKey')) {
      continue;
    }

    const match = key.match(/^gpg_user_(.+)_privateKey$/);
    if (!match || !match[1]) {
      continue;
    }

    const username = match[1];
    const privateKey = localStorage.getItem(key) || '';
    const publicKey =
      localStorage.getItem(`gpg_user_${username}_publicKey`) || '';
    if (privateKey || publicKey) {
      candidates.add(`${publicKey}|${privateKey}`);
    }
  }

  return Array.from(candidates).filter((value) => value.trim() !== '');
}

function deriveKeyMaterial(): string {
  if (typeof window === 'undefined') return '';

  const secret = readIdentitySecret();
  if (secret.trim() !== '') {
    return secret;
  }

  const fallback = collectIdentityKeyCandidates();
  if (fallback.length > 0) {
    return fallback[0];
  }

  return getOrCreateIdentitySecret();
}

function xorCipher(value: string, keyMaterial: string): string {
  if (!value) return '';
  const valueBytes = new TextEncoder().encode(value);
  const keyBytes = new TextEncoder().encode(keyMaterial);
  const out = new Uint8Array(valueBytes.length);
  for (let i = 0; i < valueBytes.length; i += 1) {
    out[i] = valueBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return bytesToBase64(out);
}

function xorDecipher(value: string, keyMaterial: string): string {
  if (!value) return '';
  const inBytes = base64ToBytes(value);
  const keyBytes = new TextEncoder().encode(keyMaterial);
  const out = new Uint8Array(inBytes.length);
  for (let i = 0; i < inBytes.length; i += 1) {
    out[i] = inBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return new TextDecoder().decode(out);
}

function emptyIdentityState(): IdentityState {
  return {
    userIdToName: {},
    userNameToId: {},
    roomIdToName: {},
    roomNameToId: {},
    userIdUpdatedAt: {},
    roomIdUpdatedAt: {},
  };
}

function sanitizeState(
  raw: Partial<IdentityState> | null | undefined,
): IdentityState {
  const next = emptyIdentityState();
  if (!raw) {
    return next;
  }

  next.userIdToName = safeParseMap(JSON.stringify(raw.userIdToName || {}));
  next.userNameToId = safeParseMap(JSON.stringify(raw.userNameToId || {}));
  next.roomIdToName = safeParseMap(JSON.stringify(raw.roomIdToName || {}));
  next.roomNameToId = safeParseMap(JSON.stringify(raw.roomNameToId || {}));
  next.userIdUpdatedAt = safeParseNumberMap(
    JSON.stringify(raw.userIdUpdatedAt || {}),
  );
  next.roomIdUpdatedAt = safeParseNumberMap(
    JSON.stringify(raw.roomIdUpdatedAt || {}),
  );

  if (
    typeof raw.currentUserId === 'string' &&
    raw.currentUserId.trim() !== ''
  ) {
    next.currentUserId = raw.currentUserId;
  }

  return next;
}

function saveState(state: IdentityState) {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify(state);
  const keyMaterial = deriveKeyMaterial();
  const ciphertext = xorCipher(payload, keyMaterial);
  localStorage.setItem(ENCRYPTED_IDENTITY_STATE, ciphertext);
  if (!readIdentitySecret()) {
    getOrCreateIdentitySecret();
  }
}

function loadLegacyIdentityState(): IdentityState {
  if (typeof window === 'undefined') return emptyIdentityState();
  const legacy = emptyIdentityState();
  legacy.userIdToName = safeParseMap(localStorage.getItem(USER_ID_TO_NAME));
  legacy.userNameToId = safeParseMap(localStorage.getItem(USER_NAME_TO_ID));
  legacy.roomIdToName = safeParseMap(localStorage.getItem(ROOM_ID_TO_NAME));
  legacy.roomNameToId = safeParseMap(localStorage.getItem(ROOM_NAME_TO_ID));
  legacy.currentUserId = localStorage.getItem(CURRENT_USER_ID) || undefined;
  return legacy;
}

function clearLegacyIdentityStorage() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(USER_ID_TO_NAME);
  localStorage.removeItem(USER_NAME_TO_ID);
  localStorage.removeItem(ROOM_ID_TO_NAME);
  localStorage.removeItem(ROOM_NAME_TO_ID);
  localStorage.removeItem(CURRENT_USER_ID);
}

function loadState(): IdentityState {
  if (typeof window === 'undefined') return emptyIdentityState();
  if (identityCache) {
    return identityCache;
  }

  const encrypted = localStorage.getItem(ENCRYPTED_IDENTITY_STATE);
  if (encrypted) {
    const candidates = [
      readIdentitySecret(),
      ...collectIdentityKeyCandidates(),
    ].filter((value) => value.trim() !== '');

    for (const keyMaterial of candidates) {
      try {
        const plaintext = xorDecipher(encrypted, keyMaterial);
        identityCache = sanitizeState(
          JSON.parse(plaintext) as Partial<IdentityState>,
        );
        if (!readIdentitySecret()) {
          getOrCreateIdentitySecret();
          saveState(identityCache);
        }
        return identityCache;
      } catch {
        // Try next candidate.
      }
    }

    try {
      const plaintext = xorDecipher(encrypted, deriveKeyMaterial());
      identityCache = sanitizeState(
        JSON.parse(plaintext) as Partial<IdentityState>,
      );
      if (!readIdentitySecret()) {
        getOrCreateIdentitySecret();
        saveState(identityCache);
      }
      return identityCache;
    } catch {
      // Fall through to legacy migration.
    }
  }

  const legacy = loadLegacyIdentityState();
  identityCache = sanitizeState(legacy);
  getOrCreateIdentitySecret();
  saveState(identityCache);
  clearLegacyIdentityStorage();
  return identityCache;
}

function createLocalId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function storeIdentityDirectories(data: IdentityDirectories) {
  if (typeof window === 'undefined') return;

  const state = loadState();

  if (data.userDirectory) {
    const byId = { ...state.userIdToName };
    const byName = { ...state.userNameToId };
    const byUpdatedAt = { ...state.userIdUpdatedAt };
    const incomingUpdatedAt = data.userDirectoryUpdatedAt || {};

    for (const [userId, username] of Object.entries(data.userDirectory)) {
      const incomingTs = Number.isFinite(incomingUpdatedAt[userId])
        ? Math.trunc(incomingUpdatedAt[userId] as number)
        : 0;
      const existingTs = byUpdatedAt[userId] || 0;
      const hasNoExisting =
        typeof byId[userId] !== 'string' || byId[userId] === '';

      if (!hasNoExisting && incomingTs > 0 && existingTs > incomingTs) {
        continue;
      }
      if (!hasNoExisting && incomingTs <= 0 && existingTs > 0) {
        continue;
      }

      byId[userId] = username;
      byName[username] = userId;

      if (incomingTs > 0) {
        byUpdatedAt[userId] = incomingTs;
      } else if (!(userId in byUpdatedAt)) {
        byUpdatedAt[userId] = 0;
      }
    }

    state.userIdToName = byId;
    state.userNameToId = byName;
    state.userIdUpdatedAt = byUpdatedAt;
  }

  if (data.roomDirectory) {
    const byId = { ...state.roomIdToName };
    const byName = { ...state.roomNameToId };
    const byUpdatedAt = { ...state.roomIdUpdatedAt };
    const incomingUpdatedAt = data.roomDirectoryUpdatedAt || {};

    for (const [roomId, roomName] of Object.entries(data.roomDirectory)) {
      const incomingTs = Number.isFinite(incomingUpdatedAt[roomId])
        ? Math.trunc(incomingUpdatedAt[roomId] as number)
        : 0;
      const existingTs = byUpdatedAt[roomId] || 0;
      const hasNoExisting =
        typeof byId[roomId] !== 'string' || byId[roomId] === '';

      if (!hasNoExisting && incomingTs > 0 && existingTs > incomingTs) {
        continue;
      }
      if (!hasNoExisting && incomingTs <= 0 && existingTs > 0) {
        continue;
      }

      byId[roomId] = roomName;
      byName[roomName] = roomId;

      if (incomingTs > 0) {
        byUpdatedAt[roomId] = incomingTs;
      } else if (!(roomId in byUpdatedAt)) {
        byUpdatedAt[roomId] = 0;
      }
    }

    state.roomIdToName = byId;
    state.roomNameToId = byName;
    state.roomIdUpdatedAt = byUpdatedAt;
  }

  if (data.currentUserId) {
    state.currentUserId = data.currentUserId;
  }

  identityCache = state;
  saveState(state);
  clearLegacyIdentityStorage();
}

export function getUserIdByUsername(username: string): string | undefined {
  if (!username || typeof window === 'undefined') return undefined;
  return loadState().userNameToId[username];
}

export function getRoomIdByName(roomName: string): string | undefined {
  if (!roomName || typeof window === 'undefined') return undefined;
  return loadState().roomNameToId[roomName];
}

export function getUsernameByUserId(userId: string): string | undefined {
  if (!userId || typeof window === 'undefined') return undefined;
  return loadState().userIdToName[userId];
}

export function getRoomNameByRoomId(roomId: string): string | undefined {
  if (!roomId || typeof window === 'undefined') return undefined;
  return loadState().roomIdToName[roomId];
}

export function getCurrentUserId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return loadState().currentUserId;
}

export function getUserDirectorySnapshot(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().userIdToName };
}

export function getRoomDirectorySnapshot(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().roomIdToName };
}

export function getUserDirectoryTimestampSnapshot(): Record<string, number> {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().userIdUpdatedAt };
}

export function getRoomDirectoryTimestampSnapshot(): Record<string, number> {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().roomIdUpdatedAt };
}

export function requireUserIdByUsername(username: string): string {
  const existing = getUserIdByUsername(username);
  if (existing) {
    return existing;
  }

  if (!username || typeof window === 'undefined') {
    throw new Error(`Missing userId mapping for username: ${username}`);
  }

  const userId = createLocalId('user');
  const state = loadState();
  state.userIdToName[userId] = username;
  state.userNameToId[username] = userId;
  state.userIdUpdatedAt[userId] = Date.now();
  identityCache = state;
  saveState(state);
  clearLegacyIdentityStorage();
  return userId;
}

export function requireRoomIdByName(roomName: string): string {
  if (!roomName || typeof window === 'undefined') {
    throw new Error(`Missing roomId mapping for room: ${roomName}`);
  }

  // If caller already passed an opaque room ID, use it directly.
  if (
    roomName.startsWith('@dmid:') ||
    roomName.startsWith('room:') ||
    roomName.startsWith('room_')
  ) {
    return roomName;
  }

  const existingById = getRoomNameByRoomId(roomName);
  if (existingById) {
    return roomName;
  }

  const existing = getRoomIdByName(roomName);
  if (existing) {
    return existing;
  }

  throw new Error(`Missing roomId mapping for room: ${roomName}`);
}
