import { base64ToBytes, bytesToBase64 } from './crypto/base64';

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

const ENCRYPTED_IDENTITY_STATE = 'identity_state_enc_v1';
const IDENTITY_SECRET = 'identity_secret_v1';

let identityCache: IdentityState | null = null;

const safeParseMap = (raw: string | null): Record<string, string> => {
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
};

const safeParseNumberMap = (raw: string | null): Record<string, number> => {
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
};

const randomHex = (bytes = 16): string => {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Secure randomness unavailable');
  }
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const getOrCreateIdentitySecret = (): string => {
  if (typeof window === 'undefined') return '';

  const existing = localStorage.getItem(IDENTITY_SECRET);
  if (existing && existing.trim() !== '') {
    return existing;
  }

  const secret =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}:${randomHex(16)}`;
  localStorage.setItem(IDENTITY_SECRET, secret);
  return secret;
};

const readIdentitySecret = (): string => {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(IDENTITY_SECRET) || '';
};

const deriveKeyMaterial = (): string => {
  if (typeof window === 'undefined') return '';

  const secret = readIdentitySecret();
  if (secret.trim() !== '') {
    return secret;
  }

  return getOrCreateIdentitySecret();
};

const xorCipher = (value: string, keyMaterial: string): string => {
  if (!value) return '';
  const valueBytes = new TextEncoder().encode(value);
  const keyBytes = new TextEncoder().encode(keyMaterial);
  const out = new Uint8Array(valueBytes.length);
  for (let i = 0; i < valueBytes.length; i += 1) {
    out[i] = valueBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return bytesToBase64(out);
};

const xorDecipher = (value: string, keyMaterial: string): string => {
  if (!value) return '';
  const inBytes = base64ToBytes(value);
  const keyBytes = new TextEncoder().encode(keyMaterial);
  const out = new Uint8Array(inBytes.length);
  for (let i = 0; i < inBytes.length; i += 1) {
    out[i] = inBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return new TextDecoder().decode(out);
};

const emptyIdentityState = (): IdentityState => {
  return {
    userIdToName: {},
    userNameToId: {},
    roomIdToName: {},
    roomNameToId: {},
    userIdUpdatedAt: {},
    roomIdUpdatedAt: {},
  };
};

const sanitizeState = (
  raw: Partial<IdentityState> | null | undefined,
): IdentityState => {
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
};

const saveState = (state: IdentityState) => {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify(state);
  const keyMaterial = deriveKeyMaterial();
  const ciphertext = xorCipher(payload, keyMaterial);
  localStorage.setItem(ENCRYPTED_IDENTITY_STATE, ciphertext);
  if (!readIdentitySecret()) {
    getOrCreateIdentitySecret();
  }
};

const loadState = (): IdentityState => {
  if (typeof window === 'undefined') return emptyIdentityState();
  if (identityCache) {
    return identityCache;
  }

  const encrypted = localStorage.getItem(ENCRYPTED_IDENTITY_STATE);
  if (encrypted) {
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
      identityCache = emptyIdentityState();
      getOrCreateIdentitySecret();
      saveState(identityCache);
      return identityCache;
    }
  }

  identityCache = emptyIdentityState();
  getOrCreateIdentitySecret();
  saveState(identityCache);
  return identityCache;
};

const createLocalId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${randomHex(16)}`;
};

export const storeIdentityDirectories = (data: IdentityDirectories) => {
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
};

export const getUserIdByUsername = (username: string): string | undefined => {
  if (!username || typeof window === 'undefined') return undefined;
  return loadState().userNameToId[username];
};

export const getRoomIdByName = (roomName: string): string | undefined => {
  if (!roomName || typeof window === 'undefined') return undefined;
  return loadState().roomNameToId[roomName];
};

export const getUsernameByUserId = (userId: string): string | undefined => {
  if (!userId || typeof window === 'undefined') return undefined;
  return loadState().userIdToName[userId];
};

export const getRoomNameByRoomId = (roomId: string): string | undefined => {
  if (!roomId || typeof window === 'undefined') return undefined;
  return loadState().roomIdToName[roomId];
};

export const getCurrentUserId = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  return loadState().currentUserId;
};

export const getUserDirectorySnapshot = (): Record<string, string> => {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().userIdToName };
};

export const getRoomDirectorySnapshot = (): Record<string, string> => {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().roomIdToName };
};

export const getUserDirectoryTimestampSnapshot = (): Record<string, number> => {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().userIdUpdatedAt };
};

export const getRoomDirectoryTimestampSnapshot = (): Record<string, number> => {
  if (typeof window === 'undefined') {
    return {};
  }
  return { ...loadState().roomIdUpdatedAt };
};

export const requireUserIdByUsername = (username: string): string => {
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
  return userId;
};

export const requireRoomIdByName = (roomName: string): string => {
  if (!roomName || typeof window === 'undefined') {
    throw new Error(`Missing roomId mapping for room: ${roomName}`);
  }

  if (
    roomName.startsWith('@dmid:') ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomName)
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
};
