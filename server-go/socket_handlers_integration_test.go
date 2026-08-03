package main

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	mapset "github.com/deckarep/golang-set/v2"
	"github.com/google/uuid"
	socketio "github.com/karagenc/socket.io-go"
)

type emittedEvent struct {
	event string
	args  []any
}

type fakeServerSocket struct {
	id                socketio.SocketID
	connected         bool
	events            map[string]any
	disconnectHandler socketio.ServerSocketDisconnectFunc
	emitted           []emittedEvent
	mu                sync.Mutex
}

func newFakeServerSocket(id string) *fakeServerSocket {
	return &fakeServerSocket{
		id:        socketio.SocketID(id),
		connected: true,
		events:    make(map[string]any),
	}
}

func (f *fakeServerSocket) ID() socketio.SocketID { return f.id }

func (f *fakeServerSocket) Connected() bool { return f.connected }

func (f *fakeServerSocket) Recovered() bool { return false }

func (f *fakeServerSocket) Emit(eventName string, v ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cloned := make([]any, len(v))
	copy(cloned, v)
	f.emitted = append(f.emitted, emittedEvent{event: eventName, args: cloned})
}

func (f *fakeServerSocket) Timeout(timeout time.Duration) socketio.Emitter {
	return socketio.Emitter{}
}

func (f *fakeServerSocket) OnEvent(eventName string, handler any) {
	f.events[eventName] = handler
}

func (f *fakeServerSocket) OnceEvent(eventName string, handler any) {
	f.events[eventName] = handler
}

func (f *fakeServerSocket) OffEvent(eventName string, handler ...any) {
	delete(f.events, eventName)
}

func (f *fakeServerSocket) OffAll() {
	f.events = make(map[string]any)
	f.disconnectHandler = nil
}

func (f *fakeServerSocket) OnError(fn socketio.ServerSocketErrorFunc) {}

func (f *fakeServerSocket) OnceError(fn socketio.ServerSocketErrorFunc) {}

func (f *fakeServerSocket) OffError(fn ...socketio.ServerSocketErrorFunc) {}

func (f *fakeServerSocket) OnDisconnecting(fn socketio.ServerSocketDisconnectingFunc) {}

func (f *fakeServerSocket) OnceDisconnecting(fn socketio.ServerSocketDisconnectingFunc) {}

func (f *fakeServerSocket) OffDisconnecting(fn ...socketio.ServerSocketDisconnectingFunc) {}

func (f *fakeServerSocket) OnDisconnect(fn socketio.ServerSocketDisconnectFunc) {
	f.disconnectHandler = fn
}

func (f *fakeServerSocket) OnceDisconnect(fn socketio.ServerSocketDisconnectFunc) {
	f.disconnectHandler = fn
}

func (f *fakeServerSocket) OffDisconnect(fn ...socketio.ServerSocketDisconnectFunc) {
	f.disconnectHandler = nil
}

func (f *fakeServerSocket) Server() *socketio.Server { return nil }

func (f *fakeServerSocket) Namespace() *socketio.Namespace { return nil }

func (f *fakeServerSocket) Join(room ...socketio.Room) {}

func (f *fakeServerSocket) Leave(room socketio.Room) {}

func (f *fakeServerSocket) Rooms() mapset.Set[socketio.Room] { return mapset.NewSet[socketio.Room]() }

func (f *fakeServerSocket) Use(fn any) {}

func (f *fakeServerSocket) To(room ...socketio.Room) *socketio.BroadcastOperator { return nil }

func (f *fakeServerSocket) In(room ...socketio.Room) *socketio.BroadcastOperator { return nil }

func (f *fakeServerSocket) Except(room ...socketio.Room) *socketio.BroadcastOperator { return nil }

func (f *fakeServerSocket) Local() *socketio.BroadcastOperator { return nil }

func (f *fakeServerSocket) Broadcast() *socketio.BroadcastOperator { return nil }

func (f *fakeServerSocket) Disconnect(close bool) {
	if f.disconnectHandler != nil {
		f.disconnectHandler(socketio.ReasonServerShuttingDown)
	}
}

func (f *fakeServerSocket) invokeEvent(t *testing.T, name string, payload interface{}) {
	t.Helper()
	handler, ok := f.events[name]
	if !ok {
		t.Fatalf("missing event handler for %s", name)
	}
	fn, ok := handler.(func(interface{}))
	if !ok {
		t.Fatalf("unexpected handler signature for %s: %T", name, handler)
	}
	fn(payload)
}

func (f *fakeServerSocket) lastEmitFor(event string) (emittedEvent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.emitted) - 1; i >= 0; i-- {
		if f.emitted[i].event == event {
			return f.emitted[i], true
		}
	}
	return emittedEvent{}, false
}

func unsafeValue(v reflect.Value) reflect.Value {
	return reflect.NewAt(v.Type(), unsafe.Pointer(v.UnsafeAddr())).Elem()
}

func invokeFirstOnConnectionHandler(t *testing.T, nsp *socketio.Namespace, socket socketio.ServerSocket) {
	t.Helper()

	nspValue := reflect.ValueOf(nsp).Elem()
	connectionHandlersField := unsafeValue(nspValue.FieldByName("connectionHandlers"))
	handlerStoreValue := unsafeValue(connectionHandlersField.Elem())
	funcs := unsafeValue(handlerStoreValue.FieldByName("funcs"))
	if funcs.Len() == 0 {
		t.Fatal("no registered OnConnection handler found")
	}
	handlerPtr := funcs.Index(0)
	handler := handlerPtr.Elem()
	handler.Call([]reflect.Value{reflect.ValueOf(socket)})
}

type testUserSigner struct {
	userID      string
	sessionID   string
	publicKey   string
	privateRing *crypto.KeyRing
}

var (
	testKeyMaterialOnce          sync.Once
	testKeyMaterialErr           error
	testKeyMaterialPrivateArmored string
	testKeyMaterialPublicArmored  string
)

func ensureTestKeyMaterial() error {
	testKeyMaterialOnce.Do(func() {
		// Tests do not need high-strength keys; prefer speed/determinism for CI.
		armoredPrivate, err := helper.GenerateKey("test-user", "test@example.com", []byte(""), "rsa", 1024)
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to generate cached test private key: %w", err)
			return
		}
		privateKey, err := crypto.NewKeyFromArmored(armoredPrivate)
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to parse cached test private key: %w", err)
			return
		}
		unlocked, err := privateKey.Unlock([]byte(""))
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to unlock cached test private key: %w", err)
			return
		}
		pubBytes, err := unlocked.GetPublicKey()
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to extract cached test public key bytes: %w", err)
			return
		}
		pubKeyObj, err := crypto.NewKey(pubBytes)
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to build cached test public key object: %w", err)
			return
		}
		pubArmored, err := pubKeyObj.Armor()
		if err != nil {
			testKeyMaterialErr = fmt.Errorf("failed to armor cached test public key: %w", err)
			return
		}

		testKeyMaterialPrivateArmored = armoredPrivate
		testKeyMaterialPublicArmored = pubArmored
	})

	return testKeyMaterialErr
}

func newTestUserSigner(t *testing.T, userID, sessionID string) *testUserSigner {
	t.Helper()

	if err := ensureTestKeyMaterial(); err != nil {
		t.Fatalf("failed to initialize cached test key material: %v", err)
	}

	privateKey, err := crypto.NewKeyFromArmored(testKeyMaterialPrivateArmored)
	if err != nil {
		t.Fatalf("failed to parse test private key: %v", err)
	}
	unlocked, err := privateKey.Unlock([]byte(""))
	if err != nil {
		t.Fatalf("failed to unlock test private key: %v", err)
	}
	ring, err := crypto.NewKeyRing(unlocked)
	if err != nil {
		t.Fatalf("failed to build test private key ring: %v", err)
	}

	return &testUserSigner{
		userID:      userID,
		sessionID:   sessionID,
		publicKey:   testKeyMaterialPublicArmored,
		privateRing: ring,
	}
}

func (s *testUserSigner) signMutationPayload(t *testing.T, event string, payload map[string]interface{}, claims map[string]string, timestamp int64, nonce string) map[string]interface{} {
	t.Helper()

	auth := socketMutationAuth{
		Version:   "v1",
		Event:     event,
		UserID:    s.userID,
		SessionID: s.sessionID,
		Timestamp: timestamp,
		Nonce:     nonce,
		Claims:    claims,
	}
	message := crypto.NewPlainMessageFromString(buildSignedRequestInput(auth))
	signature, err := s.privateRing.SignDetached(message)
	if err != nil {
		t.Fatalf("failed to sign mutation payload: %v", err)
	}
	armoredSignature, err := signature.GetArmored()
	if err != nil {
		t.Fatalf("failed to armor signature: %v", err)
	}

	authMap := map[string]interface{}{
		"version":   auth.Version,
		"event":     auth.Event,
		"userId":    auth.UserID,
		"sessionId": auth.SessionID,
		"timestamp": auth.Timestamp,
		"nonce":     auth.Nonce,
		"signature": armoredSignature,
		"claims":    map[string]interface{}{},
	}
	for key, value := range claims {
		authMap["claims"].(map[string]interface{})[key] = value
	}

	copyPayload := make(map[string]interface{}, len(payload)+1)
	for key, value := range payload {
		copyPayload[key] = value
	}
	copyPayload["auth"] = authMap
	return copyPayload
}

func newIntegrationTestServer(t *testing.T) *ChatServer {
	t.Helper()

	serverSigner := newTestUserSigner(t, "server-signer", "server-session")
	storePath := t.TempDir() + "\\chat-state.json"

	return &ChatServer{
		sessionCache:           NewCache(SessionTTL),
		userCache:              NewCache(0),
		messages:               make(Messages),
		rooms:                  []string{},
		users:                  make(map[string]string),
		userSocketsByID:        make(map[string]string),
		userPubKeys:            make(map[string]string),
		userPubKeysUpdatedAt:   make(map[string]int64),
		roomIDs:                make(map[string]string),
		roomsByID:              make(map[string]string),
		serverKeyRing:          serverSigner.privateRing,
		serverPublicKey:        serverSigner.publicKey,
		store:                  NewFileStore(storePath),
		joinRequests:           make(map[string]*JoinRequest),
		userLastSeen:           make(map[string]int64),
		roomMembers:            make(map[string]map[string]bool),
		roomCreators:           make(map[string]string),
		hasSentJoinMsg:         make(map[string]bool),
		joinScheduled:          make(map[string]bool),
		authReplay:             make(map[string]time.Time),
		authReplayOrder:        []string{},
		authReplayLimit:        10000,
		roomNameCiphertexts:    make(map[string]string),
		roomNameHashes:         make(map[string]string),
		usernameHashes:         make(map[string]string),
		usernameCiphertexts:    make(map[string]string),
		userDirectoryUpdatedAt: make(map[string]int64),
		roomDirectoryUpdatedAt: make(map[string]int64),
		pendingLeaveByUser:     make(map[string]int64),
	}
}

func newRegisteredFakeSocket(t *testing.T, cs *ChatServer) (*fakeServerSocket, *socketio.Server, *socketio.Namespace) {
	t.Helper()

	sio := socketio.NewServer(nil)
	t.Cleanup(func() {
		_ = sio.Close()
	})
	cs.setupSocketHandlers(sio)
	nsp := sio.Of("/")
	fake := newFakeServerSocket("socket-1")
	invokeFirstOnConnectionHandler(t, nsp, fake)
	return fake, sio, nsp
}

func TestSocketHandlersIntegrationNewRoom(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, _ := newRegisteredFakeSocket(t, cs)

	signer := newTestUserSigner(t, "user-1", "session-1")
	cs.userPubKeys[signer.userID] = signer.publicKey
	cs.sessionCache.Set(signer.sessionID, signer.userID)

	roomHash := "hash-room-alpha"
	updatedAt := time.Now().UTC().UnixMilli()
	payload := map[string]interface{}{
		"roomNameCiphertext":   "cipher-room-alpha",
		"roomNameHash":         roomHash,
		"roomDirectoryUpdatedAt": updatedAt,
	}
	signedPayload := signer.signMutationPayload(
		t,
		EventClientNewRoom,
		payload,
		map[string]string{
			"roomNameCiphertext":   payload["roomNameCiphertext"].(string),
			"roomNameHash":         roomHash,
			"roomDirectoryUpdatedAt": fmt.Sprintf("%d", updatedAt),
		},
		time.Now().UnixMilli(),
		uuid.NewString(),
	)

	fake.invokeEvent(t, EventClientNewRoom, signedPayload)

	if len(cs.rooms) != 1 {
		t.Fatalf("expected one created room, got %d", len(cs.rooms))
	}
	createdRoom := cs.rooms[0]
	roomID := cs.roomIDs[createdRoom]
	if roomID == "" {
		t.Fatalf("expected room ID for room %q", createdRoom)
	}
	if cs.roomNameHashes[roomHash] != roomID {
		t.Fatalf("expected room hash mapping to room ID, got %q", cs.roomNameHashes[roomHash])
	}
	if cs.roomNameCiphertexts[roomID] != "cipher-room-alpha" {
		t.Fatalf("expected room ciphertext to persist for room ID %q", roomID)
	}

	result, ok := fake.lastEmitFor(EventServerActionResult)
	if !ok {
		t.Fatal("expected action result emission")
	}
	resultPayload, ok := result.args[0].(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected action result payload type: %T", result.args[0])
	}
	if resultPayload["action"] != "newRoom" || resultPayload["success"] != true {
		t.Fatalf("unexpected action result payload: %+v", resultPayload)
	}
}

func TestSocketHandlersIntegrationRequestRoomDataDMBootstrap(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, _ := newRegisteredFakeSocket(t, cs)

	requestUserID := "user-a"
	peerUserID := "user-b"
	sessionID := "session-a"
	cs.sessionCache.Set(sessionID, requestUserID)

	cs.messages[DefaultRoom] = []Message{}
	cs.rooms = append(cs.rooms, DefaultRoom)
	defaultRoomID := cs.ensureRoomID(DefaultRoom)
	cs.roomNameCiphertexts[defaultRoomID] = "cipher-general"
	cs.roomDirectoryUpdatedAt[defaultRoomID] = time.Now().UTC().UnixMilli()

	dmRoom := buildCanonicalDMRoom(requestUserID, peerUserID)
	payload := map[string]interface{}{
		"userId":    requestUserID,
		"sessionId": sessionID,
		"room":      dmRoom,
		"roomId":    dmRoom,
	}

	fake.invokeEvent(t, EventClientRequestRoomData, payload)

	if _, exists := cs.messages[dmRoom]; !exists {
		t.Fatalf("expected DM room bootstrap for %q", dmRoom)
	}
	if len(cs.messages[dmRoom]) == 0 || cs.messages[dmRoom][0].UserID != SystemUserID {
		t.Fatalf("expected intro system message in DM room, got %+v", cs.messages[dmRoom])
	}

	result, ok := fake.lastEmitFor(EventServerActionResult)
	if !ok {
		t.Fatal("expected action result emission")
	}
	resultPayload := result.args[0].(map[string]interface{})
	if resultPayload["action"] != "roomData" || resultPayload["success"] != true {
		t.Fatalf("unexpected action result payload: %+v", resultPayload)
	}
}

func TestSocketHandlersIntegrationVoteJoinApproveAndDeny(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, _ := newRegisteredFakeSocket(t, cs)

	voter := newTestUserSigner(t, "voter-1", "voter-session-1")
	cs.userPubKeys[voter.userID] = voter.publicKey
	cs.sessionCache.Set(voter.sessionID, voter.userID)

	roomName := "room-one"
	roomID := "room-one-id"
	requestingUserID := "joiner-1"
	cs.rooms = []string{roomName}
	cs.messages[roomName] = []Message{}
	cs.roomIDs[roomName] = roomID
	cs.roomsByID[roomID] = roomName
	cs.roomMembers[roomID] = map[string]bool{voter.userID: true}

	approveRequestKey := fmt.Sprintf("%s:%s", roomID, requestingUserID)
	cs.joinRequests[approveRequestKey] = &JoinRequest{
		RequestingUserID: requestingUserID,
		RequestingUser:   requestingUserID,
		RoomID:           roomID,
		Room:             roomName,
		Votes:            map[string]bool{},
		Timestamp:        time.Now().Unix(),
	}

	approvePayload := map[string]interface{}{
		"roomId":           roomID,
		"requestingUserId": requestingUserID,
		"voterUserId":      voter.userID,
		"vote":             true,
	}
	signedApprove := voter.signMutationPayload(
		t,
		EventClientVoteJoin,
		approvePayload,
		map[string]string{
			"roomId":           roomID,
			"requestingUserId": requestingUserID,
			"voterUserId":      voter.userID,
			"vote":             "true",
		},
		time.Now().UnixMilli(),
		uuid.NewString(),
	)
	fake.invokeEvent(t, EventClientVoteJoin, signedApprove)

	if _, exists := cs.joinRequests[approveRequestKey]; exists {
		t.Fatalf("expected approved join request %q to be removed", approveRequestKey)
	}
	if !cs.roomMembers[roomID][requestingUserID] {
		t.Fatalf("expected requesting user %q to be added to room members", requestingUserID)
	}
	if len(cs.messages[roomName]) == 0 || !strings.Contains(cs.messages[roomName][0].Content, UserJoined) {
		t.Fatalf("expected join-approved system message in room history, got %+v", cs.messages[roomName])
	}

	denyRequestingUserID := "joiner-2"
	denyRequestKey := fmt.Sprintf("%s:%s", roomID, denyRequestingUserID)
	cs.joinRequests[denyRequestKey] = &JoinRequest{
		RequestingUserID: denyRequestingUserID,
		RequestingUser:   denyRequestingUserID,
		RoomID:           roomID,
		Room:             roomName,
		Votes:            map[string]bool{},
		Timestamp:        time.Now().Unix(),
	}

	denyPayload := map[string]interface{}{
		"roomId":           roomID,
		"requestingUserId": denyRequestingUserID,
		"voterUserId":      voter.userID,
		"vote":             false,
	}
	signedDeny := voter.signMutationPayload(
		t,
		EventClientVoteJoin,
		denyPayload,
		map[string]string{
			"roomId":           roomID,
			"requestingUserId": denyRequestingUserID,
			"voterUserId":      voter.userID,
			"vote":             "false",
		},
		time.Now().UnixMilli(),
		uuid.NewString(),
	)
	fake.invokeEvent(t, EventClientVoteJoin, signedDeny)

	if _, exists := cs.joinRequests[denyRequestKey]; exists {
		t.Fatalf("expected denied join request %q to be removed", denyRequestKey)
	}
	if len(cs.messages[roomName]) == 0 || !strings.Contains(cs.messages[roomName][0].Content, "denied access") {
		t.Fatalf("expected join-denied system message in room history, got %+v", cs.messages[roomName])
	}
}

func TestSocketHandlersIntegrationClientDisconnectingFlow(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake, _, _ := newRegisteredFakeSocket(t, cs)

	userID := "disconnect-user"
	sessionID := "disconnect-session"

	cs.messages[DefaultRoom] = []Message{}
	cs.rooms = []string{DefaultRoom}
	cs.ensureRoomID(DefaultRoom)
	cs.sessionCache.Set(sessionID, userID)
	cs.userPubKeys[userID] = "pub"
	cs.userLastSeen[userID] = time.Now().Unix()

	cs.users[userID] = sessionID
	cs.userSocketsByID[userID] = sessionID

	fake.invokeEvent(t, EventClientDisconnecting, sessionID)

	if _, exists := cs.users[userID]; exists {
		t.Fatal("expected disconnected user to be removed from active users")
	}
	if _, exists := cs.userSocketsByID[userID]; exists {
		t.Fatal("expected disconnected user socket mapping to be removed")
	}
	if _, exists := cs.pendingLeaveByUser[userID]; exists {
		t.Fatal("expected no pending leave marker for explicit clientDisconnecting flow")
	}
}

func TestVerifySignedMutationFailureBranches(t *testing.T) {
	cs := newIntegrationTestServer(t)
	fake := newFakeServerSocket("socket-auth")

	if _, ok := cs.verifySignedMutation(fake, map[string]interface{}{}, EventClientVoteJoin, nil); ok {
		t.Fatal("expected missing auth envelope to fail verification")
	}
	result, ok := fake.lastEmitFor(EventServerActionResult)
	if !ok {
		t.Fatal("expected action result for missing auth envelope")
	}
	resultPayload := result.args[0].(map[string]interface{})
	if resultPayload["code"] != "invalid_request" {
		t.Fatalf("expected invalid_request code, got %+v", resultPayload)
	}

	signer := newTestUserSigner(t, "verify-user", "verify-session")
	cs.sessionCache.Set(signer.sessionID, signer.userID)
	basePayload := map[string]interface{}{
		"roomId":           "room-id",
		"requestingUserId": "joiner",
		"voterUserId":      signer.userID,
		"vote":             true,
	}

	claims := map[string]string{
		"roomId":           "room-id",
		"requestingUserId": "joiner",
		"voterUserId":      signer.userID,
		"vote":             "true",
	}
	valid := signer.signMutationPayload(t, EventClientVoteJoin, basePayload, claims, time.Now().UnixMilli(), "nonce-auth-fail")

	cs.userPubKeys[signer.userID] = "not-an-armored-key"
	if _, ok := cs.verifySignedMutation(fake, valid, EventClientVoteJoin, []string{"roomId", "requestingUserId", "voterUserId", "vote"}); ok {
		t.Fatal("expected invalid signer key to fail verification")
	}
	result, _ = fake.lastEmitFor(EventServerActionResult)
	resultPayload = result.args[0].(map[string]interface{})
	if resultPayload["message"] != "Invalid signer key" {
		t.Fatalf("unexpected invalid signer key message: %+v", resultPayload)
	}

	cs.userPubKeys[signer.userID] = signer.publicKey
	tampered := make(map[string]interface{}, len(valid))
	for k, v := range valid {
		tampered[k] = v
	}
	authMap := tampered["auth"].(map[string]interface{})
	authMap["nonce"] = "nonce-invalid-signature"
	authMap["signature"] = "-----BEGIN PGP SIGNATURE-----\ninvalid\n-----END PGP SIGNATURE-----"
	if _, ok := cs.verifySignedMutation(fake, tampered, EventClientVoteJoin, []string{"roomId", "requestingUserId", "voterUserId", "vote"}); ok {
		t.Fatal("expected invalid detached signature to fail verification")
	}
	result, _ = fake.lastEmitFor(EventServerActionResult)
	resultPayload = result.args[0].(map[string]interface{})
	if resultPayload["message"] != "Invalid request signature" {
		t.Fatalf("unexpected invalid signature message: %+v", resultPayload)
	}

	replayPayload := signer.signMutationPayload(t, EventClientVoteJoin, basePayload, claims, time.Now().UnixMilli(), "replay-nonce")
	if _, ok := cs.verifySignedMutation(fake, replayPayload, EventClientVoteJoin, []string{"roomId", "requestingUserId", "voterUserId", "vote"}); !ok {
		t.Fatal("expected first replay payload verification to succeed")
	}
	if _, ok := cs.verifySignedMutation(fake, replayPayload, EventClientVoteJoin, []string{"roomId", "requestingUserId", "voterUserId", "vote"}); ok {
		t.Fatal("expected second replay payload verification to fail")
	}
	result, _ = fake.lastEmitFor(EventServerActionResult)
	resultPayload = result.args[0].(map[string]interface{})
	if resultPayload["message"] != "Replay detected" {
		t.Fatalf("unexpected replay detection message: %+v", resultPayload)
	}
}

func TestGenerateOrLoadServerKeysFailureBranches(t *testing.T) {
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd failed: %v", err)
	}
	workDir := t.TempDir()
	if err := os.Chdir(workDir); err != nil {
		t.Fatalf("Chdir failed: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(originalDir) })

	if err := os.WriteFile("server-gpg-private-key.asc", []byte("not-a-private-key"), 0600); err != nil {
		t.Fatalf("failed to write invalid private key file: %v", err)
	}
	if err := os.WriteFile("server-gpg-key.asc", []byte("not-a-public-key"), 0644); err != nil {
		t.Fatalf("failed to write invalid public key file: %v", err)
	}

	if _, _, err := generateOrLoadServerKeys(); err == nil || !strings.Contains(err.Error(), "failed to parse private key") {
		t.Fatalf("expected private key parse error, got %v", err)
	}
}

func TestWithServerSignatureFailureBranch(t *testing.T) {
	cs := newIntegrationTestServer(t)
	cs.serverKeyRing = &crypto.KeyRing{}

	payload := map[string]interface{}{"messages": map[string][]Message{"general": {{UserID: SystemUserID, Content: "ok"}}}}
	signed := cs.withServerSignature(EventServerMessage, payload)
	resultPayload, ok := signed.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected payload type from withServerSignature: %T", signed)
	}
	if _, hasServerAuth := resultPayload["serverAuth"]; hasServerAuth {
		t.Fatalf("expected no serverAuth when signing fails: %+v", resultPayload)
	}
}
