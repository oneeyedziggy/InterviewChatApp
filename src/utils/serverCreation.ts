import { withBasePath } from '@/utils/appPaths';
import { getUserIdByUsername } from '@/utils/identityMap';
import {
  buildOpaqueUsernameEnvelope,
  loadKeysAsync,
  signDetachedText,
  updateStoredSessionForUser,
} from './gpg';
import { upsertServerMembership } from './serverRegistry';

export type CreatedServer = {
  serverId: string;
  alias: string;
  label: string;
  sessionId: string;
  username: string;
};

export class ServerCreationError extends Error {}

/**
 * Provisions a new tenant with a single-use, public-key-bound capability and
 * records it in the local encrypted server registry.
 */
export const createServerForCurrentUser = async (
  requestedLabel: string,
): Promise<CreatedServer> => {
  const keys = await loadKeysAsync();
  if (!keys?.privateKey || !keys.publicKey) {
    throw new ServerCreationError(
      'Unlock your account before creating a server.',
    );
  }

  const capabilityResponse = await fetch(
    withBasePath('/api/server-creation-capability'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: keys.publicKey }),
    },
  );
  const capabilityData = (await capabilityResponse.json()) as {
    capability?: string;
    serverPublicKey?: string;
  };
  if (
    !capabilityResponse.ok ||
    !capabilityData.capability ||
    !capabilityData.serverPublicKey
  ) {
    throw new ServerCreationError(
      'Failed to obtain a server creation capability.',
    );
  }

  const userId = keys.userId || getUserIdByUsername(keys.username);
  if (!userId) {
    throw new ServerCreationError(
      'Your account identity is incomplete. Please log in again before creating a server.',
    );
  }
  const opaqueIdentity = await buildOpaqueUsernameEnvelope(
    keys.username,
    capabilityData.serverPublicKey,
  );
  const signature = await signDetachedText(
    `server-create:v1:${capabilityData.capability}`,
    keys.privateKey,
  );

  const response = await fetch(withBasePath('/api/servers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability: capabilityData.capability,
      publicKey: keys.publicKey,
      signature,
      userId,
      usernameHash: opaqueIdentity.usernameHash,
      usernameCiphertext: opaqueIdentity.usernameCiphertext,
    }),
  });
  const data = (await response.json()) as {
    serverId?: string;
    alias?: string;
    sessionId?: string;
    serverPublicKey?: string;
    userId?: string;
  };
  if (
    !response.ok ||
    !data.serverId ||
    !data.sessionId ||
    !data.serverPublicKey
  ) {
    throw new ServerCreationError('Failed to create the server.');
  }

  await updateStoredSessionForUser({
    username: keys.username,
    sessionId: data.sessionId,
    userId: data.userId || userId,
    serverPublicKey: data.serverPublicKey,
    serverId: data.serverId,
  });

  const label = requestedLabel.trim() || data.alias || data.serverId;
  upsertServerMembership({
    serverId: data.serverId,
    alias: data.alias || data.serverId,
    label,
    username: keys.username,
    userId: data.userId || userId,
  });

  return {
    serverId: data.serverId,
    alias: data.alias || data.serverId,
    label,
    sessionId: data.sessionId,
    username: keys.username,
  };
};
