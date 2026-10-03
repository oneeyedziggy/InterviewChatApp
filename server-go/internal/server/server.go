package server

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	"github.com/google/uuid"
)

type ChatServer struct {
	sessionCache           *Cache
	userCache              *Cache
	messages               Messages
	rooms                  []string
	users                  map[string]string
	userSocketsByID        map[string]string
	userPubKeys            map[string]string
	userPubKeysUpdatedAt   map[string]int64
	roomIDs                map[string]string
	roomsByID              map[string]string
	serverKeyRing          *crypto.KeyRing
	serverPublicKey        string
	mu                     sync.RWMutex
	store                  StateStore
	joinRequests           map[string]*JoinRequest
	userLastSeen           map[string]int64
	roomMembers            map[string]map[string]bool
	roomCreators           map[string]string
	hasSentJoinMsg         map[string]bool
	joinScheduled          map[string]bool
	defaultNsp             *wsrt.Namespace
	authReplay             map[string]time.Time
	authReplayOrder        []string
	authReplayLimit        int
	roomNameCiphertexts    map[string]string
	roomNameHashes         map[string]string
	usernameHashes         map[string]string
	usernameCiphertexts    map[string]string
	userDirectoryUpdatedAt map[string]int64
	roomDirectoryUpdatedAt map[string]int64
	roomCreatedAt          map[string]int64
	userJoinedAt           map[string]int64
	pendingLeaveByUser     map[string]int64
	alias                  string
	persistenceMetrics     persistenceCounters
}

func formatSystemUserRef(userID string) string {
	trimmed := strings.TrimSpace(userID)
	if trimmed == "" {
		return ""
	}
	return "userId:" + trimmed
}

func parseSystemUserRef(value string) string {
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(trimmed, "userId:") {
		return strings.TrimSpace(strings.TrimPrefix(trimmed, "userId:"))
	}
	return trimmed
}

func resolveSQLiteStorePath() string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "chat-state.sqlite3"
	}
	return filepath.Join(filepath.Dir(thisFile), "chat-state.sqlite3")
}

func NewChatServer(storePath string) *ChatServer {
	return newChatServer(storePath, nil, "")
}

func newChatServer(storePath string, suppliedKeyRing *crypto.KeyRing, suppliedPublicKey string) *ChatServer {
	if storePath == "" {
		storePath = resolveSQLiteStorePath()
	}
	log.Printf("[NewChatServer] Using sqlite state store: %s", storePath)
	store, err := NewStateStore(storePath)
	if err != nil {
		log.Fatalf("[NewChatServer] ✗ Failed to initialize state store: %v", err)
	}

	messages, rooms, users, userPubKeys, userPubKeysUpdatedAt, _, roomIDs, roomNameHashes, roomNameCiphertexts, usernameCiphertexts, userDirectoryUpdatedAt, roomDirectoryUpdatedAt, err := store.Load()
	if err != nil {
		log.Printf("[NewChatServer] ✗ Failed to load state: %v, starting with empty state", err)
		messages = make(Messages)
		rooms = []string{}
		users = make(map[string]string)
		userPubKeys = make(map[string]string)
		roomIDs = make(map[string]string)
		roomNameHashes = make(map[string]string)
		roomNameCiphertexts = make(map[string]string)
		usernameCiphertexts = make(map[string]string)
		userPubKeysUpdatedAt = make(map[string]int64)
		userDirectoryUpdatedAt = make(map[string]int64)
		roomDirectoryUpdatedAt = make(map[string]int64)
	}
	if userPubKeysUpdatedAt == nil {
		userPubKeysUpdatedAt = make(map[string]int64)
	}
	if userDirectoryUpdatedAt == nil {
		userDirectoryUpdatedAt = make(map[string]int64)
	}
	if roomDirectoryUpdatedAt == nil {
		roomDirectoryUpdatedAt = make(map[string]int64)
	}
	if roomNameCiphertexts == nil {
		roomNameCiphertexts = make(map[string]string)
	}
	if usernameCiphertexts == nil {
		usernameCiphertexts = make(map[string]string)
	}
	if roomNameHashes == nil {
		roomNameHashes = make(map[string]string)
	}

	// Active socket sessions are runtime-only and must never survive restart.
	// Keep the loaded value only to satisfy assignment before resetting.
	_ = users
	users = make(map[string]string)

	// Purge messages on startup only if explicitly requested via
	// the CLEAR_ON_START environment variable. Preserving messages by
	// default avoids losing chat history on server restarts.
	if strings.ToLower(os.Getenv("CLEAR_ON_START")) == "true" {
		log.Printf("[NewChatServer] Purging all existing messages (CLEAR_ON_START=true)...")
		messages = make(Messages)
		for _, room := range rooms {
			messages[room] = []Message{}
		}
		log.Printf("[NewChatServer] ✓ All messages purged")
	} else {
		log.Printf("[NewChatServer] Skipping message purge on startup (CLEAR_ON_START!=true)")
	}

	keyDirectory := filepath.Dir(storePath)
	keyPrefix := ""
	if filepath.Base(storePath) != filepath.Base(resolveSQLiteStorePath()) {
		keyPrefix = strings.TrimSuffix(filepath.Base(storePath), filepath.Ext(storePath))
	}
	serverKeyRing := suppliedKeyRing
	serverPublicKey := suppliedPublicKey
	if serverKeyRing == nil || serverPublicKey == "" {
		serverKeyRing, serverPublicKey, err = generateOrLoadServerKeys(keyDirectory, keyPrefix)
	}
	if err != nil {
		log.Fatalf("[NewChatServer] ✗ Failed to generate/load server GPG keys: %v", err)
	}

	joinRequests := make(map[string]*JoinRequest)
	userLastSeen := make(map[string]int64)
	roomMembers := make(map[string]map[string]bool)
	roomCreators := make(map[string]string)

	roomCreatedAt, err := store.RoomCreatedAt()
	if err != nil {
		log.Printf("[NewChatServer] ✗ Failed to load room created_at timestamps: %v, continuing without them", err)
		roomCreatedAt = make(map[string]int64)
	}
	userJoinedAt, err := store.UserJoinedAt()
	if err != nil {
		log.Printf("[NewChatServer] Failed to load user joined_at timestamps: %v", err)
		userJoinedAt = make(map[string]int64)
	}

	for _, room := range rooms {
		roomID := roomIDs[room]
		if roomID == "" {
			roomID = uuid.NewString()
			roomIDs[room] = roomID
		}
		roomMembers[roomID] = make(map[string]bool)
	}

	cs := &ChatServer{
		sessionCache:           NewSlidingCache(SessionTTL, SessionMaxLifetime),
		userCache:              NewCache(0),
		messages:               messages,
		rooms:                  rooms,
		users:                  users,
		userSocketsByID:        make(map[string]string),
		userPubKeys:            userPubKeys,
		userPubKeysUpdatedAt:   userPubKeysUpdatedAt,
		roomIDs:                roomIDs,
		roomsByID:              make(map[string]string),
		serverKeyRing:          serverKeyRing,
		serverPublicKey:        serverPublicKey,
		store:                  store,
		joinRequests:           joinRequests,
		userLastSeen:           userLastSeen,
		roomMembers:            roomMembers,
		roomCreators:           roomCreators,
		hasSentJoinMsg:         make(map[string]bool),
		joinScheduled:          make(map[string]bool),
		authReplay:             make(map[string]time.Time),
		authReplayOrder:        make([]string, 0, 4096),
		authReplayLimit:        10000,
		roomNameHashes:         roomNameHashes,
		usernameHashes:         make(map[string]string),
		usernameCiphertexts:    usernameCiphertexts,
		roomNameCiphertexts:    roomNameCiphertexts,
		userDirectoryUpdatedAt: userDirectoryUpdatedAt,
		roomDirectoryUpdatedAt: roomDirectoryUpdatedAt,
		roomCreatedAt:          roomCreatedAt,
		userJoinedAt:           userJoinedAt,
		pendingLeaveByUser:     make(map[string]int64),
	}

	for room, roomID := range cs.roomIDs {
		if room == "" || roomID == "" {
			continue
		}
		cs.roomsByID[roomID] = room
	}

	for _, room := range cs.rooms {
		cs.ensureRoomIDLocked(room)
	}

	// Populate hasSentJoinMsg for users who already have a system "joined"
	// message in the default room. This prevents the server from re-posting
	// a join message on restart for users who had already joined previously.
	if msgs, ok := messages[DefaultRoom]; ok {
		for _, m := range msgs {
			if m.Username == "system" && strings.HasSuffix(m.Content, UserJoined) {
				uname := parseSystemUserRef(strings.TrimSuffix(m.Content, " "+UserJoined))
				if uname != "" {
					cs.hasSentJoinMsg[uname] = true
				}
			}
		}
	}

	log.Printf("[NewChatServer] ✓ Chat server initialized with %d rooms, %d active sessions (cleared on restart), %d message rooms, %d registered pub keys",
		len(cs.rooms), len(cs.users), len(cs.messages), len(cs.userPubKeys))

	return cs
}

func (cs *ChatServer) ensureUserIDLocked(userID string) string {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ""
	}
	return userID
}

func (cs *ChatServer) ensureRoomIDLocked(room string) string {
	room = strings.TrimSpace(room)
	if room == "" {
		return ""
	}

	if strings.HasPrefix(room, "@dmid:") {
		// DM rooms are canonical and self-identifying; using the room name as the
		// room ID avoids opaque-ID mapping drift across reconnects/reloads.
		cs.roomIDs[room] = room
		cs.roomsByID[room] = room
		return room
	}

	if roomID, ok := cs.roomIDs[room]; ok && roomID != "" {
		cs.roomsByID[roomID] = room
		return roomID
	}

	roomID := uuid.NewString()
	cs.roomIDs[room] = roomID
	cs.roomsByID[roomID] = room
	return roomID
}

func (cs *ChatServer) ensureRoomID(room string) string {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.ensureRoomIDLocked(room)
}

func (cs *ChatServer) roomNameForIDLocked(roomID string) string {
	if roomID == "" {
		return ""
	}
	if roomName := cs.roomsByID[roomID]; roomName != "" {
		return roomName
	}
	for roomName, candidateRoomID := range cs.roomIDs {
		if candidateRoomID == roomID {
			return roomName
		}
	}
	return ""
}

func (cs *ChatServer) oldestExtantRoomIDLocked() string {
	var oldestRoomID string
	var oldestCreatedAt int64

	// Prefer the persisted true creation timestamp; it survives restarts,
	// unlike the runtime-only roomDirectoryUpdatedAt fallback below.
	for _, room := range cs.rooms {
		roomID := cs.roomIDs[room]
		if roomID == "" {
			continue
		}
		createdAt := cs.roomCreatedAt[roomID]
		if createdAt <= 0 {
			continue
		}
		if oldestRoomID == "" || createdAt < oldestCreatedAt {
			oldestRoomID = roomID
			oldestCreatedAt = createdAt
		}
	}
	if oldestRoomID != "" {
		return oldestRoomID
	}

	var oldestUpdatedAt int64

	for _, room := range cs.rooms {
		roomID := cs.roomIDs[room]
		if roomID == "" {
			continue
		}
		updatedAt := cs.roomDirectoryUpdatedAt[roomID]
		if oldestRoomID == "" || (updatedAt > 0 && (oldestUpdatedAt == 0 || updatedAt < oldestUpdatedAt)) {
			oldestRoomID = roomID
			oldestUpdatedAt = updatedAt
		}
	}

	if oldestRoomID != "" {
		return oldestRoomID
	}

	for roomID, updatedAt := range cs.roomDirectoryUpdatedAt {
		if roomID == "" {
			continue
		}
		if oldestRoomID == "" || (updatedAt > 0 && (oldestUpdatedAt == 0 || updatedAt < oldestUpdatedAt)) {
			oldestRoomID = roomID
			oldestUpdatedAt = updatedAt
		}
	}

	if oldestRoomID != "" {
		return oldestRoomID
	}

	for _, roomID := range cs.roomIDs {
		if roomID != "" {
			return roomID
		}
	}
	return ""
}

func (cs *ChatServer) roomIsAddressableLocked(room string) bool {
	room = strings.TrimSpace(room)
	if room == "" {
		return false
	}
	if strings.HasPrefix(room, "@dmid:") {
		return true
	}
	if roomID := cs.roomIDs[room]; roomID != "" {
		if _, err := uuid.Parse(room); err == nil {
			return cs.roomNameCiphertexts[roomID] != ""
		}
	}
	if _, err := uuid.Parse(room); err == nil {
		return false
	}
	return true
}

func (cs *ChatServer) systemMessageRoomLocked(preferredRoom string) (string, string) {
	preferredRoom = strings.TrimSpace(preferredRoom)
	if preferredRoom != "" {
		if roomID := cs.roomIDs[preferredRoom]; roomID != "" && cs.roomIsAddressableLocked(preferredRoom) {
			return preferredRoom, roomID
		}
	}

	for _, room := range cs.rooms {
		if roomID := cs.roomIDs[room]; roomID != "" && cs.roomIsAddressableLocked(room) {
			return room, roomID
		}
	}

	for room, roomID := range cs.roomIDs {
		if room != "" && roomID != "" && cs.roomIsAddressableLocked(room) {
			return room, roomID
		}
	}

	if preferredRoom != "" {
		return preferredRoom, cs.ensureRoomIDLocked(preferredRoom)
	}

	return DefaultRoom, cs.ensureRoomIDLocked(DefaultRoom)
}

func (cs *ChatServer) systemMessageRoomIDLocked(preferredRoom string) string {
	_, roomID := cs.systemMessageRoomLocked(preferredRoom)
	return roomID
}

func (cs *ChatServer) getIdentityMapsForSave() map[string]string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	roomIDsCopy := make(map[string]string, len(cs.roomIDs))
	for roomName, roomID := range cs.roomIDs {
		roomIDsCopy[roomName] = roomID
	}

	return roomIDsCopy
}

func (cs *ChatServer) saveState(messages Messages, rooms []string, users map[string]string, userPubKeys map[string]string) error {
	roomIDsCopy := cs.getIdentityMapsForSave()
	cs.mu.RLock()
	userPubKeysUpdatedAt := make(map[string]int64, len(cs.userPubKeysUpdatedAt))
	for userID, updatedAt := range cs.userPubKeysUpdatedAt {
		userPubKeysUpdatedAt[userID] = updatedAt
	}
	userDirectoryUpdatedAt := make(map[string]int64, len(cs.userDirectoryUpdatedAt))
	for userID, updatedAt := range cs.userDirectoryUpdatedAt {
		userDirectoryUpdatedAt[userID] = updatedAt
	}
	roomDirectoryUpdatedAt := make(map[string]int64, len(cs.roomDirectoryUpdatedAt))
	for roomID, updatedAt := range cs.roomDirectoryUpdatedAt {
		roomDirectoryUpdatedAt[roomID] = updatedAt
	}
	roomNameHashes := make(map[string]string, len(cs.roomNameHashes))
	for roomNameHash, roomID := range cs.roomNameHashes {
		roomNameHashes[roomNameHash] = roomID
	}
	roomNameCiphertexts := make(map[string]string, len(cs.roomNameCiphertexts))
	for roomID, ciphertext := range cs.roomNameCiphertexts {
		roomNameCiphertexts[roomID] = ciphertext
	}
	usernameCiphertexts := make(map[string]string, len(cs.usernameCiphertexts))
	for userID, ciphertext := range cs.usernameCiphertexts {
		usernameCiphertexts[userID] = ciphertext
	}
	cs.mu.RUnlock()
	return cs.store.SaveWithIdentity(messages, rooms, users, userPubKeys, userPubKeysUpdatedAt, nil, roomIDsCopy, roomNameHashes, roomNameCiphertexts, usernameCiphertexts, userDirectoryUpdatedAt, roomDirectoryUpdatedAt)
}

func generateOrLoadServerKeys(keyDirectories ...string) (*crypto.KeyRing, string, error) {
	keyDirectory := "."
	if len(keyDirectories) > 0 && strings.TrimSpace(keyDirectories[0]) != "" {
		keyDirectory = keyDirectories[0]
	}
	keyPrefix := ""
	if len(keyDirectories) > 1 {
		keyPrefix = strings.TrimSpace(keyDirectories[1])
	}
	keySuffix := "server-gpg"
	if keyPrefix != "" {
		keySuffix = keyPrefix + ".server-gpg"
	}
	keyPath := filepath.Join(keyDirectory, keySuffix+"-key.asc")
	privateKeyPath := filepath.Join(keyDirectory, keySuffix+"-private-key.asc")

	if _, err := os.Stat(privateKeyPath); err == nil {
		log.Printf("[GPG] Loading existing server keys from %s", privateKeyPath)
		privateKeyData, err := os.ReadFile(privateKeyPath)
		if err != nil {
			return nil, "", fmt.Errorf("failed to read private key: %w", err)
		}

		publicKeyData, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, "", fmt.Errorf("failed to read public key: %w", err)
		}

		privateKey, err := crypto.NewKeyFromArmored(string(privateKeyData))
		if err != nil {
			return nil, "", fmt.Errorf("failed to parse private key: %w", err)
		}

		unlockedKey, err := privateKey.Unlock([]byte(""))
		if err != nil {
			return nil, "", fmt.Errorf("failed to unlock key: %w", err)
		}

		keyRing, err := crypto.NewKeyRing(unlockedKey)
		if err != nil {
			return nil, "", fmt.Errorf("failed to create key ring: %w", err)
		}

		return keyRing, string(publicKeyData), nil
	}

	log.Printf("[GPG] Generating new server GPG key pair...")
	rsaKey, err := helper.GenerateKey("Chat Server", "server@chat.local", []byte(""), "rsa", 2048)
	if err != nil {
		return nil, "", fmt.Errorf("failed to generate key: %w", err)
	}

	privateKey, err := crypto.NewKeyFromArmored(rsaKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to parse generated key: %w", err)
	}

	unlockedKey, err := privateKey.Unlock([]byte(""))
	if err != nil {
		return nil, "", fmt.Errorf("failed to unlock key: %w", err)
	}

	keyRing, err := crypto.NewKeyRing(unlockedKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create key ring: %w", err)
	}

	publicKeyBytes, err := unlockedKey.GetPublicKey()
	if err != nil {
		return nil, "", fmt.Errorf("failed to get public key: %w", err)
	}

	publicKeyObj, err := crypto.NewKey(publicKeyBytes)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create public key object: %w", err)
	}

	publicKeyArmored, err := publicKeyObj.Armor()
	if err != nil {
		return nil, "", fmt.Errorf("failed to armor public key: %w", err)
	}

	if err := os.WriteFile(keyPath, []byte(publicKeyArmored), 0644); err != nil {
		log.Printf("[GPG] ⚠ Failed to save public key: %v", err)
	}

	privateKeyArmored := rsaKey
	if err := os.WriteFile(privateKeyPath, []byte(privateKeyArmored), 0600); err != nil {
		log.Printf("[GPG] ⚠ Failed to save private key: %v", err)
	}

	log.Printf("[GPG] ✓ Generated and saved new server GPG key pair")
	return keyRing, publicKeyArmored, nil
}

func (cs *ChatServer) setUser(userID, sessionID string) {
	log.Printf("[setUser] ===== ENTERING setUser ======")
	log.Printf("[setUser] Attempting to acquire lock for user: %s", userID)
	cs.mu.Lock()
	log.Printf("[setUser] ✓ Lock acquired")
	oldSessionID, wasLoggedIn := cs.users[userID]
	cs.users[userID] = sessionID
	if _, pending := cs.pendingLeaveByUser[userID]; pending {
		delete(cs.pendingLeaveByUser, userID)
		log.Printf("[setUser] ✓ Canceled pending leave message for %s", userID)
	}
	if !wasLoggedIn || oldSessionID != sessionID {
		log.Printf("[setUser] Session changed for %s (was logged in: %v); suppressing join/leave system messages", userID, wasLoggedIn)
	}
	log.Printf("[setUser] ✓ User set in map")
	shouldBroadcast := !wasLoggedIn || oldSessionID != sessionID
	cs.mu.Unlock()
	log.Printf("[setUser] ✓ Lock released")
	if shouldBroadcast {
		cs.broadcastUserListUpdate()
	}
	go cs.deliverPendingAccessGrantRequests(userID)
	log.Printf("[setUser] ===== EXITING setUser ======")
}

func (cs *ChatServer) deliverPendingAccessGrantRequests(userID string) {
	if cs.defaultNsp == nil {
		return
	}
	requests, err := cs.store.PendingAccessGrantRequestsForUser(userID)
	if err != nil {
		log.Printf("[accessRequest] failed to load pending requests for %s: %v", userID, err)
		return
	}
	for _, request := range requests {
		cs.mu.RLock()
		roomName := cs.roomsByID[request.OriginalRoomID]
		requestingKey := cs.userPubKeys[request.RequestingUserID]
		requestingUpdatedAt := cs.userPubKeysUpdatedAt[request.RequestingUserID]
		cs.mu.RUnlock()
		if roomName == "" {
			continue
		}
		requestAccess := map[string]interface{}{
			"requestingUserId": request.RequestingUserID,
			"originalSenderId": request.OriginalSenderID,
			"originalRoomId":   request.OriginalRoomID,
			"originalRoom":     roomName,
			"messageTimestamp": request.MessageTimestamp,
		}
		payload := map[string]interface{}{
			"requestAccess":                 requestAccess,
			"requestRoom":                   buildCanonicalDMRoom(request.RequestingUserID, request.OriginalSenderID),
			"requestingUserId":              request.RequestingUserID,
			"originalSenderId":              request.OriginalSenderID,
			"requestingUserPubKey":          requestingKey,
			"requestingUserPubKeyUpdatedAt": requestingUpdatedAt,
		}
		cs.sendToUserIDs(cs.defaultNsp, []string{userID}, EventServerAccessRequest, payload)
		if err := cs.store.CompleteAccessGrantRequest(request.RequestID); err != nil {
			log.Printf("[accessRequest] failed to complete request %s: %v", request.RequestID, err)
		}
	}
}

func (cs *ChatServer) broadcastUserListUpdate() {
	cs.mu.RLock()
	nsp := cs.defaultNsp
	userLastSeenCopy := make(map[string]int64, len(cs.userLastSeen))
	for user, lastSeen := range cs.userLastSeen {
		userLastSeenCopy[user] = lastSeen
	}
	cs.mu.RUnlock()

	if nsp == nil {
		return
	}

	loggedInUsers, activeUsers := cs.getUserLists()
	userListData := map[string]interface{}{
		"loggedInUsers": loggedInUsers,
		"activeUsers":   activeUsers,
		"userLastSeen":  userLastSeenCopy,
	}
	cs.emitNamespaceSigned(nsp, EventServerUserListUpdate, userListData)
	log.Printf("[broadcastUserListUpdate] ✓ Broadcasted user list (%d logged in, %d active)", len(loggedInUsers), len(activeUsers))
}

func (cs *ChatServer) registerUserFromAuth(userID, socketID string) {
	if userID == "" || socketID == "" {
		return
	}

	cs.mu.Lock()
	existingSessionID, userExists := cs.users[userID]
	cs.mu.Unlock()

	if !userExists || existingSessionID != socketID {
		log.Printf("[registerUserFromAuth] Registering %s on connect (socket %s)", userID, socketID)
		cs.setUser(userID, socketID)
		cs.mu.Lock()
		cs.userLastSeen[userID] = time.Now().Unix()
		cs.userSocketsByID[userID] = socketID
		cs.mu.Unlock()
	}
}

func (cs *ChatServer) sendJoinMessage(userID string) {
	if userID == "" {
		return
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	// If the join message has already been sent, nothing to do.
	if cs.hasSentJoinMsg[userID] {
		// Clean up any scheduled marker if present.
		delete(cs.joinScheduled, userID)
		return
	}

	targetRoomID := cs.oldestExtantRoomIDLocked()
	targetRoom := cs.roomNameForIDLocked(targetRoomID)
	if targetRoom == "" || targetRoomID == "" {
		targetRoom, targetRoomID = cs.systemMessageRoomLocked(DefaultRoom)
	}
	if cs.messages[targetRoom] == nil {
		cs.messages[targetRoom] = []Message{}
	}
	if cs.roomMembers[targetRoomID] == nil {
		cs.roomMembers[targetRoomID] = make(map[string]bool)
	}
	if !cs.roomMembers[targetRoomID][userID] {
		cs.roomMembers[targetRoomID][userID] = true
		if len(cs.roomMembers[targetRoomID]) == 1 {
			cs.roomCreators[targetRoomID] = userID
			log.Printf("[sendJoinMessage] Set %s as creator of %s", userID, DefaultRoom)
		}
	}

	joinMsg := Message{
		ID:        uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Username:  "system",
		UserID:    SystemUserID,
		RoomID:    targetRoomID,
		Content:   fmt.Sprintf("%s %s", formatSystemUserRef(userID), UserJoined),
		Edited:    false,
	}
	cs.messages[targetRoom] = append([]Message{joinMsg}, cs.messages[targetRoom]...)
	cs.hasSentJoinMsg[userID] = true
	// Clear scheduled marker now that the join message has been sent.
	delete(cs.joinScheduled, userID)
	log.Printf("[sendJoinMessage] ✓ Sent join message for %s to %s", userID, targetRoom)

	if cs.defaultNsp != nil {
		messagesCopy := make(Messages)
		messagesCopy[targetRoom] = make([]Message, len(cs.messages[targetRoom]))
		copy(messagesCopy[targetRoom], cs.messages[targetRoom])
		response := map[string]interface{}{
			"messages": messagesCopy,
		}
		cs.emitNamespaceSigned(cs.defaultNsp, EventServerMessage, response)
		log.Printf("[sendJoinMessage] ✓ Broadcasted join message for %s", userID)
	}
}

func (cs *ChatServer) getUserLists() ([]string, []string) {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	loggedInUsers := make([]string, 0)
	loggedInSet := make(map[string]bool)

	for user, sessionID := range cs.users {
		if user != "" && user != "undefined" && sessionID != "" {
			loggedInUsers = append(loggedInUsers, user)
			loggedInSet[user] = true
		}
	}

	activeButNotLoggedIn := make([]string, 0)
	for user := range cs.userPubKeys {
		if user != "" && user != "undefined" && !loggedInSet[user] {
			activeButNotLoggedIn = append(activeButNotLoggedIn, user)
		}
	}

	sort.Slice(loggedInUsers, func(i, j int) bool {
		return strings.ToLower(loggedInUsers[i]) < strings.ToLower(loggedInUsers[j])
	})
	sort.Slice(activeButNotLoggedIn, func(i, j int) bool {
		return strings.ToLower(activeButNotLoggedIn[i]) < strings.ToLower(activeButNotLoggedIn[j])
	})

	return loggedInUsers, activeButNotLoggedIn
}

func (cs *ChatServer) alphabeticalSort(rooms []string) []string {
	sorted := make([]string, len(rooms))
	copy(sorted, rooms)
	sort.Slice(sorted, func(i, j int) bool {
		return strings.ToLower(sorted[i]) < strings.ToLower(sorted[j])
	})
	return sorted
}
