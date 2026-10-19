package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	"github.com/google/uuid"
)

type twoUserDirectoryResponse struct {
	Messages               Messages          `json:"messages"`
	Rooms                  []string          `json:"rooms"`
	CurrentUserID          string            `json:"currentUserId"`
	UserPublicKeys         map[string]string `json:"userPubKeys"`
	RoomNameCiphertexts    map[string]string `json:"roomNameCiphertexts"`
	RoomDirectoryUpdatedAt map[string]int64  `json:"roomDirectoryUpdatedAt"`
	UserCiphertexts        map[string]string `json:"userDirectoryCiphertexts"`
	UserDirectoryUpdatedAt map[string]int64  `json:"userDirectoryUpdatedAt"`
}

func newTwoUserSigner(t *testing.T) *testUserSigner {
	t.Helper()
	privateArmored, err := helper.GenerateKey("contract-user", "contract@example.test", nil, "rsa", 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := crypto.NewKeyFromArmored(privateArmored)
	if err != nil {
		t.Fatal(err)
	}
	unlocked, err := privateKey.Unlock(nil)
	if err != nil {
		t.Fatal(err)
	}
	privateRing, err := crypto.NewKeyRing(unlocked)
	if err != nil {
		t.Fatal(err)
	}
	publicBytes, err := unlocked.GetPublicKey()
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := crypto.NewKey(publicBytes)
	if err != nil {
		t.Fatal(err)
	}
	publicArmored, err := publicKey.Armor()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(privateRing.ClearPrivateParams)
	return &testUserSigner{userID: uuid.NewString(), sessionID: uuid.NewString(), publicKey: publicArmored, privateRing: privateRing}
}

func twoUserCiphertext(t *testing.T, plaintext string, recipients ...*testUserSigner) string {
	t.Helper()
	contentKey := make([]byte, 32)
	if _, err := rand.Read(contentKey); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(contentKey)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	keyEnvelopes := make(map[string]string, len(recipients))
	for index, recipient := range recipients {
		publicKey, err := crypto.NewKeyFromArmored(recipient.publicKey)
		if err != nil {
			t.Fatal(err)
		}
		publicRing, err := crypto.NewKeyRing(publicKey)
		if err != nil {
			t.Fatal(err)
		}
		wrapped, err := publicRing.Encrypt(crypto.NewPlainMessageFromString(base64.StdEncoding.EncodeToString(contentKey)), nil)
		if err != nil {
			t.Fatal(err)
		}
		armored, err := wrapped.GetArmored()
		if err != nil {
			t.Fatal(err)
		}
		keyEnvelopes[fmt.Sprint(index)] = armored
	}
	encoded, err := json.Marshal(map[string]interface{}{
		"version": "msg-v2", "iv": base64.StdEncoding.EncodeToString(iv),
		"ciphertext":   base64.StdEncoding.EncodeToString(gcm.Seal(nil, iv, []byte(plaintext), nil)),
		"keyEnvelopes": keyEnvelopes,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func twoUserSigned(t *testing.T, signer *testUserSigner, event string, payload map[string]interface{}) map[string]interface{} {
	t.Helper()
	claims := make(map[string]string, len(payload))
	for key, value := range payload {
		claims[key] = normalizeClaimValue(value)
	}
	return signer.signMutationPayload(t, event, payload, claims, time.Now().UnixMilli(), uuid.NewString())
}

func twoUserSockets(t *testing.T, cs *ChatServer, users ...*testUserSigner) []*fakeServerSocket {
	t.Helper()
	sio := wsrt.NewServer(nil)
	t.Cleanup(func() { _ = sio.Close() })
	cs.SetupSocketHandlers(sio)
	sockets := make([]*fakeServerSocket, len(users))
	if cs.userJoinedAt == nil {
		cs.userJoinedAt = make(map[string]int64)
	}
	for index, user := range users {
		cs.userPubKeys[user.userID] = user.publicKey
		cs.sessionCache.Set(user.sessionID, user.userID)
		if cs.userJoinedAt[user.userID] == 0 {
			cs.userJoinedAt[user.userID] = time.Now().Unix()
		}
		sockets[index] = newFakeServerSocket(uuid.NewString())
		invokeFirstOnConnectionHandler(t, sio.Of("/"), sockets[index])
		sockets[index].invokeEvent(t, EventClientRequestInitialData, map[string]interface{}{
			"userId": user.userID, "sessionId": user.sessionID,
		})
		twoUserAction(t, sockets[index], "initialData", true, "ok")
	}
	return sockets
}

func twoUserAction(t *testing.T, socket *fakeServerSocket, action string, success bool, code string) {
	t.Helper()
	emitted, exists := socket.lastEmitFor(EventServerActionResult)
	if !exists || len(emitted.args) != 1 {
		t.Fatalf("missing action result for %s", action)
	}
	payload, ok := emitted.args[0].(map[string]interface{})
	if !ok || payload["action"] != action || payload["success"] != success || payload["code"] != code {
		t.Fatalf("action %s: got %+v, want success=%v code=%s", action, emitted.args[0], success, code)
	}
}

func twoUserResponse(t *testing.T, cs *ChatServer, socket *fakeServerSocket, event string) twoUserDirectoryResponse {
	t.Helper()
	emitted, exists := socket.lastEmitFor(event)
	if !exists || len(emitted.args) != 1 {
		t.Fatalf("missing %s response", event)
	}
	payload, ok := emitted.args[0].(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected %s payload: %T", event, emitted.args[0])
	}
	auth, ok := payload["serverAuth"].(serverOutboundAuth)
	if !ok || auth.Version != "v1" || auth.Event != event || auth.Nonce == "" || auth.Timestamp <= 0 {
		t.Fatalf("missing server auth for %s: %+v", event, payload["serverAuth"])
	}
	unsigned := make(map[string]interface{}, len(payload)-1)
	for key, value := range payload {
		if key != "serverAuth" {
			unsigned[key] = value
		}
	}
	encoded, err := json.Marshal(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	if auth.PayloadHash != hex.EncodeToString(digest[:]) {
		t.Fatalf("incorrect payload hash for %s", event)
	}
	publicKey, err := crypto.NewKeyFromArmored(cs.serverPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	ring, err := crypto.NewKeyRing(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := crypto.NewPGPSignatureFromArmored(auth.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if err := ring.VerifyDetached(crypto.NewPlainMessageFromString(buildServerSigningInput(auth)), signature, time.Now().Unix()); err != nil {
		t.Fatalf("invalid server signature for %s: %v", event, err)
	}
	var response twoUserDirectoryResponse
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func twoUserHistory(t *testing.T, cs *ChatServer, socket *fakeServerSocket, user *testUserSigner, roomID string) twoUserDirectoryResponse {
	t.Helper()
	socket.invokeEvent(t, EventClientRequestRoomData, map[string]interface{}{
		"userId": user.userID, "sessionId": user.sessionID, "roomId": roomID, "room": roomID,
	})
	twoUserAction(t, socket, "roomData", true, "ok")
	return twoUserResponse(t, cs, socket, EventServerMessage)
}

func twoUserAssertMessages(t *testing.T, response twoUserDirectoryResponse, roomID string, expected map[string]Message) {
	t.Helper()
	found := make(map[string]Message)
	for _, message := range response.Messages[roomID] {
		if message.UserID == SystemUserID {
			continue
		}
		if message.ID == "" || message.RoomID != roomID || message.Content != "" || message.Username != "" {
			t.Fatalf("non-opaque or incomplete message: id=%s roomId=%s userId=%s", message.ID, message.RoomID, message.UserID)
		}
		if _, duplicate := found[message.ID]; duplicate {
			t.Fatalf("duplicate message ID %s", message.ID)
		}
		found[message.ID] = message
	}
	if !reflect.DeepEqual(found, expected) {
		t.Fatalf("history for %s differs: got %d messages, want %d; ciphertext, author or metadata changed", roomID, len(found), len(expected))
	}
}

func TestTwoUserGrantTimestampCollision(t *testing.T) {
	cs := newIntegrationTestServer(t)
	alice, bob := newTwoUserSigner(t), newTwoUserSigner(t)
	sockets := twoUserSockets(t, cs, alice, bob)
	roomID := cs.ensureRoomID("collision-room")
	stamp := time.Now().Unix()
	aliceCipher := twoUserCiphertext(t, "Alice original", alice, bob)
	bobCipher := twoUserCiphertext(t, "Bob original", alice, bob)
	cs.messages["collision-room"] = []Message{
		{ID: "alice-message", UserID: alice.userID, RoomID: roomID, Timestamp: stamp, EncryptedMessage: aliceCipher},
		{ID: "bob-message", UserID: bob.userID, RoomID: roomID, Timestamp: stamp, EncryptedMessage: bobCipher},
	}
	refreshed := twoUserCiphertext(t, "Bob refreshed", alice, bob)
	sockets[1].invokeEvent(t, EventClientGrantAccess, twoUserSigned(t, bob, EventClientGrantAccess, map[string]interface{}{
		"requestingUserId": alice.userID, "originalRoomId": roomID,
		"messageTimestamp": stamp, "encryptedMessage": refreshed,
	}))
	messages := cs.messages["collision-room"]
	if messages[0].EncryptedMessage != aliceCipher || len(messages[0].Versions) != 0 {
		t.Fatal("Bob's grant overwrote Alice's same-timestamp message")
	}
	if messages[1].EncryptedMessage != refreshed || len(messages[1].Versions) != 2 {
		t.Fatal("Bob's grant did not update Bob's message")
	}
	if messages[0].ID != "alice-message" || messages[1].ID != "bob-message" {
		t.Fatal("grant changed message identities")
	}
}

func TestTwoUserServerContract(t *testing.T) {
	contractTest := t
	cs := newIntegrationTestServer(t)
	alice, bob, outsider, serverSigner := newTwoUserSigner(t), newTwoUserSigner(t), newTwoUserSigner(t), newTwoUserSigner(t)
	cs.serverKeyRing, cs.serverPublicKey = serverSigner.privateRing, serverSigner.publicKey
	fingerprints := make(map[string]bool)
	for _, user := range []*testUserSigner{alice, bob, outsider, serverSigner} {
		key, err := crypto.NewKeyFromArmored(user.publicKey)
		if err != nil {
			t.Fatal(err)
		}
		fingerprint := key.GetFingerprint()
		if fingerprints[fingerprint] {
			t.Fatal("independent identities share a key fingerprint")
		}
		fingerprints[fingerprint] = true
	}
	sockets := twoUserSockets(t, cs, alice, bob, outsider)
	for index, user := range []*testUserSigner{alice, bob, outsider} {
		if cs.users[user.userID] != string(sockets[index].ID()) || cs.userSocketsByID[user.userID] != string(sockets[index].ID()) {
			t.Fatalf("identity %s not registered to its unique socket", user.userID)
		}
	}
	roomPlaintext := "TwoUser-private-room-sentinel"
	roomHashBytes := sha256.Sum256([]byte(roomPlaintext))
	roomHash := hex.EncodeToString(roomHashBytes[:])
	ownerRoomCipher := twoUserCiphertext(t, roomPlaintext, alice)
	stamp := time.Now().UnixMilli()
	sockets[0].invokeEvent(t, EventClientNewRoom, twoUserSigned(t, alice, EventClientNewRoom, map[string]interface{}{
		"roomNameCiphertext": ownerRoomCipher, "roomNameHash": roomHash, "roomDirectoryUpdatedAt": stamp,
	}))
	twoUserAction(t, sockets[0], "newRoom", true, "ok")
	created := twoUserResponse(t, cs, sockets[0], EventServerNewRoom)
	roomID := cs.roomNameHashes[roomHash]
	if _, err := uuid.Parse(roomID); err != nil || !contains(created.Rooms, roomID) || cs.roomsByID[roomID] != roomID || created.RoomNameCiphertexts[roomID] != ownerRoomCipher {
		t.Fatalf("room creation did not return an authoritative opaque ID: %q", roomID)
	}
	roomCipher := twoUserCiphertext(t, roomPlaintext, alice, bob)
	userPlaintexts := []string{"TwoUser-alice-name-sentinel", "TwoUser-bob-name-sentinel"}
	userCiphers := map[string]string{
		alice.userID: twoUserCiphertext(t, userPlaintexts[0], alice, bob),
		bob.userID:   twoUserCiphertext(t, userPlaintexts[1], alice, bob),
	}
	users := []*testUserSigner{alice, bob}
	for index, user := range users {
		payload := map[string]interface{}{
			"userId": user.userID, "refreshedForUserIds": []interface{}{users[1-index].userID},
			"userDirectoryCiphertexts": map[string]interface{}{user.userID: userCiphers[user.userID]},
			"userDirectoryUpdatedAt":   map[string]interface{}{user.userID: stamp + 1},
		}
		if index == 0 {
			payload["roomNameCiphertexts"] = map[string]interface{}{roomID: roomCipher}
			payload["roomDirectoryUpdatedAt"] = map[string]interface{}{roomID: stamp + 1}
		}
		sockets[index].invokeEvent(t, EventClientIdentityDirectoryRefresh, twoUserSigned(t, user, EventClientIdentityDirectoryRefresh, payload))
		twoUserAction(t, sockets[index], "identityRefresh", true, "ok")
		refresh := twoUserResponse(t, cs, sockets[index], EventServerIdentityDirectoryRefresh)
		if refresh.UserCiphertexts[user.userID] != userCiphers[user.userID] {
			t.Fatal("accepted refresh changed username ciphertext")
		}
	}
	dmRoomID := buildCanonicalDMRoom(alice.userID, bob.userID)
	twoUserHistory(t, cs, sockets[0], alice, dmRoomID)
	expected := make(map[string]map[string]Message)
	messagePlaintexts := []string{}
	for _, conversation := range []struct{ name, roomID string }{{"SharedRoom", roomID}, {"DM", dmRoomID}} {
		t.Run(conversation.name, func(t *testing.T) {
			expected[conversation.roomID] = make(map[string]Message)
			for index, user := range users {
				plaintext := fmt.Sprintf("TwoUser-%s-direction-%d-body-sentinel", conversation.name, index)
				messagePlaintexts = append(messagePlaintexts, plaintext)
				ciphertext := twoUserCiphertext(t, plaintext, alice, bob)
				sockets[index].invokeEvent(t, EventClientMessage, twoUserSigned(t, user, EventClientMessage, map[string]interface{}{
					"roomId": conversation.roomID, "room": conversation.roomID, "encryptedMessage": ciphertext,
				}))
				echo := twoUserResponse(t, cs, sockets[index], EventServerMessage)
				messages := echo.Messages[conversation.roomID]
				if len(messages) != 1 || messages[0].UserID != user.userID || messages[0].EncryptedMessage != ciphertext {
					t.Fatalf("signed send did not produce unchanged sender echo for %s", user.userID)
				}
				expected[conversation.roomID][messages[0].ID] = messages[0]
			}
			for index, user := range users {
				twoUserAssertMessages(t, twoUserHistory(t, cs, sockets[index], user, conversation.roomID), conversation.roomID, expected[conversation.roomID])
			}
		})
	}
	assertDirectories := func(t *testing.T, current *ChatServer, currentSockets []*fakeServerSocket) {
		t.Helper()
		for index, user := range users {
			currentSockets[index].invokeEvent(t, EventClientRequestInitialData, map[string]interface{}{
				"userId": user.userID, "sessionId": user.sessionID, "currentRoomId": roomID,
			})
			twoUserAction(t, currentSockets[index], "initialData", true, "ok")
			initial := twoUserResponse(t, current, currentSockets[index], EventInitialData)
			if initial.CurrentUserID != user.userID || !contains(initial.Rooms, roomID) || initial.RoomNameCiphertexts[roomID] != roomCipher || initial.RoomDirectoryUpdatedAt[roomID] != stamp+1 {
				t.Fatalf("initial data lost opaque room metadata for %s", user.userID)
			}
			for _, peer := range users {
				if initial.UserPublicKeys[peer.userID] != peer.publicKey || initial.UserCiphertexts[peer.userID] != userCiphers[peer.userID] || initial.UserDirectoryUpdatedAt[peer.userID] <= 0 {
					t.Fatalf("initial data lost peer key or refreshed identity for %s", peer.userID)
				}
			}
			if messages, ok := expected[roomID]; ok {
				twoUserAssertMessages(t, initial, roomID, messages)
			}
			for _, historyRoomID := range []string{roomID, dmRoomID} {
				history := twoUserHistory(t, current, currentSockets[index], user, historyRoomID)
				if !reflect.DeepEqual(history.UserCiphertexts, initial.UserCiphertexts) || !reflect.DeepEqual(history.UserDirectoryUpdatedAt, initial.UserDirectoryUpdatedAt) {
					t.Fatal("room data lost refreshed user directory metadata")
				}
				twoUserAssertMessages(t, history, historyRoomID, expected[historyRoomID])
			}
		}
	}
	t.Run("Directories", func(t *testing.T) { assertDirectories(t, cs, sockets) })
	t.Run("SQLiteReload", func(t *testing.T) {
		store := cs.store.(*SQLiteStore)
		rows, err := store.db.Query(`SELECT message_id, room_id, user_id, COALESCE(content, ''), COALESCE(encrypted_message, '') FROM messages WHERE user_id <> ?`, SystemUserID)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for rows.Next() {
			var messageID, persistedRoomID, userID, content, ciphertext string
			if err := rows.Scan(&messageID, &persistedRoomID, &userID, &content, &ciphertext); err != nil {
				t.Fatal(err)
			}
			message, exists := expected[persistedRoomID][messageID]
			if !exists || content != "" || message.UserID != userID || message.EncryptedMessage != ciphertext {
				t.Fatalf("SQLite changed ciphertext, identity or plaintext fallback for %s", messageID)
			}
			count++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		if count != 4 {
			t.Fatalf("SQLite contains %d user messages, want 4", count)
		}
		sentinels := append([]string{roomPlaintext}, userPlaintexts...)
		sentinels = append(sentinels, messagePlaintexts...)
		metadataRows, err := store.db.Query(`SELECT user_id, COALESCE(username, ''), COALESCE(username_ciphertext, '') FROM users WHERE user_id <> ? UNION ALL SELECT room_id, room_key, COALESCE(room_name_ciphertext, '') FROM rooms`, SystemUserID)
		if err != nil {
			t.Fatal(err)
		}
		for metadataRows.Next() {
			var identity, display, ciphertext string
			if err := metadataRows.Scan(&identity, &display, &ciphertext); err != nil {
				t.Fatal(err)
			}
			for _, sentinel := range sentinels {
				if strings.Contains(identity, sentinel) || strings.Contains(display, sentinel) || strings.Contains(ciphertext, sentinel) {
					t.Fatalf("user-generated plaintext sentinel persisted in metadata for %s", identity)
				}
			}
		}
		if err := metadataRows.Err(); err != nil {
			t.Fatal(err)
		}
		if err := metadataRows.Close(); err != nil {
			t.Fatal(err)
		}
		path := store.filepath
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
		reopened, err := NewSQLiteStore(path)
		if err != nil {
			t.Fatal(err)
		}
		contractTest.Cleanup(func() { _ = reopened.Close() })
		cs.store = reopened
		restored := newIntegrationTestServer(t)
		restored.store = reopened
		restored.serverKeyRing, restored.serverPublicKey = serverSigner.privateRing, serverSigner.publicKey
		restored.messages, restored.rooms, restored.users, restored.userPubKeys, restored.userPubKeysUpdatedAt, _, restored.roomIDs, restored.roomNameHashes, restored.roomNameCiphertexts, restored.usernameCiphertexts, restored.userDirectoryUpdatedAt, restored.roomDirectoryUpdatedAt, err = reopened.Load()
		if err != nil {
			t.Fatal(err)
		}
		restored.userJoinedAt, err = reopened.UserJoinedAt()
		if err != nil {
			t.Fatal(err)
		}
		for room, persistedRoomID := range restored.roomIDs {
			restored.roomsByID[persistedRoomID] = room
		}
		if restored.roomNameHashes[roomHash] != roomID {
			t.Fatal("store reload changed room hash mapping")
		}
		for _, user := range users {
			if restored.userPubKeys[user.userID] != user.publicKey {
				t.Fatal("store reload changed independent user key")
			}
			if restored.userJoinedAt[user.userID] <= 0 {
				t.Fatal("store reload lost the account join timestamp")
			}
		}
		restoredSockets := twoUserSockets(t, restored, alice, bob)
		assertDirectories(t, restored, restoredSockets)
	})
	t.Run("WrongSigningKey", func(t *testing.T) {
		before := cloneMessages(cs.messages)
		forged := *alice
		forged.privateRing = bob.privateRing
		sockets[0].invokeEvent(t, EventClientMessage, twoUserSigned(t, &forged, EventClientMessage, map[string]interface{}{
			"roomId": roomID, "encryptedMessage": twoUserCiphertext(t, "rejected-auth", alice, bob),
		}))
		twoUserAction(t, sockets[0], EventClientMessage, false, "unauthorized")
		if !reflect.DeepEqual(before, cs.messages) {
			t.Fatal("wrong-key signature mutated messages")
		}
	})
	t.Run("CrossAccountSession", func(t *testing.T) {
		before := cloneMessages(cs.messages)
		mismatchedSession := *alice
		mismatchedSession.sessionID = bob.sessionID
		sockets[0].invokeEvent(t, EventClientMessage, twoUserSigned(t, &mismatchedSession, EventClientMessage, map[string]interface{}{
			"roomId": roomID, "encryptedMessage": twoUserCiphertext(t, "rejected-session", alice, bob),
		}))
		twoUserAction(t, sockets[0], EventClientMessage, false, "unauthorized")
		if !reflect.DeepEqual(before, cs.messages) {
			t.Fatal("cross-account session mutated messages")
		}
	})
	t.Run("NonparticipantDMFetch", func(t *testing.T) {
		sockets[2].invokeEvent(t, EventClientRequestRoomData, map[string]interface{}{
			"userId": outsider.userID, "sessionId": outsider.sessionID, "roomId": dmRoomID,
		})
		twoUserAction(t, sockets[2], "roomData", false, "unauthorized")
	})
	t.Run("NonparticipantDMListing", func(t *testing.T) {
		sockets[2].invokeEvent(t, EventClientRequestInitialData, map[string]interface{}{
			"userId": outsider.userID, "sessionId": outsider.sessionID, "currentRoomId": dmRoomID,
		})
		initial := twoUserResponse(t, cs, sockets[2], EventInitialData)
		if contains(initial.Rooms, dmRoomID) || len(initial.Messages[dmRoomID]) != 0 {
			t.Fatal("nonparticipant initial data exposed the DM")
		}
	})
	t.Run("NonparticipantDMSend", func(t *testing.T) {
		before := cloneMessages(cs.messages)
		sockets[2].mu.Lock()
		beforeEmits := len(sockets[2].emitted)
		sockets[2].mu.Unlock()
		sockets[2].invokeEvent(t, EventClientMessage, twoUserSigned(t, outsider, EventClientMessage, map[string]interface{}{
			"roomId": dmRoomID, "room": dmRoomID, "encryptedMessage": twoUserCiphertext(t, "rejected-dm", outsider),
		}))
		sockets[2].mu.Lock()
		for _, emitted := range sockets[2].emitted[beforeEmits:] {
			if emitted.event == EventServerMessage {
				t.Error("nonparticipant DM send produced a message echo")
			}
		}
		sockets[2].mu.Unlock()
		if !reflect.DeepEqual(before, cs.messages) {
			t.Fatal("nonparticipant DM send mutated messages")
		}
	})
}
