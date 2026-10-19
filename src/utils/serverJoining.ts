import { apiPathForServer } from './appPaths';
import {
  buildOpaqueUsernameEnvelope,
  decryptMessage,
  fetchServerPublicKey,
  loadKeysAsync,
  updateStoredSessionForUser,
  verifyChallengeResponseWithKeyRefresh,
} from './gpg';
import { storeIdentityDirectories } from './identityMap';
import {
  upsertServerMembership,
  type ServerMembership,
} from './serverRegistry';
import type { ParsedInviteLink } from './inviteLinks';

export type JoinedServer = {
  membership: ServerMembership;
  sessionId: string;
  username: string;
};

export const joinServerFromInvite = async (
  invite: ParsedInviteLink,
): Promise<JoinedServer> => {
  const keys = await loadKeysAsync();
  if (!keys?.username || !keys.userId || !keys.privateKey || !keys.publicKey) {
    throw new Error('Unlock your account before joining a server.');
  }

  const [serverPublicKey, statusResponse] = await Promise.all([
    fetchServerPublicKey(invite.serverId),
    fetch(apiPathForServer('/api/server-status', invite.serverId)),
  ]);
  if (!statusResponse.ok) {
    throw new Error('Unable to reach the server in this invite.');
  }
  const status = (await statusResponse.json()) as {
    alias?: string;
  };

  const opaqueIdentity = await buildOpaqueUsernameEnvelope(
    keys.username,
    keys.publicKey,
  );
  const registrationResponse = await fetch(
    apiPathForServer('/api/login', invite.serverId),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: keys.userId,
        usernameHash: opaqueIdentity.usernameHash,
        usernameCiphertext: opaqueIdentity.usernameCiphertext,
        publicKey: keys.publicKey,
        inviteCode: invite.inviteCode,
      }),
    },
  );
  const loginData = (await registrationResponse.json()) as {
    challenge?: string;
    sessionId?: string;
    userId?: string;
    error?: string;
  };
  if (!registrationResponse.ok || loginData.error) {
    throw new Error(loginData.error || 'Unable to join this server.');
  }

  let sessionId = loginData.sessionId;
  let userId = loginData.userId || keys.userId;
  let authenticatedServerPublicKey = serverPublicKey;

  if (loginData.challenge) {
    const decryptedUUID = await decryptMessage(
      loginData.challenge,
      keys.privateKey,
    );
    const verified = await verifyChallengeResponseWithKeyRefresh({
      userId: keys.userId,
      decryptedUUID,
      serverPublicKey,
      serverId: invite.serverId,
    });
    if (verified.error || !verified.sessionId) {
      throw new Error(verified.error || 'Unable to verify your account.');
    }
    sessionId = verified.sessionId;
    userId = verified.userId || keys.userId;
    authenticatedServerPublicKey = verified.serverPublicKey;
  }

  if (!sessionId) {
    throw new Error('The server did not complete the join handshake.');
  }

  await updateStoredSessionForUser({
    username: keys.username,
    userId,
    sessionId,
    serverPublicKey: authenticatedServerPublicKey,
    serverId: invite.serverId,
    makeActive: false,
  });
  storeIdentityDirectories({
    userDirectory: { [userId]: keys.username },
    currentUserId: userId,
  });

  const membership: ServerMembership = {
    serverId: invite.serverId,
    alias: status.alias?.trim() || invite.serverId,
    label: invite.serverLabel || status.alias?.trim() || invite.serverId,
    username: keys.username,
    userId,
  };
  const memberships = upsertServerMembership(membership);
  const storedMembership =
    memberships.find(
      (entry) =>
        entry.serverId === membership.serverId && entry.userId === userId,
    ) || membership;

  return { membership: storedMembership, sessionId, username: keys.username };
};
