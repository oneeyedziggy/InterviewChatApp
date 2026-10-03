package server

import (
	"testing"
	"time"
)

// A user is authoritative for their own username ciphertext, so a self-update
// must win even when the client's local timestamp trails the server's stamp.
func TestIdentityRefreshAcceptsSelfUpdateWithStaleClientTimestamp(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, nsp := newRegisteredFakeSocket(t, cs)

	signer := newTestUserSigner(t, "user-self", "session-self")
	cs.userPubKeys[signer.userID] = signer.publicKey
	cs.sessionCache.Set(signer.sessionID, signer.userID)

	peer := newTestUserSigner(t, "user-peer", "session-peer")
	cs.userPubKeys[peer.userID] = peer.publicKey

	// Registration stores a ciphertext only the server can read, stamped "now".
	registrationStamp := time.Now().UTC().UnixMilli()
	cs.usernameCiphertexts[signer.userID] = "server-only-ciphertext"
	cs.userDirectoryUpdatedAt[signer.userID] = registrationStamp

	staleClientStamp := registrationStamp - 60_000
	payload := map[string]interface{}{
		"userId":              signer.userID,
		"refreshedForUserIds": []interface{}{peer.userID},
		"userDirectoryCiphertexts": map[string]interface{}{
			signer.userID: "peer-readable-ciphertext",
		},
		"userDirectoryUpdatedAt": map[string]interface{}{
			signer.userID: staleClientStamp,
		},
	}
	signed := signer.signMutationPayload(
		t,
		EventClientIdentityDirectoryRefresh,
		payload,
		map[string]string{
			"userId":              signer.userID,
			"refreshedForUserIds": `["` + peer.userID + `"]`,
		},
		time.Now().UnixMilli(),
		"nonce-self-refresh",
	)

	cs.handleIdentityDirectoryRefresh(fake, signed, nsp)

	if got := cs.usernameCiphertexts[signer.userID]; got != "peer-readable-ciphertext" {
		t.Fatalf("self username ciphertext = %q, want the freshly published peer-readable value", got)
	}
	if cs.userDirectoryUpdatedAt[signer.userID] < registrationStamp {
		t.Fatalf("self directory timestamp went backwards: %d < %d", cs.userDirectoryUpdatedAt[signer.userID], registrationStamp)
	}
}

// Entries for other users keep last-writer-wins ordering so a stale peer
// broadcast cannot overwrite a newer directory entry.
func TestIdentityRefreshRejectsStalePeerUpdate(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, nsp := newRegisteredFakeSocket(t, cs)

	signer := newTestUserSigner(t, "user-sender", "session-sender")
	cs.userPubKeys[signer.userID] = signer.publicKey
	cs.sessionCache.Set(signer.sessionID, signer.userID)

	peer := newTestUserSigner(t, "user-other", "session-other")
	cs.userPubKeys[peer.userID] = peer.publicKey

	currentStamp := time.Now().UTC().UnixMilli()
	cs.usernameCiphertexts[peer.userID] = "current-peer-ciphertext"
	cs.userDirectoryUpdatedAt[peer.userID] = currentStamp

	payload := map[string]interface{}{
		"userId":              signer.userID,
		"refreshedForUserIds": []interface{}{peer.userID},
		"userDirectoryCiphertexts": map[string]interface{}{
			peer.userID: "stale-peer-ciphertext",
		},
		"userDirectoryUpdatedAt": map[string]interface{}{
			peer.userID: currentStamp - 60_000,
		},
	}
	signed := signer.signMutationPayload(
		t,
		EventClientIdentityDirectoryRefresh,
		payload,
		map[string]string{
			"userId":              signer.userID,
			"refreshedForUserIds": `["` + peer.userID + `"]`,
		},
		time.Now().UnixMilli(),
		"nonce-peer-refresh",
	)

	cs.handleIdentityDirectoryRefresh(fake, signed, nsp)

	if got := cs.usernameCiphertexts[peer.userID]; got != "current-peer-ciphertext" {
		t.Fatalf("stale peer update overwrote newer entry: %q", got)
	}
}
