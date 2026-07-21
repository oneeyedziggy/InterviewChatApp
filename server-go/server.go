package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	socketio "github.com/karagenc/socket.io-go"
)

type ChatServer struct {
	sessionCache    *Cache
	userCache       *Cache
	messages        Messages
	rooms           []string
	users           map[string]string
	userPubKeys     map[string]string
	serverKeyRing   *crypto.KeyRing
	serverPublicKey string
	mu              sync.RWMutex
	store           *FileStore
	joinRequests    map[string]*JoinRequest
	userLastSeen    map[string]int64
	roomMembers     map[string]map[string]bool
	roomCreators    map[string]string
	hasSentJoinMsg  map[string]bool
	joinScheduled   map[string]bool
	defaultNsp      *socketio.Namespace
}

func NewChatServer() *ChatServer {
	storePath := "chat-state.json"
	absPath, err := filepath.Abs(storePath)
	if err != nil {
		log.Printf("[NewChatServer] ✗ Failed to get absolute path, using relative: %v", err)
		absPath = storePath
	}

	log.Printf("[NewChatServer] Using state file: %s", absPath)
	store := NewFileStore(absPath)

	messages, rooms, users, userPubKeys, err := store.Load()
	if err != nil {
		log.Printf("[NewChatServer] ✗ Failed to load state: %v, starting with empty state", err)
		messages = make(Messages)
		rooms = []string{DefaultRoom, "#cats"}
		users = make(map[string]string)
		userPubKeys = make(map[string]string)
		messages[DefaultRoom] = []Message{}
		messages["#cats"] = []Message{}
	}

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

	serverKeyRing, serverPublicKey, err := generateOrLoadServerKeys()
	if err != nil {
		log.Fatalf("[NewChatServer] ✗ Failed to generate/load server GPG keys: %v", err)
	}

	joinRequests := make(map[string]*JoinRequest)
	userLastSeen := make(map[string]int64)
	roomMembers := make(map[string]map[string]bool)
	roomCreators := make(map[string]string)

	for _, room := range rooms {
		roomMembers[room] = make(map[string]bool)
	}

	cs := &ChatServer{
		sessionCache:    NewCache(SessionTTL),
		userCache:       NewCache(0),
		messages:        messages,
		rooms:           rooms,
		users:           users,
		userPubKeys:     userPubKeys,
		serverKeyRing:   serverKeyRing,
		serverPublicKey: serverPublicKey,
		store:           store,
		joinRequests:    joinRequests,
		userLastSeen:    userLastSeen,
		roomMembers:     roomMembers,
		roomCreators:    roomCreators,
		hasSentJoinMsg:  make(map[string]bool),
		joinScheduled:   make(map[string]bool),
	}

	// Populate hasSentJoinMsg for users who already have a system "joined"
	// message in the default room. This prevents the server from re-posting
	// a join message on restart for users who had already joined previously.
	if msgs, ok := messages[DefaultRoom]; ok {
		for _, m := range msgs {
			if m.Username == "system" && strings.HasSuffix(m.Content, UserJoined) {
				uname := strings.TrimSuffix(m.Content, " "+UserJoined)
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

func generateOrLoadServerKeys() (*crypto.KeyRing, string, error) {
	keyPath := "server-gpg-key.asc"
	privateKeyPath := "server-gpg-private-key.asc"

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

func (cs *ChatServer) setUser(name, sessionID string) {
	log.Printf("[setUser] ===== ENTERING setUser ======")
	log.Printf("[setUser] Attempting to acquire lock for user: %s", name)
	cs.mu.Lock()
	log.Printf("[setUser] ✓ Lock acquired")
	oldSessionID, wasLoggedIn := cs.users[name]
	cs.users[name] = sessionID
	if !wasLoggedIn || oldSessionID != sessionID {
		needsJoinMsg := !cs.hasSentJoinMsg[name]
		if needsJoinMsg {
			// Schedule the join message and mark it as pending to avoid races
			// where a concurrently-handled client message sees the flag as
			// false and mis-orders that first message. The actual join
			// message will be sent asynchronously; `sendJoinMessage` will set
			// `hasSentJoinMsg` when it completes.
			cs.joinScheduled[name] = true
			log.Printf("[setUser] ✓ Scheduled join message for user %s (was logged in: %v)", name, wasLoggedIn)
			cs.mu.Unlock()
			go cs.sendJoinMessage(name)
			cs.mu.Lock()
		} else {
			log.Printf("[setUser] ⚠ Join message already sent for %s (shouldn't happen on new login)", name)
		}
	}
	log.Printf("[setUser] ✓ User set in map")
	shouldBroadcast := !wasLoggedIn || oldSessionID != sessionID
	cs.mu.Unlock()
	log.Printf("[setUser] ✓ Lock released")
	if shouldBroadcast {
		cs.broadcastUserListUpdate()
	}
	log.Printf("[setUser] ===== EXITING setUser ======")
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
	nsp.Emit(EventServerUserListUpdate, userListData)
	log.Printf("[broadcastUserListUpdate] ✓ Broadcasted user list (%d logged in, %d active)", len(loggedInUsers), len(activeUsers))
}

func (cs *ChatServer) registerUserFromAuth(username, socketID string) {
	if username == "" || socketID == "" {
		return
	}

	cs.mu.Lock()
	existingSessionID, userExists := cs.users[username]
	cs.mu.Unlock()

	if !userExists || existingSessionID != socketID {
		log.Printf("[registerUserFromAuth] Registering %s on connect (socket %s)", username, socketID)
		cs.setUser(username, socketID)
		cs.mu.Lock()
		cs.userLastSeen[username] = time.Now().Unix()
		cs.mu.Unlock()
	}
}

func (cs *ChatServer) sendJoinMessage(username string) {
	if username == "" {
		return
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	// If the join message has already been sent, nothing to do.
	if cs.hasSentJoinMsg[username] {
		// Clean up any scheduled marker if present.
		delete(cs.joinScheduled, username)
		return
	}

	if cs.messages[DefaultRoom] == nil {
		cs.messages[DefaultRoom] = []Message{}
	}
	if cs.roomMembers[DefaultRoom] == nil {
		cs.roomMembers[DefaultRoom] = make(map[string]bool)
	}
	if !cs.roomMembers[DefaultRoom][username] {
		cs.roomMembers[DefaultRoom][username] = true
		if len(cs.roomMembers[DefaultRoom]) == 1 {
			cs.roomCreators[DefaultRoom] = username
			log.Printf("[sendJoinMessage] Set %s as creator of %s", username, DefaultRoom)
		}
	}

	joinMsg := Message{
		Timestamp: time.Now().Unix(),
		Username:  "system",
		Content:   fmt.Sprintf("%s %s", username, UserJoined),
		Edited:    false,
	}
	cs.messages[DefaultRoom] = append([]Message{joinMsg}, cs.messages[DefaultRoom]...)
	cs.hasSentJoinMsg[username] = true
	// Clear scheduled marker now that the join message has been sent.
	delete(cs.joinScheduled, username)
	log.Printf("[sendJoinMessage] ✓ Sent join message for %s to %s", username, DefaultRoom)

	if cs.defaultNsp != nil {
		messagesCopy := make(Messages)
		messagesCopy[DefaultRoom] = make([]Message, len(cs.messages[DefaultRoom]))
		copy(messagesCopy[DefaultRoom], cs.messages[DefaultRoom])
		response := map[string]interface{}{
			"messages": messagesCopy,
		}
		cs.defaultNsp.Emit(EventServerMessage, response)
		log.Printf("[sendJoinMessage] ✓ Broadcasted join message for %s", username)
	}
}

func (cs *ChatServer) getUserList() []string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	var users []string
	for user := range cs.users {
		if user != "" && user != "undefined" {
			users = append(users, user)
		}
	}
	sort.Slice(users, func(i, j int) bool {
		return strings.ToLower(users[i]) < strings.ToLower(users[j])
	})
	return users
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
