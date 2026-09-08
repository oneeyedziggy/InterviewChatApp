import { signDetachedText, loadKeysAsync } from './gpg';

export type SignedMutationAuth = {
  version: 'v1';
  event: string;
  userId: string;
  sessionId: string;
  timestamp: number;
  nonce: string;
  claims: Record<string, string>;
  signature: string;
};

const createNonce = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `${Date.now()}:${suffix}`;
  }

  throw new Error('Secure randomness unavailable for nonce generation');
};

const base64UrlEncodeUtf8 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

const canonicalClaimsString = (claims: Record<string, string>): string => {
  const keys = Object.keys(claims).sort();
  return keys
    .map((key) => `${key}=${base64UrlEncodeUtf8(claims[key] ?? '')}`)
    .join('&');
};

const signingInput = (auth: Omit<SignedMutationAuth, 'signature'>): string => {
  return [
    auth.version,
    auth.event,
    auth.userId,
    auth.sessionId,
    String(auth.timestamp),
    auth.nonce,
    canonicalClaimsString(auth.claims),
  ].join('|');
};

const normalizeClaimValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

export const buildSignedMutationAuth = async (args: {
  event: string;
  userId: string;
  sessionId: string;
  claims: Record<string, unknown>;
}): Promise<SignedMutationAuth> => {
  const keys = await loadKeysAsync();
  if (!keys?.privateKey) {
    throw new Error('Missing private key for signed mutation auth');
  }

  const normalizedClaims: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.claims)) {
    normalizedClaims[key] = normalizeClaimValue(value);
  }

  const unsignedAuth: Omit<SignedMutationAuth, 'signature'> = {
    version: 'v1',
    event: args.event,
    userId: args.userId,
    sessionId: args.sessionId,
    timestamp: Date.now(),
    nonce: createNonce(),
    claims: normalizedClaims,
  };

  const signature = await signDetachedText(
    signingInput(unsignedAuth),
    keys.privateKey,
  );

  return {
    ...unsignedAuth,
    signature,
  };
};

export const emitSignedMutation = async (
  socket: { emit: (event: string, payload: unknown) => void } | undefined,
  args: {
    event: string;
    payload: Record<string, unknown>;
    userId: string;
    sessionId: string;
    claims: Record<string, unknown>;
  },
): Promise<void> => {
  if (!socket) {
    throw new Error('Socket unavailable');
  }

  const auth = await buildSignedMutationAuth({
    event: args.event,
    userId: args.userId,
    sessionId: args.sessionId,
    claims: args.claims,
  });

  socket.emit(args.event, {
    ...args.payload,
    auth,
  });
};
