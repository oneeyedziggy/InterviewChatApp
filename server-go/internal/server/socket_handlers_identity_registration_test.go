package server

import (
	"testing"
	"time"
)

func TestTwoUserPublicKeyAnnouncementsBeforeInitialData(t *testing.T) {
	cs := newIntegrationTestServer(t)
	firstSocket, _, nsp := newRegisteredFakeSocket(t, cs)
	secondSocket := newFakeServerSocket("socket-2")
	invokeFirstOnConnectionHandler(t, nsp, secondSocket)
	cs.userPubKeys["offline-user"] = "offline-public-key"

	for userIndex, socket := range []*fakeServerSocket{firstSocket, secondSocket} {
		userID := []string{"user-a", "user-b"}[userIndex]
		signer := newTestUserSigner(t, userID, "session-"+userID)
		cs.userPubKeys[userID] = signer.publicKey
		cs.sessionCache.Set(signer.sessionID, userID)
		cs.users[userID] = signer.sessionID
		payload := signer.signMutationPayload(t, EventClientSendPublicKey,
			map[string]interface{}{"fromUserId": userID, "publicKey": signer.publicKey},
			map[string]string{"fromUserId": userID, "publicKey": signer.publicKey},
			time.Now().UnixMilli(), "nonce-"+userID)
		socket.invokeEvent(t, EventClientSendPublicKey, payload)
	}

	loggedInUsers, activeUsers := cs.getUserLists()
	if len(loggedInUsers) != 2 || loggedInUsers[0] != "user-a" || loggedInUsers[1] != "user-b" {
		t.Fatalf("logged-in users = %v, want both authenticated announcers", loggedInUsers)
	}
	if len(activeUsers) != 1 || activeUsers[0] != "offline-user" {
		t.Fatalf("active but not logged-in users = %v, want only offline-user", activeUsers)
	}
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	if cs.userSocketsByID["user-a"] != string(firstSocket.ID()) || cs.userSocketsByID["user-b"] != string(secondSocket.ID()) {
		t.Fatalf("two-user delivery mapping = %v", cs.userSocketsByID)
	}
}

func TestPublicKeyAnnouncementRegistersAuthenticatedSocketBeforeInitialData(t *testing.T) {
	testCases := []struct {
		name   string
		mutate func(map[string]interface{})
		valid  bool
	}{
		{name: "authenticated", valid: true},
		{
			name: "identity mismatch",
			mutate: func(payload map[string]interface{}) {
				payload["fromUserId"] = "another-user"
			},
		},
		{
			name: "expired session",
			mutate: func(payload map[string]interface{}) {
				payload["auth"].(map[string]interface{})["sessionId"] = "unknown-session"
			},
		},
		{
			name: "invalid signature",
			mutate: func(payload map[string]interface{}) {
				payload["auth"].(map[string]interface{})["signature"] = "invalid-signature"
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			cs := newIntegrationTestServer(t)
			fake, _, _ := newRegisteredFakeSocket(t, cs)
			signer := newTestUserSigner(t, "announcing-user", "login-session")
			cs.userPubKeys[signer.userID] = signer.publicKey
			cs.sessionCache.Set(signer.sessionID, signer.userID)
			cs.users[signer.userID] = signer.sessionID

			payload := signer.signMutationPayload(t, EventClientSendPublicKey,
				map[string]interface{}{
					"fromUserId": signer.userID,
					"publicKey":  signer.publicKey,
				},
				map[string]string{
					"fromUserId": signer.userID,
					"publicKey":  signer.publicKey,
				}, time.Now().UnixMilli(), "nonce-key-registration")
			if testCase.mutate != nil {
				testCase.mutate(payload)
			}

			fake.invokeEvent(t, EventClientSendPublicKey, payload)

			cs.mu.RLock()
			socketID := cs.userSocketsByID[signer.userID]
			presenceID := cs.users[signer.userID]
			unexpectedSocketID := cs.userSocketsByID["another-user"]
			cs.mu.RUnlock()
			if testCase.valid {
				if socketID != string(fake.ID()) || presenceID != string(fake.ID()) {
					t.Fatalf("authenticated announcement did not bind delivery and presence: socket=%q presence=%q", socketID, presenceID)
				}
			} else if socketID != "" || presenceID != signer.sessionID {
				t.Fatalf("rejected announcement changed registration: socket=%q presence=%q", socketID, presenceID)
			}
			if unexpectedSocketID != "" {
				t.Fatalf("announcement registered another identity: %q", unexpectedSocketID)
			}
		})
	}
}