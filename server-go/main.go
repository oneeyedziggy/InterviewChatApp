package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	socketio "github.com/karagenc/socket.io-go"
	"golang.org/x/crypto/scrypt"
)

const (
	DefaultPort       = "3001"
	MinUsernameLength = 8
	MinPasswordLength = 8
	DefaultRoom       = "#general"
	SessionTTL        = 4 * time.Hour
)

// Custom ResponseWriter to intercept and override Content-Type
type mimeOverrideWriter struct {
	http.ResponseWriter
	contentType string
}

func (m *mimeOverrideWriter) WriteHeader(code int) {
	if m.contentType != "" {
		m.Header().Set("Content-Type", m.contentType)
	}
	m.Header().Del("X-Content-Type-Options")
	m.ResponseWriter.WriteHeader(code)
}

// ResponseWriter to log status codes
type responseLogWriter struct {
	http.ResponseWriter
	statusCode int
}

func (r *responseLogWriter) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

// Helper function to check if a slice contains a string
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// Socket events
const (
	EventClientMessage        = "clientMessage"
	EventClientNewRoom        = "clientNewRoom"
	EventClientDisconnecting  = "clientDisconnecting"
	EventClientRequestAccess  = "clientRequestAccess"
	EventClientGrantAccess    = "clientGrantAccess"
	EventClientDenyAccess     = "clientDenyAccess"
	EventClientLeaveRoom      = "clientLeaveRoom"
	EventClientRejoinRoom     = "clientRejoinRoom"
	EventClientVoteJoin       = "clientVoteJoin"
	EventClientVoteMessage     = "clientVoteMessage"
	EventClientEditMessage     = "clientEditMessage"
	EventServerMessage        = "serverMessage"
	EventServerVoteUpdate     = "serverVoteUpdate"
	EventServerNewRoom        = "serverNewRoom"
	EventServerUserListUpdate = "serverUserListUpdate"
	EventServerAccessRequest  = "serverAccessRequest"
	EventServerAccessDenied   = "serverAccessDenied"
	EventServerJoinRequest    = "serverJoinRequest"
	EventServerJoinApproved   = "serverJoinApproved"
	EventServerJoinDenied     = "serverJoinDenied"
	EventInitialData          = "initialData"
	EventStatus               = "status"
	EventDisconnect           = "disconnect"
)

// System messages
const (
	UserJoined = "<-- has entered the room"
	UserLeft   = "says \"smell ya' later\" -->"
)

type MessageVersion struct {
	EncryptedFor  map[string]string `json:"encryptedFor"`
	Version       int               `json:"version"`
	ChangeSummary string            `json:"changeSummary,omitempty"`
	Timestamp     int64             `json:"timestamp"`
}

type Message struct {
	Timestamp     int64              `json:"timestamp"`
	Username      string             `json:"username"`
	Content       string             `json:"content"`      // Plaintext (for backward compatibility)
	EncryptedFor  map[string]string  `json:"encryptedFor"` // Map of username -> encrypted message (for backward compatibility)
	Versions      []MessageVersion   `json:"versions,omitempty"` // Array of message versions, newest first
	CurrentVersion *int              `json:"currentVersion,omitempty"` // Index of current version in versions array
	VisibleTo     []string           `json:"visibleTo,omitempty"` // List of usernames who should see this message (empty = all)
	ReplyTo       *int64             `json:"replyTo,omitempty"` // Timestamp of the message this is replying to
	VoteTotal     *int              `json:"voteTotal,omitempty"` // Total vote count (upvotes - downvotes)
	UserVotes     map[string]string `json:"userVotes,omitempty"` // Map of username -> "up" or "down"
	Edited        bool              `json:"edited,omitempty"` // Whether the message has been edited
}

type Messages map[string][]Message

type JoinRequest struct {
	RequestingUser string
	Room           string
	Votes          map[string]bool // username -> vote (true = accept, false = deny)
	Timestamp      int64
}

type LoginRequest struct {
	Username      string `json:"username"`
	Password      string `json:"password,omitempty"`      // Deprecated, kept for backward compatibility
	PublicKey     string `json:"publicKey,omitempty"`     // For first-time registration
	EncryptedUUID string `json:"encryptedUUID,omitempty"` // For challenge-response
}

type LoginResponse struct {
	SessionID       string `json:"sessionId,omitempty"`
	Error           string `json:"error,omitempty"`
	Challenge       string `json:"challenge,omitempty"`       // Encrypted UUID for challenge-response
	ServerPublicKey string `json:"serverPublicKey,omitempty"` // Server's public key
}

type CacheEntry struct {
	Value     string
	ExpiresAt time.Time
}

type Cache struct {
	mu    sync.RWMutex
	items map[string]*CacheEntry
	ttl   time.Duration
}

func NewCache(ttl time.Duration) *Cache {
	c := &Cache{
		items: make(map[string]*CacheEntry),
		ttl:   ttl,
	}
	go c.cleanup()
	return c
}

func (c *Cache) Set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = &CacheEntry{
		Value:     value,
		ExpiresAt: time.Now().Add(c.ttl),
	}
}

func (c *Cache) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, exists := c.items[key]
	if !exists {
		return "", false
	}
	if time.Now().After(entry.ExpiresAt) {
		return "", false
	}
	return entry.Value, true
}

func (c *Cache) Has(key string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, exists := c.items[key]
	if !exists {
		return false
	}
	return time.Now().Before(entry.ExpiresAt)
}

func (c *Cache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, key)
}

func (c *Cache) cleanup() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for key, entry := range c.items {
			if now.After(entry.ExpiresAt) {
				delete(c.items, key)
			}
		}
		c.mu.Unlock()
	}
}

// PersistedState represents the data that will be saved to disk
type PersistedState struct {
	Messages    Messages          `json:"messages"`
	Rooms       []string          `json:"rooms"`
	Users       map[string]string `json:"users"`
	UserPubKeys map[string]string `json:"userPubKeys"` // username -> GPG public key
}

// FileStore handles persistence to disk
type FileStore struct {
	filepath string
	mu       sync.Mutex
}

// NewFileStore creates a new file store
func NewFileStore(filepath string) *FileStore {
	return &FileStore{
		filepath: filepath,
	}
}

// Save persists the current state to disk
func (fs *FileStore) Save(messages Messages, rooms []string, users map[string]string, userPubKeys map[string]string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	state := PersistedState{
		Messages:    messages,
		Rooms:       rooms,
		Users:       users,
		UserPubKeys: userPubKeys,
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	// Ensure the directory exists
	dir := filepath.Dir(fs.filepath)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}

	// Write to temporary file first, then rename (atomic operation)
	tmpPath := fs.filepath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}

	if err := os.Rename(tmpPath, fs.filepath); err != nil {
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	log.Printf("[FileStore] ✓ State saved to %s", fs.filepath)
	return nil
}

// Load reads the persisted state from disk
func (fs *FileStore) Load() (Messages, []string, map[string]string, map[string]string, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	data, err := os.ReadFile(fs.filepath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist yet, return empty state
			log.Printf("[FileStore] State file %s does not exist, starting with empty state", fs.filepath)
			return make(Messages), []string{DefaultRoom, "#cats"}, make(map[string]string), make(map[string]string), nil
		}
		return nil, nil, nil, nil, fmt.Errorf("failed to read state file: %w", err)
	}

	var state PersistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}

	// Ensure default rooms exist
	if len(state.Rooms) == 0 {
		state.Rooms = []string{DefaultRoom, "#cats"}
	}
	if state.Messages == nil {
		state.Messages = make(Messages)
	}
	if state.Users == nil {
		state.Users = make(map[string]string)
	}
	if state.UserPubKeys == nil {
		state.UserPubKeys = make(map[string]string)
	}

	// Ensure default rooms have empty message arrays if they don't exist
	if state.Messages[DefaultRoom] == nil {
		state.Messages[DefaultRoom] = []Message{}
	}
	if state.Messages["#cats"] == nil {
		state.Messages["#cats"] = []Message{}
	}

	log.Printf("[FileStore] ✓ State loaded from %s - rooms: %d, users: %d, message rooms: %d, pub keys: %d",
		fs.filepath, len(state.Rooms), len(state.Users), len(state.Messages), len(state.UserPubKeys))

	return state.Messages, state.Rooms, state.Users, state.UserPubKeys, nil
}

type ChatServer struct {
	sessionCache    *Cache
	userCache       *Cache
	messages        Messages
	rooms           []string
	users           map[string]string
	userPubKeys     map[string]string // username -> GPG public key
	serverKeyRing   *crypto.KeyRing   // Server's private key ring
	serverPublicKey string            // Server's public key (armored)
	mu              sync.RWMutex
	store           *FileStore
	joinRequests    map[string]*JoinRequest    // room:requestingUser -> JoinRequest
	userLastSeen    map[string]int64           // username -> last seen timestamp
	roomMembers     map[string]map[string]bool // room -> username -> bool (membership)
	roomCreators    map[string]string          // room -> username (creator)
}

func NewChatServer() *ChatServer {
	// Initialize file store - use absolute path to avoid directory issues
	storePath := "chat-state.json"

	// Convert to absolute path to avoid issues with working directory
	absPath, err := filepath.Abs(storePath)
	if err != nil {
		log.Printf("[NewChatServer] ✗ Failed to get absolute path, using relative: %v", err)
		absPath = storePath
	}

	log.Printf("[NewChatServer] Using state file: %s", absPath)
	store := NewFileStore(absPath)

	// Load persisted state
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

	// Purge all existing messages on server start
	log.Printf("[NewChatServer] Purging all existing messages...")
	messages = make(Messages)
	for _, room := range rooms {
		messages[room] = []Message{}
	}
	log.Printf("[NewChatServer] ✓ All messages purged")

	// Generate or load server GPG key pair
	serverKeyRing, serverPublicKey, err := generateOrLoadServerKeys()
	if err != nil {
		log.Fatalf("[NewChatServer] ✗ Failed to generate/load server GPG keys: %v", err)
	}

	// Clear user list on server start (users need to reconnect)
	users = make(map[string]string)

	// Initialize join request tracking and user activity
	joinRequests := make(map[string]*JoinRequest)
	userLastSeen := make(map[string]int64)
	roomMembers := make(map[string]map[string]bool)
	roomCreators := make(map[string]string)

	// Initialize room members for existing rooms
	for _, room := range rooms {
		roomMembers[room] = make(map[string]bool)
	}

	cs := &ChatServer{
		sessionCache:    NewCache(SessionTTL),
		userCache:       NewCache(0), // No expiration
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
	}

	log.Printf("[NewChatServer] ✓ Chat server initialized with %d rooms, %d users (cleared), %d message rooms, %d pub keys",
		len(cs.rooms), len(cs.users), len(cs.messages), len(cs.userPubKeys))

	return cs
}

// generateOrLoadServerKeys generates a new GPG key pair or loads existing one
func generateOrLoadServerKeys() (*crypto.KeyRing, string, error) {
	keyPath := "server-gpg-key.asc"
	privateKeyPath := "server-gpg-private-key.asc"

	// Try to load existing keys
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

		// Unlock the key (even with empty passphrase, the key might be locked)
		unlockedKey, err := privateKey.Unlock([]byte(""))
		if err != nil {
			return nil, "", fmt.Errorf("failed to unlock key: %w", err)
		}

		keyRing, err := crypto.NewKeyRing(unlockedKey)
		if err != nil {
			return nil, "", fmt.Errorf("failed to create key ring: %w", err)
		}

		log.Printf("[GPG] ✓ Loaded existing server keys")
		return keyRing, string(publicKeyData), nil
	}

	// Generate new keys
	log.Printf("[GPG] Generating new server GPG key pair...")
	rsaKey, err := helper.GenerateKey("Chat Server", "server@chat.local", []byte(""), "rsa", 2048)
	if err != nil {
		return nil, "", fmt.Errorf("failed to generate key: %w", err)
	}

	privateKey, err := crypto.NewKeyFromArmored(rsaKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to parse generated key: %w", err)
	}

	// Unlock the key (even with empty passphrase, the key might be locked)
	unlockedKey, err := privateKey.Unlock([]byte(""))
	if err != nil {
		return nil, "", fmt.Errorf("failed to unlock key: %w", err)
	}

	keyRing, err := crypto.NewKeyRing(unlockedKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create key ring: %w", err)
	}

	// Extract public key from private key - GetPublicKey returns []byte
	publicKeyBytes, err := unlockedKey.GetPublicKey()
	if err != nil {
		return nil, "", fmt.Errorf("failed to get public key: %w", err)
	}

	// Create a Key object from the public key bytes
	publicKeyObj, err := crypto.NewKey(publicKeyBytes)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create public key object: %w", err)
	}

	publicKeyArmored, err := publicKeyObj.Armor()
	if err != nil {
		return nil, "", fmt.Errorf("failed to armor public key: %w", err)
	}

	// Save keys to disk
	if err := os.WriteFile(keyPath, []byte(publicKeyArmored), 0644); err != nil {
		log.Printf("[GPG] ⚠ Failed to save public key: %v", err)
	}

	// The full armored key contains both private and public
	privateKeyArmored := rsaKey

	if err := os.WriteFile(privateKeyPath, []byte(privateKeyArmored), 0600); err != nil {
		log.Printf("[GPG] ⚠ Failed to save private key: %v", err)
	}

	log.Printf("[GPG] ✓ Generated and saved new server GPG key pair")
	return keyRing, publicKeyArmored, nil
}

func (cs *ChatServer) setUser(name, sessionID string) {
	log.Printf("[setUser] ===== ENTERING setUser ======")
	log.Printf("[setUser] Attempting to acquire lock for user: %s, session: %s", name, sessionID)
	cs.mu.Lock()
	log.Printf("[setUser] ✓ Lock acquired")
	cs.users[name] = sessionID
	log.Printf("[setUser] ✓ User set in map")
	cs.mu.Unlock()
	log.Printf("[setUser] ✓ Lock released")
	log.Printf("[setUser] ===== EXITING setUser ======")
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

// getUserLists returns logged-in users and active but not logged-in users
func (cs *ChatServer) getUserLists() ([]string, []string) {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	
	loggedInUsers := make([]string, 0)
	loggedInSet := make(map[string]bool)
	
	// Get logged-in users (users with active sessions)
	for user, sessionID := range cs.users {
		if user != "" && user != "undefined" && sessionID != "" {
			loggedInUsers = append(loggedInUsers, user)
			loggedInSet[user] = true
		}
	}
	
	// Get active but not logged-in users (users with public keys but no active session)
	activeButNotLoggedIn := make([]string, 0)
	for user := range cs.userPubKeys {
		if user != "" && user != "undefined" && !loggedInSet[user] {
			activeButNotLoggedIn = append(activeButNotLoggedIn, user)
		}
	}
	
	// Sort both lists
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

func generateSalt() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func hashPassword(password, salt string) (string, error) {
	// Use faster scrypt parameters for development (lower CPU/memory cost)
	// In production, use higher values: 65536, 8, 1, 32
	dk, err := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(dk), nil
}

func constantTimeCompare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	result := 0
	for i := 0; i < len(a); i++ {
		result |= int(a[i]) ^ int(b[i])
	}
	return result == 0
}

// handleLogin is now in gpg_auth.go

// Helper function to send a message to specific users by their usernames
func (cs *ChatServer) sendToUsers(defaultNsp *socketio.Namespace, usernames []string, event string, data interface{}) {
	if defaultNsp == nil {
		log.Printf("[sendToUsers] ✗ defaultNsp is nil, cannot send event %s", event)
		return
	}
	
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	
	log.Printf("[sendToUsers] Attempting to send %s to users: %v", event, usernames)
	log.Printf("[sendToUsers] Current users map: %v", func() map[string]string {
		usersCopy := make(map[string]string)
		for k, v := range cs.users {
			usersCopy[k] = v
		}
		return usersCopy
	}())
	
	for _, username := range usernames {
		if socketID, exists := cs.users[username]; exists {
			// Send to specific socket by ID - use socketID as a room name
			// In socketio-go, we can use the socket ID as a room identifier
			log.Printf("[sendToUsers] Sending %s to user %s (socketID: %s)", event, username, socketID)
			// Try using the socket ID as a room - socketio-go may support this
			defaultNsp.To(socketio.Room(socketID)).Emit(event, data)
			log.Printf("[sendToUsers] ✓ Sent %s to user %s (socketID: %s)", event, username, socketID)
		} else {
			log.Printf("[sendToUsers] ✗ User %s not found in active users (available: %v)", username, func() []string {
				users := make([]string, 0, len(cs.users))
				for u := range cs.users {
					users = append(users, u)
				}
				return users
			}())
		}
	}
}

// Helper function to filter messages by visibility
func filterMessagesByVisibility(messages []Message, username string) []Message {
	filtered := []Message{}
	for _, msg := range messages {
		// If VisibleTo is empty or nil, message is visible to all
		if len(msg.VisibleTo) == 0 {
			filtered = append(filtered, msg)
		} else {
			// Check if user is in VisibleTo list
			for _, visibleUser := range msg.VisibleTo {
				if visibleUser == username {
					filtered = append(filtered, msg)
					break
				}
			}
		}
	}
	return filtered
}

func (cs *ChatServer) setupSocketHandlers(sio *socketio.Server) {
	log.Println("===== SETTING UP SOCKET HANDLERS =====")

	// Get the default namespace
	defaultNsp := sio.Of("/")

	// Register event handlers - these are called when events are received
	defaultNsp.OnEvent(EventClientMessage, func(socket socketio.ServerSocket, msg interface{}) {
		socketIDStr := string(socket.ID())
		log.Printf("[%s] ===== CLIENT_MESSAGE EVENT ======", socketIDStr)
		log.Printf("[%s] Received message data: %+v", socketIDStr, msg)

		msgMap, ok := msg.(map[string]interface{})
		if !ok {
			log.Printf("[%s] ✗ Invalid message format received, type: %T", socketIDStr, msg)
			return
		}

		room, _ := msgMap["room"].(string)
		username, _ := msgMap["username"].(string)
		content, _ := msgMap["content"].(string) // May be empty for encrypted-only messages
		replyToRaw, hasReplyTo := msgMap["replyTo"]
		encryptedForRaw, hasEncrypted := msgMap["encryptedFor"]
		var encryptedFor map[string]string
		if hasEncrypted {
			if efMap, ok := encryptedForRaw.(map[string]interface{}); ok {
				encryptedFor = make(map[string]string)
				for k, v := range efMap {
					if str, ok := v.(string); ok {
						encryptedFor[k] = str
					}
				}
			}
		}
		
		// Parse replyTo if present
		var replyTo *int64
		if hasReplyTo {
			log.Printf("[%s] replyTo field present, raw value: %v, type: %T", socketIDStr, replyToRaw, replyToRaw)
			if replyToFloat, ok := replyToRaw.(float64); ok {
				replyToInt := int64(replyToFloat)
				replyTo = &replyToInt
				log.Printf("[%s] ✓ Message is a reply to timestamp: %d", socketIDStr, replyToInt)
			} else {
				log.Printf("[%s] ✗ Failed to parse replyTo: expected float64, got %T with value %v", socketIDStr, replyToRaw, replyToRaw)
			}
		} else {
			log.Printf("[%s] No replyTo field in message", socketIDStr)
		}

		// For encrypted messages, content may be empty - that's expected
		if hasEncrypted && len(encryptedFor) > 0 {
			log.Printf("[%s] ✓ Parsed encrypted message - User: %s, Room: %s, EncryptedFor: %d users", socketIDStr, username, room, len(encryptedFor))
		} else {
			log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s", socketIDStr, username, room, content)
		}

		// Set user when they send a message (similar to original server behavior)
		userJustRegistered := false
		if username != "" {
			cs.mu.Lock()
			existingSessionID, userExists := cs.users[username]
			cs.mu.Unlock()
			log.Printf("[%s] Checking user registration - exists: %v, existing ID: %s, current ID: %s", socketIDStr, userExists, existingSessionID, socketIDStr)
			if !userExists || existingSessionID != socketIDStr {
				cs.setUser(username, socketIDStr)
				userJustRegistered = true
				log.Printf("[%s] ✓ User %s registered with connection ID %s", socketIDStr, username, socketIDStr)
			} else {
				log.Printf("[%s] User %s already registered", socketIDStr, username)
			}
		} else {
			log.Printf("[%s] ✗ No username in message", socketIDStr)
		}

		cs.mu.Lock()
		if cs.messages[room] == nil {
			log.Printf("[%s] Creating new room: %s", socketIDStr, room)
			cs.messages[room] = []Message{}
		}
		beforeCount := len(cs.messages[room])
		// Auto-upvote own message
		one := 1
		userVotes := make(map[string]string)
		userVotes[username] = "up"
		cs.messages[room] = append([]Message{{
			Timestamp:    time.Now().Unix(),
			Username:     username,
			Content:      content,
			EncryptedFor: encryptedFor,
			ReplyTo:      replyTo,
			VoteTotal:    &one,
			UserVotes:    userVotes,
		}}, cs.messages[room]...)
		log.Printf("[%s] Added message to room %s (was %d, now has %d messages)", socketIDStr, room, beforeCount, len(cs.messages[room]))

		// Save state to disk
		messagesCopyForSave := make(Messages)
		for k, v := range cs.messages {
			messagesCopyForSave[k] = make([]Message, len(v))
			copy(messagesCopyForSave[k], v)
		}
		roomsCopyForSave := make([]string, len(cs.rooms))
		copy(roomsCopyForSave, cs.rooms)
		usersCopyForSave := make(map[string]string)
		for k, v := range cs.users {
			usersCopyForSave[k] = v
		}
		cs.mu.Unlock()

		// Save to disk (outside of lock to avoid blocking)
		go func() {
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}
		}()

		cs.mu.Lock() // Re-acquire lock for response preparation

		// Get current state for response - do this while holding the lock to avoid deadlock
		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		roomsCopy := make([]string, len(cs.rooms))
		copy(roomsCopy, cs.rooms)

		// Get user list inline to avoid deadlock (getUserList() tries to acquire RLock)
		var usersList []string
		for user := range cs.users {
			if user != "" && user != "undefined" {
				usersList = append(usersList, user)
			}
		}
		sort.Slice(usersList, func(i, j int) bool {
			return strings.ToLower(usersList[i]) < strings.ToLower(usersList[j])
		})
		cs.mu.Unlock()

		log.Printf("[%s] Prepared response - rooms: %d, users: %d, message rooms: %d", socketIDStr, len(roomsCopy), len(usersList), len(messagesCopy))

		// Get user public keys for INITIAL_DATA
		cs.mu.RLock()
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}
		cs.mu.RUnlock()

		// If this is the user's first message (just registered), send initial data
		// This ensures they get rooms, users, and messages even if they missed the initial emit
		if userJustRegistered {
			// Get logged-in and active user lists
			loggedInUsers, activeUsers := cs.getUserLists()
			
			initialData := map[string]interface{}{
				"messages":       messagesCopy,
				"rooms":          roomsCopy,
				"users":          usersList, // Keep for backward compatibility
				"loggedInUsers":  loggedInUsers,
				"activeUsers":    activeUsers,
				"userPubKeys":    userPubKeysCopy,
			}
			log.Printf("[%s] ✓ User just registered, sending INITIAL_DATA to %s", socketIDStr, username)
			dataJSON, _ := json.Marshal(initialData)
			log.Printf("[%s] INITIAL_DATA payload: %s", socketIDStr, string(dataJSON))
			socket.Emit(EventInitialData, initialData)
			log.Printf("[%s] ✓ INITIAL_DATA sent to newly registered user", socketIDStr)
		}

		// Prepare response with updated messages and users
		response := map[string]interface{}{
			"messages": messagesCopy,
			"users":    usersList,
		}

		log.Printf("[%s] Broadcasting SERVER_MESSAGE - rooms: %d, users: %d", socketIDStr, len(messagesCopy), len(usersList))

		// Broadcast to all clients (excluding sender)
		defaultNsp.Emit(EventServerMessage, response)
		log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)

		// Also emit directly to sender so they see their own messages
		socket.Emit(EventServerMessage, response)
		log.Printf("[%s] ✓ Emitted to sender, CLIENT_MESSAGE handler complete", socketIDStr)
	})

	defaultNsp.OnEvent(EventClientNewRoom, func(socket socketio.ServerSocket, roomName interface{}) {
		socketIDStr := string(socket.ID())
		log.Printf("[%s] ===== CLIENT_NEW_ROOM EVENT ======", socketIDStr)
		log.Printf("[%s] Received room name: %+v (type: %T)", socketIDStr, roomName, roomName)

		roomNameStr, ok := roomName.(string)
		if !ok {
			log.Printf("[%s] ✗ Invalid room name format", socketIDStr)
			return
		}
		formattedRoom := "#" + roomNameStr
		log.Printf("[%s] Formatted room name: %s", socketIDStr, formattedRoom)
		cs.mu.Lock()
		roomExists := false
		for _, r := range cs.rooms {
			if r == formattedRoom {
				roomExists = true
				break
			}
		}
		log.Printf("[%s] Room exists: %v, current rooms: %v", socketIDStr, roomExists, cs.rooms)
		if !roomExists {
			cs.rooms = append(cs.rooms, formattedRoom)
			cs.messages[formattedRoom] = []Message{}
			log.Printf("[%s] ✓ Created new room: %s", socketIDStr, formattedRoom)
		} else {
			log.Printf("[%s] Room %s already exists", socketIDStr, formattedRoom)
		}
		sortedRooms := cs.alphabeticalSort(cs.rooms)

		// Prepare data for saving
		messagesCopyForSave := make(Messages)
		for k, v := range cs.messages {
			messagesCopyForSave[k] = make([]Message, len(v))
			copy(messagesCopyForSave[k], v)
		}
		roomsCopyForSave := make([]string, len(cs.rooms))
		copy(roomsCopyForSave, cs.rooms)
		usersCopyForSave := make(map[string]string)
		for k, v := range cs.users {
			usersCopyForSave[k] = v
		}
		cs.mu.Unlock()

		// Save to disk (outside of lock to avoid blocking)
		go func() {
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}
		}()

		// Prepare response
		response := map[string]interface{}{
			"messages": cs.messages,
			"rooms":    sortedRooms,
		}

		log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))

		// Broadcast to all clients (excluding sender)
		defaultNsp.Emit(EventServerNewRoom, response)
		log.Printf("[%s] ✓ Broadcasted SERVER_NEW_ROOM", socketIDStr)

		// Also emit directly to sender
		socket.Emit(EventServerNewRoom, response)
		log.Printf("[%s] ✓ Emitted SERVER_NEW_ROOM to sender", socketIDStr)
	})

	defaultNsp.OnEvent(EventClientDisconnecting, func(socket socketio.ServerSocket, sessionID interface{}) {
		socketIDStr := string(socket.ID())
		sessionIDStr, ok := sessionID.(string)
		if !ok {
			return
		}
		cs.mu.Lock()
		for user, sid := range cs.users {
			if sid == sessionIDStr {
				delete(cs.users, user)
				break
			}
		}

		// Prepare data for saving
		messagesCopyForSave := make(Messages)
		for k, v := range cs.messages {
			messagesCopyForSave[k] = make([]Message, len(v))
			copy(messagesCopyForSave[k], v)
		}
		roomsCopyForSave := make([]string, len(cs.rooms))
		copy(roomsCopyForSave, cs.rooms)
		usersCopyForSave := make(map[string]string)
		for k, v := range cs.users {
			usersCopyForSave[k] = v
		}
		cs.mu.Unlock()

		// Save to disk (outside of lock to avoid blocking)
		go func() {
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}
		}()

		log.Printf("[%s] client disconnecting", socketIDStr)
	})

	// Register vote message handler
	defaultNsp.OnEvent(EventClientVoteMessage, func(socket socketio.ServerSocket, voteData interface{}) {
		socketIDStr := string(socket.ID())
		log.Printf("[%s] ===== CLIENT_VOTE_MESSAGE EVENT ======", socketIDStr)
		
		voteMap, ok := voteData.(map[string]interface{})
		if !ok {
			log.Printf("[%s] ✗ Invalid vote data format, type: %T", socketIDStr, voteData)
			return
		}

		room, _ := voteMap["room"].(string)
		messageTimestampRaw, hasTimestamp := voteMap["messageTimestamp"]
		username, _ := voteMap["username"].(string)
		voteTypeRaw, hasVoteType := voteMap["voteType"]

		if !hasTimestamp || !hasVoteType || username == "" || room == "" {
			log.Printf("[%s] ✗ Missing required vote fields", socketIDStr)
			return
		}

		var messageTimestamp int64
		if tsFloat, ok := messageTimestampRaw.(float64); ok {
			messageTimestamp = int64(tsFloat)
		} else {
			log.Printf("[%s] ✗ Invalid messageTimestamp format", socketIDStr)
			return
		}

		voteType, ok := voteTypeRaw.(string)
		if !ok || (voteType != "up" && voteType != "down") {
			log.Printf("[%s] ✗ Invalid voteType, must be 'up' or 'down'", socketIDStr)
			return
		}

		cs.mu.Lock()

		// Find the message
		messages, exists := cs.messages[room]
		if !exists {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Room %s not found", socketIDStr, room)
			return
		}

		var targetMessage *Message
		for i := range messages {
			if messages[i].Timestamp == messageTimestamp {
				targetMessage = &messages[i]
				break
			}
		}

		if targetMessage == nil {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Message with timestamp %d not found in room %s", socketIDStr, messageTimestamp, room)
			return
		}

		// Initialize vote fields if needed
		if targetMessage.UserVotes == nil {
			targetMessage.UserVotes = make(map[string]string)
		}
		if targetMessage.VoteTotal == nil {
			zero := 0
			targetMessage.VoteTotal = &zero
		}

		// Get current vote for this user
		currentVote, hasVote := targetMessage.UserVotes[username]

		// Handle vote logic
		if hasVote && currentVote == voteType {
			// User is clicking the same vote again - remove it
			delete(targetMessage.UserVotes, username)
			if currentVote == "up" {
				*targetMessage.VoteTotal--
			} else {
				*targetMessage.VoteTotal++
			}
			log.Printf("[%s] ✓ Removed %s vote from message %d by %s (new total: %d)", socketIDStr, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
		} else if hasVote && currentVote != voteType {
			// User is switching votes - remove old, add new
			if currentVote == "up" {
				*targetMessage.VoteTotal--
			} else {
				*targetMessage.VoteTotal++
			}
			targetMessage.UserVotes[username] = voteType
			if voteType == "up" {
				*targetMessage.VoteTotal++
			} else {
				*targetMessage.VoteTotal--
			}
			log.Printf("[%s] ✓ Switched vote from %s to %s for message %d by %s (new total: %d)", socketIDStr, currentVote, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
		} else {
			// User is voting for the first time
			targetMessage.UserVotes[username] = voteType
			if voteType == "up" {
				*targetMessage.VoteTotal++
			} else {
				*targetMessage.VoteTotal--
			}
			log.Printf("[%s] ✓ Added %s vote to message %d by %s (new total: %d)", socketIDStr, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
		}

		// Copy data for saving and response while holding the lock
		messagesCopyForSave := make(Messages)
		for k, v := range cs.messages {
			messagesCopyForSave[k] = make([]Message, len(v))
			copy(messagesCopyForSave[k], v)
		}
		roomsCopyForSave := make([]string, len(cs.rooms))
		copy(roomsCopyForSave, cs.rooms)
		usersCopyForSave := make(map[string]string)
		for k, v := range cs.users {
			usersCopyForSave[k] = v
		}
		
		// Prepare response with updated messages
		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		usersList := make([]string, 0, len(cs.users))
		for user := range cs.users {
			usersList = append(usersList, user)
		}
		
		// Copy userPubKeys for save
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}
		
		cs.mu.Unlock()

		// Save state in background (outside of lock)
		go func() {
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}
		}()

		response := map[string]interface{}{
			"messages": messagesCopy,
			"users":    usersList,
		}

		// Broadcast to all clients
		defaultNsp.Emit(EventServerVoteUpdate, response)
		log.Printf("[%s] ✓ Broadcasted vote update", socketIDStr)
	})

	// Register edit message handler
	defaultNsp.OnEvent(EventClientEditMessage, func(socket socketio.ServerSocket, editData interface{}) {
		socketIDStr := string(socket.ID())
		log.Printf("[%s] ===== CLIENT_EDIT_MESSAGE EVENT ======", socketIDStr)
		
		editMap, ok := editData.(map[string]interface{})
		if !ok {
			log.Printf("[%s] ✗ Invalid edit data format, type: %T", socketIDStr, editData)
			return
		}

		room, _ := editMap["room"].(string)
		messageTimestampRaw, hasTimestamp := editMap["messageTimestamp"]
		username, _ := editMap["username"].(string)
		encryptedForRaw, hasEncrypted := editMap["encryptedFor"]

		if !hasTimestamp || username == "" || room == "" {
			log.Printf("[%s] ✗ Missing required edit fields", socketIDStr)
			return
		}

		var messageTimestamp int64
		if tsFloat, ok := messageTimestampRaw.(float64); ok {
			messageTimestamp = int64(tsFloat)
		} else {
			log.Printf("[%s] ✗ Invalid messageTimestamp format", socketIDStr)
			return
		}

		var encryptedFor map[string]string
		if hasEncrypted {
			if efMap, ok := encryptedForRaw.(map[string]interface{}); ok {
				encryptedFor = make(map[string]string)
				for k, v := range efMap {
					if str, ok := v.(string); ok {
						encryptedFor[k] = str
					}
				}
			}
		}

		cs.mu.Lock()

		// Find the message
		messages, exists := cs.messages[room]
		if !exists {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Room %s not found", socketIDStr, room)
			return
		}

		var targetMessage *Message
		for i := range messages {
			if messages[i].Timestamp == messageTimestamp {
				targetMessage = &messages[i]
				break
			}
		}

		if targetMessage == nil {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Message with timestamp %d not found in room %s", socketIDStr, messageTimestamp, room)
			return
		}

		// Validate that the editor is the original sender
		if targetMessage.Username != username {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ User %s attempted to edit message by %s (unauthorized)", socketIDStr, username, targetMessage.Username)
			return
		}

		// Update the message
		targetMessage.Content = "" // Clear plaintext (encrypted only)
		targetMessage.EncryptedFor = encryptedFor
		targetMessage.Edited = true

		log.Printf("[%s] ✓ Message %d edited by %s", socketIDStr, messageTimestamp, username)

		// Copy data for saving and response while holding the lock
		messagesCopyForSave := make(Messages)
		for k, v := range cs.messages {
			messagesCopyForSave[k] = make([]Message, len(v))
			copy(messagesCopyForSave[k], v)
		}
		roomsCopyForSave := make([]string, len(cs.rooms))
		copy(roomsCopyForSave, cs.rooms)
		usersCopyForSave := make(map[string]string)
		for k, v := range cs.users {
			usersCopyForSave[k] = v
		}
		
		// Prepare response with updated messages
		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		usersList := make([]string, 0, len(cs.users))
		for user := range cs.users {
			usersList = append(usersList, user)
		}
		
		// Copy userPubKeys for save
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}
		
		cs.mu.Unlock()

		// Save state in background (outside of lock)
		go func() {
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}
		}()

		response := map[string]interface{}{
			"messages": messagesCopy,
			"users":    usersList,
		}

		// Broadcast to all clients
		defaultNsp.Emit(EventServerMessage, response)
		log.Printf("[%s] ✓ Broadcasted message edit update", socketIDStr)
	})

	// Note: Disconnect handlers are registered per-socket in OnConnection

	log.Println("===== SOCKET HANDLERS SETUP COMPLETE =====")
}

func main() {
	log.Println("===== STARTING GO SERVER ======")

	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}
	log.Printf("Using port: %s", port)

	chatServer := NewChatServer()
	log.Println("Chat server initialized")

	// Setup Socket.IO server with CORS support
	log.Println("Creating Socket.IO server...")
	// Create Socket.IO server with default config
	sio := socketio.NewServer(nil)
	log.Println("Socket.IO server created")

	// Get the default namespace
	defaultNsp := sio.Of("/")

	// Register connection handler - this is called when a client connects
	log.Println("Registering OnConnection handler...")
	defaultNsp.OnConnection(func(socket socketio.ServerSocket) {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("✗ PANIC in OnConnection handler: %v", r)
			}
		}()
		socketIDStr := string(socket.ID())
		log.Printf("===== CLIENT CONNECTING ======")
		log.Printf("Socket ID: %s", socketIDStr)

		// Register disconnect handler for this socket
		socket.OnDisconnect(func(reason socketio.Reason) {
			log.Printf("[%s] ===== CLIENT DISCONNECTED ======", socketIDStr)
			log.Printf("[%s] Reason: %s", socketIDStr, string(reason))
			
			// Remove user from active users list (unreserve username)
			chatServer.mu.Lock()
			for username, sessionID := range chatServer.users {
				if sessionID == socketIDStr {
					delete(chatServer.users, username)
					log.Printf("[%s] ✓ Removed user %s from active users (username unreserved)", socketIDStr, username)
					break
				}
			}
			chatServer.mu.Unlock()
			
			// Broadcast updated user list
			if defaultNsp != nil {
				// Get user lists outside of lock to avoid deadlock
				loggedInUsers, activeUsers := chatServer.getUserLists()
				userListData := map[string]interface{}{
					"loggedInUsers": loggedInUsers,
					"activeUsers":   activeUsers,
				}
				defaultNsp.Emit(EventServerUserListUpdate, userListData)
				log.Printf("[%s] ✓ Broadcasted updated user list (%d logged in, %d active)", socketIDStr, len(loggedInUsers), len(activeUsers))
			}
		})

		// Register event handlers PER SOCKET - this is required for the new library
		log.Printf("[%s] Registering per-socket event handlers...", socketIDStr)

		// Register CLIENT_MESSAGE handler
		socket.OnEvent(EventClientMessage, func(msg interface{}) {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_MESSAGE (per-socket) handler: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_MESSAGE EVENT (per-socket) ======", socketIDStr)
			log.Printf("[%s] Received message data: %+v", socketIDStr, msg)

			msgMap, ok := msg.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid message format received, type: %T", socketIDStr, msg)
				return
			}

			room, _ := msgMap["room"].(string)
			username, _ := msgMap["username"].(string)
			content, _ := msgMap["content"].(string)
			replyToRaw, hasReplyTo := msgMap["replyTo"]
			encryptedForRaw, hasEncrypted := msgMap["encryptedFor"]
			var encryptedFor map[string]string
			if hasEncrypted {
				if efMap, ok := encryptedForRaw.(map[string]interface{}); ok {
					encryptedFor = make(map[string]string)
					for k, v := range efMap {
						if str, ok := v.(string); ok {
							encryptedFor[k] = str
						}
					}
				}
			}
			
			// Parse replyTo if present
			var replyTo *int64
			if hasReplyTo {
				log.Printf("[%s] replyTo field present, raw value: %v, type: %T", socketIDStr, replyToRaw, replyToRaw)
				if replyToFloat, ok := replyToRaw.(float64); ok {
					replyToInt := int64(replyToFloat)
					replyTo = &replyToInt
					log.Printf("[%s] ✓ Message is a reply to timestamp: %d", socketIDStr, replyToInt)
				} else {
					log.Printf("[%s] ✗ Failed to parse replyTo: expected float64, got %T with value %v", socketIDStr, replyToRaw, replyToRaw)
				}
			} else {
				log.Printf("[%s] No replyTo field in message", socketIDStr)
			}

			log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s, HasEncrypted: %v, ReplyTo: %v", socketIDStr, username, room, content, hasEncrypted, replyTo)

			// Set user when they send a message
			userJustRegistered := false
			if username != "" {
				chatServer.mu.Lock()
				existingSessionID, userExists := chatServer.users[username]
				chatServer.mu.Unlock()
				log.Printf("[%s] Checking user registration - exists: %v, existing ID: %s, current ID: %s", socketIDStr, userExists, existingSessionID, socketIDStr)
				if !userExists || existingSessionID != socketIDStr {
					chatServer.setUser(username, socketIDStr)
					userJustRegistered = true
					log.Printf("[%s] ✓ User %s registered with connection ID %s", socketIDStr, username, socketIDStr)
				} else {
					log.Printf("[%s] User %s already registered", socketIDStr, username)
				}
			} else {
				log.Printf("[%s] ✗ No username in message", socketIDStr)
			}

			chatServer.mu.Lock()
			if chatServer.messages[room] == nil {
				log.Printf("[%s] Creating new room: %s", socketIDStr, room)
				chatServer.messages[room] = []Message{}
			}

			// Check if this is a join message and handle approval
			isJoinMessage := content == UserJoined
			needsApproval := false
			if isJoinMessage {
				// Always admit everyone to #general
				if room == DefaultRoom {
					log.Printf("[%s] User %s joining %s (always admitted)", socketIDStr, username, room)
					needsApproval = false
				} else {
					// Check if user is already a member
					if chatServer.roomMembers[room] == nil {
						chatServer.roomMembers[room] = make(map[string]bool)
					}

					// Check if user is the creator of this room (first person)
					isCreator := chatServer.roomCreators[room] == username

					// Check if this is the first person in the room (no members yet)
					isFirstPerson := len(chatServer.roomMembers[room]) == 0

					if isFirstPerson {
						// First person becomes the creator
						chatServer.roomCreators[room] = username
						log.Printf("[%s] User %s is the creator/first person in %s (auto-admitted)", socketIDStr, username, room)
						needsApproval = false
					} else if isCreator {
						// Creator is always admitted
						log.Printf("[%s] User %s is the creator of %s (auto-admitted)", socketIDStr, username, room)
						needsApproval = false
					} else if !chatServer.roomMembers[room][username] {
						// User is not a member, need approval
						needsApproval = true
						requestKey := fmt.Sprintf("%s:%s", room, username)
						if _, exists := chatServer.joinRequests[requestKey]; !exists {
							// Create new join request
							chatServer.joinRequests[requestKey] = &JoinRequest{
								RequestingUser: username,
								Room:           room,
								Votes:          make(map[string]bool),
								Timestamp:      time.Now().Unix(),
							}
							log.Printf("[%s] Created join request for %s to join %s", socketIDStr, username, room)
						}
					} else {
						// User is already a member, allow the join message
						log.Printf("[%s] User %s is already a member of %s", socketIDStr, username, room)
					}
				}
			}

			// Update user last seen
			chatServer.userLastSeen[username] = time.Now().Unix()

			beforeCount := len(chatServer.messages[room])

			// If needs approval, post a system message instead of the join message
			if needsApproval {
				// Post system message asking for approval
				approvalMsg := Message{
					Timestamp: time.Now().Unix(),
					Username:  "system",
					Content:   fmt.Sprintf("%s would like to join this room. Accept or Deny?", username),
				}
				chatServer.messages[room] = append([]Message{approvalMsg}, chatServer.messages[room]...)
				log.Printf("[%s] Posted approval request message for %s to join %s", socketIDStr, username, room)

				// Broadcast join request to room members
				requestKey := fmt.Sprintf("%s:%s", room, username)
				if req, exists := chatServer.joinRequests[requestKey]; exists {
					// Get current room members
					var roomMemberList []string
					for member := range chatServer.roomMembers[room] {
						roomMemberList = append(roomMemberList, member)
					}

					joinRequestData := map[string]interface{}{
						"type":           "joinRequest",
						"requestingUser": username,
						"room":           room,
						"timestamp":      req.Timestamp,
						"roomMembers":    roomMemberList,
					}
					defaultNsp.Emit(EventServerJoinRequest, joinRequestData)
					log.Printf("[%s] Broadcasted join request for %s to join %s", socketIDStr, username, room)
				}
			} else {
				// Normal message or already-approved join
				// Auto-upvote own message
				one := 1
				userVotes := make(map[string]string)
				userVotes[username] = "up"
				chatServer.messages[room] = append([]Message{{
					Timestamp:    time.Now().Unix(),
					Username:     username,
					Content:      content,
					EncryptedFor: encryptedFor,
					ReplyTo:      replyTo,
					VoteTotal:    &one,
					UserVotes:    userVotes,
				}}, chatServer.messages[room]...)

				// If this is a join message and user is approved/auto-admitted, add them to room members
				if isJoinMessage {
					if chatServer.roomMembers[room] == nil {
						chatServer.roomMembers[room] = make(map[string]bool)
					}
					chatServer.roomMembers[room][username] = true

					// If this is the first person in the room, make them the creator
					if len(chatServer.roomMembers[room]) == 1 {
						chatServer.roomCreators[room] = username
						log.Printf("[%s] Set %s as creator of %s", socketIDStr, username, room)
					}

					log.Printf("[%s] Added %s as member of %s", socketIDStr, username, room)
				}
			}

			log.Printf("[%s] Added message to room %s (was %d, now has %d messages)", socketIDStr, room, beforeCount, len(chatServer.messages[room]))

			// Save state to disk
			messagesCopyForSave := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopyForSave[k] = make([]Message, len(v))
				copy(messagesCopyForSave[k], v)
			}
			roomsCopyForSave := make([]string, len(chatServer.rooms))
			copy(roomsCopyForSave, chatServer.rooms)
			usersCopyForSave := make(map[string]string)
			for k, v := range chatServer.users {
				usersCopyForSave[k] = v
			}
			chatServer.mu.Unlock()

			// Save to disk (outside of lock to avoid blocking)
			go func() {
				if err := chatServer.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, chatServer.userPubKeys); err != nil {
					log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
				}
			}()

			chatServer.mu.Lock() // Re-acquire lock for response preparation

			// Get current state for response - do this while holding the lock to avoid deadlock
			messagesCopy := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopy[k] = make([]Message, len(v))
				copy(messagesCopy[k], v)
			}
			roomsCopy := make([]string, len(chatServer.rooms))
			copy(roomsCopy, chatServer.rooms)

			// Get user list inline to avoid deadlock (getUserList() tries to acquire RLock)
			var usersList []string
			for user := range chatServer.users {
				if user != "" && user != "undefined" {
					usersList = append(usersList, user)
				}
			}
			sort.Slice(usersList, func(i, j int) bool {
				return strings.ToLower(usersList[i]) < strings.ToLower(usersList[j])
			})
			chatServer.mu.Unlock()

			log.Printf("[%s] Prepared response - rooms: %d, users: %d, message rooms: %d", socketIDStr, len(roomsCopy), len(usersList), len(messagesCopy))

			// Get user public keys for INITIAL_DATA
			chatServer.mu.RLock()
			userPubKeysCopy := make(map[string]string)
			for k, v := range chatServer.userPubKeys {
				userPubKeysCopy[k] = v
			}
			chatServer.mu.RUnlock()

			// If this is the user's first message (just registered), send initial data
			if userJustRegistered {
				// Get logged-in and active user lists
				loggedInUsers, activeUsers := chatServer.getUserLists()
				
				initialData := map[string]interface{}{
					"messages":       messagesCopy,
					"rooms":          roomsCopy,
					"users":          usersList, // Keep for backward compatibility
					"loggedInUsers":  loggedInUsers,
					"activeUsers":    activeUsers,
					"userPubKeys":    userPubKeysCopy,
				}
				log.Printf("[%s] ✓ User just registered, sending INITIAL_DATA to %s", socketIDStr, username)
				socket.Emit(EventInitialData, initialData)
				log.Printf("[%s] ✓ INITIAL_DATA sent to newly registered user", socketIDStr)
			}

			// Prepare response with updated messages and users
			response := map[string]interface{}{
				"messages": messagesCopy,
				"users":    usersList,
			}

			log.Printf("[%s] Broadcasting SERVER_MESSAGE - rooms: %d, users: %d", socketIDStr, len(messagesCopy), len(usersList))

			// Broadcast to all clients (excluding sender)
			defaultNsp.Emit(EventServerMessage, response)
			log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)

			// Also emit directly to sender so they see their own messages
			socket.Emit(EventServerMessage, response)
			log.Printf("[%s] ✓ Emitted to sender, CLIENT_MESSAGE handler complete", socketIDStr)
		})

		// Register CLIENT_NEW_ROOM handler
		socket.OnEvent(EventClientNewRoom, func(roomName interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_NEW_ROOM EVENT (per-socket) ======", socketIDStr)
			log.Printf("[%s] Received room name: %+v (type: %T)", socketIDStr, roomName, roomName)

			roomNameStr, ok := roomName.(string)
			if !ok {
				log.Printf("[%s] ✗ Invalid room name format", socketIDStr)
				return
			}
			formattedRoom := "#" + roomNameStr
			log.Printf("[%s] Formatted room name: %s", socketIDStr, formattedRoom)
			chatServer.mu.Lock()
			roomExists := false
			for _, r := range chatServer.rooms {
				if r == formattedRoom {
					roomExists = true
					break
				}
			}
			if !roomExists {
				chatServer.rooms = append(chatServer.rooms, formattedRoom)
				chatServer.messages[formattedRoom] = []Message{}
				log.Printf("[%s] ✓ Created new room: %s", socketIDStr, formattedRoom)
			}
			sortedRooms := chatServer.alphabeticalSort(chatServer.rooms)
			chatServer.mu.Unlock()

			// Prepare response (need to copy messages while holding lock)
			chatServer.mu.RLock()
			messagesCopyForResponse := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopyForResponse[k] = make([]Message, len(v))
				copy(messagesCopyForResponse[k], v)
			}
			chatServer.mu.RUnlock()

			response := map[string]interface{}{
				"messages": messagesCopyForResponse,
				"rooms":    sortedRooms,
			}

			log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))
			defaultNsp.Emit(EventServerNewRoom, response)
			socket.Emit(EventServerNewRoom, response)
			log.Printf("[%s] ✓ SERVER_NEW_ROOM sent", socketIDStr)
		})

		// Register CLIENT_DISCONNECTING handler
		// Register CLIENT_REQUEST_ACCESS handler
		socket.OnEvent(EventClientRequestAccess, func(msg interface{}) {
			socketIDStr := string(socket.ID())
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_REQUEST_ACCESS: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_REQUEST_ACCESS EVENT ======", socketIDStr)

			msgMap, ok := msg.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid request access format", socketIDStr)
				return
			}

			// Forward the access request to the original poster
			// Note: The room name in the message is a hint, but we'll use @originalSender for the DM room
			requestingUser, _ := msgMap["username"].(string)
			requestAccessRaw, hasRequestAccess := msgMap["requestAccess"]
			if !hasRequestAccess {
				log.Printf("[%s] ✗ Missing requestAccess field", socketIDStr)
				return
			}

			requestAccess, ok := requestAccessRaw.(map[string]interface{})
			if !ok || requestAccess == nil {
				log.Printf("[%s] ✗ Invalid requestAccess format", socketIDStr)
				return
			}

			originalSender, _ := requestAccess["originalSender"].(string)
			if originalSender == "" {
				log.Printf("[%s] ✗ Missing originalSender in requestAccess", socketIDStr)
				return
			}

			log.Printf("[%s] Forwarding access request from %s to %s", socketIDStr, requestingUser, originalSender)

			// Find the original sender and send them the request
			chatServer.mu.RLock()
			_, exists := chatServer.users[originalSender]
			chatServer.mu.RUnlock()

			if exists {
				// DM room name: both users see it as @{the other user}
				// For the original sender, it's @requestingUser
				// For the requesting user, it's @originalSender
				// We'll use @originalSender as the canonical name, but both users will see messages
				dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser)  // Original sender sees @requestingUser
				dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSender)    // Requesting user sees @originalSender
				// Use the requesting user's name as canonical (so original sender sees @requestingUser)
				dmRoom := dmRoomForOriginalSender
				
				// Find the original message to get its content for quoting
				originalRoom, _ := requestAccess["originalRoom"].(string)
				var messageTimestamp int64
				if ts, ok := requestAccess["messageTimestamp"].(float64); ok {
					messageTimestamp = int64(ts)
				} else if ts, ok := requestAccess["messageTimestamp"].(int64); ok {
					messageTimestamp = ts
				} else if ts, ok := requestAccess["messageTimestamp"].(int); ok {
					messageTimestamp = int64(ts)
				}
				
				chatServer.mu.Lock()
				// Find the original message content
				originalMessageContent := ""
				if originalRoomMessages, exists := chatServer.messages[originalRoom]; exists {
					for _, msg := range originalRoomMessages {
						if msg.Timestamp == messageTimestamp && msg.Username == originalSender {
							// Try to get decrypted content if available, otherwise use encrypted indicator
							if msg.Content != "" && !strings.Contains(msg.Content, "🔒") {
								originalMessageContent = msg.Content
							} else {
								originalMessageContent = "[Encrypted message]"
							}
							break
						}
					}
				}
				
				// Reuse the DM room if it exists, otherwise create it
				roomExists := false
				for _, r := range chatServer.rooms {
					if r == dmRoom {
						roomExists = true
						break
					}
				}
				if !roomExists {
					log.Printf("[%s] Creating new DM room: %s", socketIDStr, dmRoom)
					chatServer.messages[dmRoom] = []Message{}
					chatServer.rooms = append(chatServer.rooms, dmRoom)
				} else {
					log.Printf("[%s] Reusing existing DM room: %s", socketIDStr, dmRoom)
					if chatServer.messages[dmRoom] == nil {
						chatServer.messages[dmRoom] = []Message{}
					}
				}

				// Create message for original sender (with quoted content and prompt)
				originalSenderContent := fmt.Sprintf("%s requests access to your message in %s (timestamp: %v)", 
					requestingUser, originalRoom, messageTimestamp)
				if originalMessageContent != "" {
					originalSenderContent += fmt.Sprintf(":\n\n> %s", originalMessageContent)
				}
				
				// Create message for requesting user (status message)
				requestingUserContent := fmt.Sprintf("You requested access to %s's message in %s (timestamp: %v) [Pending]", 
					originalSender, originalRoom, messageTimestamp)

				// Post messages to both DM rooms (each user sees their own room name)
				// Message for original sender (they'll see this with prompt buttons) - visible only to original sender
				originalSenderMsg := Message{
					Timestamp:    time.Now().Unix(),
					Username:     requestingUser,
					Content:      originalSenderContent,
					EncryptedFor: make(map[string]string),
					VisibleTo:    []string{originalSender}, // Only original sender can see this
				}
				
				// Message for requesting user (they'll see this with status) - visible only to requesting user
				requestingUserMsg := Message{
					Timestamp:    time.Now().Unix(),
					Username:     originalSender, // Show original sender's name
					Content:      requestingUserContent,
					EncryptedFor: make(map[string]string),
					VisibleTo:    []string{requestingUser}, // Only requesting user can see this
				}
				
				// Store messages in both room names (each user sees their own room)
				chatServer.messages[dmRoomForOriginalSender] = append([]Message{originalSenderMsg}, chatServer.messages[dmRoomForOriginalSender]...)
				chatServer.messages[dmRoomForRequestingUser] = append([]Message{requestingUserMsg}, chatServer.messages[dmRoomForRequestingUser]...)
				
				// Add both rooms to room list if they don't exist
				roomExists1 := false
				roomExists2 := false
				for _, r := range chatServer.rooms {
					if r == dmRoomForOriginalSender {
						roomExists1 = true
					}
					if r == dmRoomForRequestingUser {
						roomExists2 = true
					}
				}
				if !roomExists1 {
					chatServer.rooms = append(chatServer.rooms, dmRoomForOriginalSender)
				}
				if !roomExists2 {
					chatServer.rooms = append(chatServer.rooms, dmRoomForRequestingUser)
				}
				
				chatServer.mu.Unlock()

				// Send messages only to the intended recipients
				if defaultNsp != nil {
					// Include the requesting user's public key so the client can encrypt for them
					requestingUserPubKey := ""
					chatServer.mu.RLock()
					if key, exists := chatServer.userPubKeys[requestingUser]; exists {
						requestingUserPubKey = key
					}
					chatServer.mu.RUnlock()
					
					// Send to original sender: access request with their room name
					accessRequestDataForOriginalSender := map[string]interface{}{
						"requestAccess":        requestAccess,
						"requestingUser":       requestingUser,
						"requestRoom":          dmRoomForOriginalSender, // Original sender sees @requestingUser
						"requestingUserPubKey": requestingUserPubKey,
					}
					chatServer.sendToUsers(defaultNsp, []string{originalSender}, EventServerAccessRequest, accessRequestDataForOriginalSender)
					
					// Send message update to original sender (only their visible message)
					responseForOriginalSender := map[string]interface{}{
						"messages": map[string][]Message{dmRoomForOriginalSender: []Message{originalSenderMsg}},
						"rooms":    chatServer.rooms,
					}
					chatServer.sendToUsers(defaultNsp, []string{originalSender}, EventServerMessage, responseForOriginalSender)
					
					// Send message update to requesting user (only their visible message)
					responseForRequestingUser := map[string]interface{}{
						"messages": map[string][]Message{dmRoomForRequestingUser: []Message{requestingUserMsg}},
						"rooms":    chatServer.rooms,
					}
					chatServer.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)
					
					log.Printf("[%s] ✓ Access request sent to %s (room: %s) and %s (room: %s)", socketIDStr, originalSender, dmRoomForOriginalSender, requestingUser, dmRoomForRequestingUser)
				} else {
					log.Printf("[%s] ✗ defaultNsp is nil, cannot forward access request", socketIDStr)
				}
			} else {
				log.Printf("[%s] ✗ Original sender %s not found", socketIDStr, originalSender)
			}
		})

		// Register CLIENT_GRANT_ACCESS handler
		socket.OnEvent(EventClientGrantAccess, func(grantData interface{}) {
			socketIDStr := string(socket.ID())
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_GRANT_ACCESS: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_GRANT_ACCESS EVENT RECEIVED ======", socketIDStr)
			log.Printf("[%s] Grant data type: %T", socketIDStr, grantData)
			log.Printf("[%s] Grant data: %+v", socketIDStr, grantData)
			log.Printf("[%s] ✓ Handler is executing - event was successfully received by server", socketIDStr)

			grantMap, ok := grantData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid grant access format", socketIDStr)
				return
			}

			requestingUser, _ := grantMap["requestingUser"].(string)
			originalRoom, _ := grantMap["originalRoom"].(string)
			
			// Handle encryptedFor map (all users)
			encryptedForRaw, hasEncryptedFor := grantMap["encryptedFor"]
			var encryptedFor map[string]string
			if hasEncryptedFor {
				if efMap, ok := encryptedForRaw.(map[string]interface{}); ok {
					encryptedFor = make(map[string]string)
					for k, v := range efMap {
						if str, ok := v.(string); ok {
							encryptedFor[k] = str
						}
					}
				}
			}
			
			// Backward compatibility: single encryptedMessage
			if encryptedFor == nil {
				if encryptedMessage, ok := grantMap["encryptedMessage"].(string); ok && encryptedMessage != "" {
					encryptedFor = make(map[string]string)
					if requestingUser != "" {
						encryptedFor[requestingUser] = encryptedMessage
					}
				}
			}

			// Handle messageTimestamp - it might come as float64 from JSON
			var messageTimestamp int64
			if ts, ok := grantMap["messageTimestamp"].(float64); ok {
				messageTimestamp = int64(ts)
			} else if ts, ok := grantMap["messageTimestamp"].(int64); ok {
				messageTimestamp = ts
			} else if ts, ok := grantMap["messageTimestamp"].(int); ok {
				messageTimestamp = int64(ts)
			} else {
				log.Printf("[%s] ✗ Invalid messageTimestamp type", socketIDStr)
				return
			}

			if requestingUser == "" || originalRoom == "" || len(encryptedFor) == 0 {
				log.Printf("[%s] ✗ Missing required fields in grant access: requestingUser=%s, originalRoom=%s, encryptedFor=%d", socketIDStr, requestingUser, originalRoom, len(encryptedFor))
				return
			}

			log.Printf("[%s] Granting access: user=%s, room=%s, timestamp=%d, encryptedFor=%d users", socketIDStr, requestingUser, originalRoom, messageTimestamp, len(encryptedFor))
			log.Printf("[%s] EncryptedFor users: %v", socketIDStr, func() []string {
				users := make([]string, 0, len(encryptedFor))
				for u := range encryptedFor {
					users = append(users, u)
				}
				return users
			}())
			
			// CRITICAL: Verify the requesting user is in the encryptedFor map
			if _, hasRequestingUser := encryptedFor[requestingUser]; !hasRequestingUser {
				log.Printf("[%s] ⚠ WARNING: Requesting user %s is NOT in encryptedFor map!", socketIDStr, requestingUser)
				log.Printf("[%s] ⚠ Available users in encryptedFor: %v", socketIDStr, func() []string {
					users := make([]string, 0, len(encryptedFor))
					for u := range encryptedFor {
						users = append(users, u)
					}
					return users
				}())
				log.Printf("[%s] ⚠ This means the requesting user cannot decrypt the message!", socketIDStr)
				log.Printf("[%s] ⚠ The client should have included the requesting user's public key", socketIDStr)
				// We'll still proceed, but the requesting user won't be able to decrypt
			} else {
				log.Printf("[%s] ✓ Requesting user %s is in encryptedFor map", socketIDStr, requestingUser)
			}

			log.Printf("[%s] About to update message in room %s with timestamp %d", socketIDStr, originalRoom, messageTimestamp)
			// Update the message with new version
			chatServer.mu.Lock()
			log.Printf("[%s] Lock acquired for message update", socketIDStr)
			if messages, exists := chatServer.messages[originalRoom]; exists && messages != nil {
				log.Printf("[%s] Room %s exists with %d messages", socketIDStr, originalRoom, len(messages))
				for i := range messages {
					if messages[i].Timestamp == messageTimestamp {
						// Initialize versions array if needed
						if messages[i].Versions == nil {
							messages[i].Versions = []MessageVersion{}
							// Migrate existing EncryptedFor to version 0
							if len(messages[i].EncryptedFor) > 0 {
								messages[i].Versions = append(messages[i].Versions, MessageVersion{
									EncryptedFor:  messages[i].EncryptedFor,
									Version:       0,
									ChangeSummary: "original version",
									Timestamp:     messages[i].Timestamp,
								})
							}
						}
						
						// Determine which users were added
						// Check if there's a previous version to compare against
						var prevEncryptedFor map[string]string
						if len(messages[i].Versions) > 0 {
							prevEncryptedFor = messages[i].Versions[0].EncryptedFor // Most recent version
						} else if len(messages[i].EncryptedFor) > 0 {
							// Fall back to current EncryptedFor if no versions yet
							prevEncryptedFor = messages[i].EncryptedFor
						} else {
							prevEncryptedFor = make(map[string]string)
						}
						
						addedUsers := []string{}
						for user := range encryptedFor {
							if _, exists := prevEncryptedFor[user]; !exists {
								addedUsers = append(addedUsers, user)
							}
						}
						
						// Create change summary
						changeSummary := fmt.Sprintf("added key for user %s", requestingUser)
						if len(addedUsers) > 1 {
							changeSummary = fmt.Sprintf("added keys for users: %s", strings.Join(addedUsers, ", "))
						}
						
						// Add new version (newest first)
						newVersion := MessageVersion{
							EncryptedFor:  encryptedFor,
							Version:       len(messages[i].Versions),
							ChangeSummary: changeSummary,
							Timestamp:     time.Now().Unix(),
						}
						messages[i].Versions = append([]MessageVersion{newVersion}, messages[i].Versions...)
						messages[i].CurrentVersion = new(int)
						*messages[i].CurrentVersion = 0 // Index of newest version
						
						// Update EncryptedFor for backward compatibility (use newest version)
						messages[i].EncryptedFor = encryptedFor
						
						log.Printf("[%s] ✓ Added new message version %d with %d encrypted keys", socketIDStr, newVersion.Version, len(encryptedFor))
						break
					}
				}
			} else {
				log.Printf("[%s] ✗ Room %s not found or has no messages", socketIDStr, originalRoom)
			}
			
			// Get original sender while we still have the lock
			originalSenderForDM := ""
			if messages, exists := chatServer.messages[originalRoom]; exists {
				for _, msg := range messages {
					if msg.Timestamp == messageTimestamp {
						originalSenderForDM = msg.Username
						log.Printf("[%s] ✓ Found original sender: %s", socketIDStr, originalSenderForDM)
						break
					}
				}
				if originalSenderForDM == "" {
					log.Printf("[%s] ✗ Could not find original sender for timestamp %d", socketIDStr, messageTimestamp)
				}
			}
			
			dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser)  // Original sender sees @requestingUser
			dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSenderForDM) // Requesting user sees @originalSender
			log.Printf("[%s] Original sender for DM: %s, DM rooms: %s (original sender) and %s (requesting user)", socketIDStr, originalSenderForDM, dmRoomForOriginalSender, dmRoomForRequestingUser)
			
			if originalSenderForDM != "" {
				// Update DM room messages while we still have the lock
				// Update original sender's room (@requestingUser)
				if dmRoomMessages, exists := chatServer.messages[dmRoomForOriginalSender]; exists && dmRoomMessages != nil {
					for i := range dmRoomMessages {
						if strings.Contains(dmRoomMessages[i].Content, "requests access") {
							if !strings.Contains(dmRoomMessages[i].Content, "[Access Granted]") {
								dmRoomMessages[i].Content = strings.Replace(
									dmRoomMessages[i].Content,
									"requests access",
									"requests access [Access Granted]",
									1,
								)
								log.Printf("[%s] ✓ Updated access request message to show grant in %s", socketIDStr, dmRoomForOriginalSender)
							}
						}
					}
				}
				// Update requesting user's room (@originalSender)
				if dmRoomMessages, exists := chatServer.messages[dmRoomForRequestingUser]; exists && dmRoomMessages != nil {
					for i := range dmRoomMessages {
						if strings.Contains(dmRoomMessages[i].Content, "You requested access") {
							dmRoomMessages[i].Content = strings.Replace(
								dmRoomMessages[i].Content,
								"[Pending]",
								"[Access Granted]",
								1,
							)
							log.Printf("[%s] ✓ Updated requesting user status message to show grant in %s", socketIDStr, dmRoomForRequestingUser)
						}
					}
				}
			}
			chatServer.mu.Unlock()
			log.Printf("[%s] Lock released after all updates", socketIDStr)

			// Notify both users with filtered message updates
			if defaultNsp != nil {
				chatServer.mu.RLock()
				// Get updated messages for the original room
				// Deep copy to ensure encryptedFor is included
				messagesCopy := make([]Message, len(chatServer.messages[originalRoom]))
				for i, msg := range chatServer.messages[originalRoom] {
					messagesCopy[i] = Message{
						Timestamp:    msg.Timestamp,
						Username:     msg.Username,
						Content:      msg.Content, // This will be empty for encrypted messages
						EncryptedFor: make(map[string]string),
						Versions:     msg.Versions,
						CurrentVersion: msg.CurrentVersion,
						VisibleTo:    msg.VisibleTo,
					}
					// Copy encryptedFor map
					for k, v := range msg.EncryptedFor {
						messagesCopy[i].EncryptedFor[k] = v
					}
				}
				log.Printf("[%s] Copied %d messages for original room %s", socketIDStr, len(messagesCopy), originalRoom)
				// Log the target message specifically
				for _, msg := range messagesCopy {
					if msg.Timestamp == messageTimestamp {
						log.Printf("[%s] Target message in copy: timestamp=%d, encryptedFor keys=%v, hasVersions=%v", 
							socketIDStr, msg.Timestamp, func() []string {
								keys := make([]string, 0, len(msg.EncryptedFor))
								for k := range msg.EncryptedFor {
									keys = append(keys, k)
								}
								return keys
							}(), msg.Versions != nil && len(msg.Versions) > 0)
						if msg.Versions != nil && len(msg.Versions) > 0 {
							log.Printf("[%s] Target message newest version encryptedFor keys=%v", 
								socketIDStr, func() []string {
									keys := make([]string, 0, len(msg.Versions[0].EncryptedFor))
									for k := range msg.Versions[0].EncryptedFor {
										keys = append(keys, k)
									}
									return keys
								}())
						}
					}
				}
				
				// Get updated messages for both DM rooms (filtered by visibility)
				dmRoomMessagesForOriginalSender := filterMessagesByVisibility(
					chatServer.messages[dmRoomForOriginalSender],
					originalSenderForDM,
				)
				dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
					chatServer.messages[dmRoomForRequestingUser],
					requestingUser,
				)
				
				chatServer.mu.RUnlock()
				
				// Verify target message has encryptedFor before sending
				for _, msg := range messagesCopy {
					if msg.Timestamp == messageTimestamp {
						log.Printf("[%s] Target message before send: timestamp=%d, encryptedFor keys=%v, encryptedFor count=%d", 
							socketIDStr, msg.Timestamp, func() []string {
								keys := make([]string, 0, len(msg.EncryptedFor))
								for k := range msg.EncryptedFor {
									keys = append(keys, k)
								}
								return keys
							}(), len(msg.EncryptedFor))
						if len(msg.EncryptedFor) == 0 {
							log.Printf("[%s] ⚠ WARNING: Target message has empty encryptedFor! This should not happen!", socketIDStr)
						}
					}
				}
				
				// Send to original sender: original room + their DM room
				responseForOriginalSender := map[string]interface{}{
					"accessGrant": map[string]interface{}{
						"originalRoom":     originalRoom,
						"messageTimestamp": messageTimestamp,
						"encryptedFor":     encryptedFor,
					},
					"messages": map[string][]Message{
						originalRoom:              messagesCopy,
						dmRoomForOriginalSender:  dmRoomMessagesForOriginalSender,
					},
					"rooms": chatServer.rooms,
				}
				log.Printf("[%s] Sending to original sender: %s", socketIDStr, originalSenderForDM)
				chatServer.sendToUsers(defaultNsp, []string{originalSenderForDM}, EventServerMessage, responseForOriginalSender)
				
				// Send to requesting user: original room + their DM room
				responseForRequestingUser := map[string]interface{}{
					"accessGrant": map[string]interface{}{
						"originalRoom":     originalRoom,
						"messageTimestamp": messageTimestamp,
						"encryptedFor":     encryptedFor,
					},
					"messages": map[string][]Message{
						originalRoom:             messagesCopy,
						dmRoomForRequestingUser: dmRoomMessagesForRequestingUser,
					},
					"rooms": chatServer.rooms,
				}
				log.Printf("[%s] About to send to requesting user: %s", socketIDStr, requestingUser)
				log.Printf("[%s] Checking if requesting user is in users map...", socketIDStr)
				chatServer.mu.RLock()
				if socketIDForRequestingUser, exists := chatServer.users[requestingUser]; exists {
					log.Printf("[%s] ✓ Requesting user %s found in users map with socketID: %s", socketIDStr, requestingUser, socketIDForRequestingUser)
				} else {
					log.Printf("[%s] ✗ Requesting user %s NOT found in users map!", socketIDStr, requestingUser)
					log.Printf("[%s] Available users in map: %v", socketIDStr, func() []string {
						users := make([]string, 0, len(chatServer.users))
						for u := range chatServer.users {
							users = append(users, u)
						}
						return users
					}())
				}
				chatServer.mu.RUnlock()
				log.Printf("[%s] Sending to requesting user: %s", socketIDStr, requestingUser)
				chatServer.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)
				
				log.Printf("[%s] ✓ Access grant notifications sent to %s and %s", socketIDStr, originalSenderForDM, requestingUser)
			} else {
				log.Printf("[%s] ✗ defaultNsp is nil, cannot send access grant notification", socketIDStr)
			}
		})

		// Register CLIENT_DENY_ACCESS handler
		socket.OnEvent(EventClientDenyAccess, func(denyData interface{}) {
			socketIDStr := string(socket.ID())
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_DENY_ACCESS: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_DENY_ACCESS EVENT ======", socketIDStr)

			denyMap, ok := denyData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid deny access format", socketIDStr)
				return
			}

			requestingUser, _ := denyMap["requestingUser"].(string)
			originalRoom, _ := denyMap["originalRoom"].(string)

			// Handle messageTimestamp
			var messageTimestamp int64
			if ts, ok := denyMap["messageTimestamp"].(float64); ok {
				messageTimestamp = int64(ts)
			} else if ts, ok := denyMap["messageTimestamp"].(int64); ok {
				messageTimestamp = ts
			} else if ts, ok := denyMap["messageTimestamp"].(int); ok {
				messageTimestamp = int64(ts)
			} else {
				log.Printf("[%s] ✗ Invalid messageTimestamp type", socketIDStr)
				return
			}

			if requestingUser == "" || originalRoom == "" {
				log.Printf("[%s] ✗ Missing required fields in deny access", socketIDStr)
				return
			}

			log.Printf("[%s] Denying access: user=%s, room=%s, timestamp=%d", socketIDStr, requestingUser, originalRoom, messageTimestamp)

			// Find the original sender to determine DM room names
			chatServer.mu.RLock()
			originalSender := ""
			if originalRoomMessages, exists := chatServer.messages[originalRoom]; exists {
				for _, msg := range originalRoomMessages {
					if msg.Timestamp == messageTimestamp {
						originalSender = msg.Username
						break
					}
				}
			}
			chatServer.mu.RUnlock()
			
			if originalSender == "" {
				log.Printf("[%s] ✗ Could not find original sender for message", socketIDStr)
				return
			}
			
			dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser)  // Original sender sees @requestingUser
			dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSender)   // Requesting user sees @originalSender
			
			chatServer.mu.Lock()
			// Update original sender's room (@requestingUser)
			if dmRoomMessages, exists := chatServer.messages[dmRoomForOriginalSender]; exists && dmRoomMessages != nil {
				for i := range dmRoomMessages {
					if strings.Contains(dmRoomMessages[i].Content, "requests access") {
						dmRoomMessages[i].Content = strings.Replace(
							dmRoomMessages[i].Content,
							"requests access",
							"requests access [Access Denied]",
							1,
						)
						log.Printf("[%s] ✓ Updated access request message to show denial in %s", socketIDStr, dmRoomForOriginalSender)
					}
				}
			}
			// Update requesting user's room (@originalSender)
			if dmRoomMessages, exists := chatServer.messages[dmRoomForRequestingUser]; exists && dmRoomMessages != nil {
				for i := range dmRoomMessages {
					if strings.Contains(dmRoomMessages[i].Content, "You requested access") {
						dmRoomMessages[i].Content = strings.Replace(
							dmRoomMessages[i].Content,
							"[Pending]",
							"[Access Denied]",
							1,
						)
						log.Printf("[%s] ✓ Updated requesting user status message to show denial in %s", socketIDStr, dmRoomForRequestingUser)
					}
				}
			}
			chatServer.mu.Unlock()
			
			// Send updated DM room messages only to the intended recipients
			if defaultNsp != nil {
				chatServer.mu.RLock()
				dmRoomMessagesForOriginalSender := filterMessagesByVisibility(
					chatServer.messages[dmRoomForOriginalSender],
					originalSender,
				)
				dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
					chatServer.messages[dmRoomForRequestingUser],
					requestingUser,
				)
				chatServer.mu.RUnlock()
				
				// Send to original sender
				responseForOriginalSender := map[string]interface{}{
					"messages": map[string][]Message{dmRoomForOriginalSender: dmRoomMessagesForOriginalSender},
					"rooms":    chatServer.rooms,
				}
				chatServer.sendToUsers(defaultNsp, []string{originalSender}, EventServerMessage, responseForOriginalSender)
				
				// Send to requesting user
				responseForRequestingUser := map[string]interface{}{
					"messages": map[string][]Message{dmRoomForRequestingUser: dmRoomMessagesForRequestingUser},
					"rooms":    chatServer.rooms,
				}
				chatServer.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)
			}

			// Notify the requesting user
			if defaultNsp != nil {
				denialData := map[string]interface{}{
					"accessDenied": map[string]interface{}{
						"originalRoom":     originalRoom,
						"messageTimestamp": messageTimestamp,
					},
				}
				defaultNsp.Emit(EventServerAccessDenied, denialData)
				log.Printf("[%s] ✓ Access denial notification sent to %s", socketIDStr, requestingUser)
			} else {
				log.Printf("[%s] ✗ defaultNsp is nil, cannot send access denial notification", socketIDStr)
			}
		})

		// Register CLIENT_LEAVE_ROOM handler (client-side only, just acknowledge)
		socket.OnEvent(EventClientLeaveRoom, func(leaveData interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_LEAVE_ROOM EVENT ======", socketIDStr)
			// Room leaving is handled client-side, server just logs it
		})

		// Register CLIENT_REJOIN_ROOM handler (client-side only, just acknowledge)
		socket.OnEvent(EventClientRejoinRoom, func(rejoinData interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_REJOIN_ROOM EVENT ======", socketIDStr)
			// Room rejoining is handled client-side, server just logs it
		})

		// Register CLIENT_VOTE_JOIN handler
		// Register vote message handler (per-socket)
		socket.OnEvent(EventClientVoteMessage, func(voteData interface{}) {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_VOTE_MESSAGE (per-socket) handler: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_VOTE_MESSAGE EVENT (per-socket) ======", socketIDStr)
			
			voteMap, ok := voteData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid vote data format, type: %T", socketIDStr, voteData)
				return
			}

			room, _ := voteMap["room"].(string)
			messageTimestampRaw, hasTimestamp := voteMap["messageTimestamp"]
			username, _ := voteMap["username"].(string)
			voteTypeRaw, hasVoteType := voteMap["voteType"]

			if !hasTimestamp || !hasVoteType || username == "" || room == "" {
				log.Printf("[%s] ✗ Missing required vote fields", socketIDStr)
				return
			}

			var messageTimestamp int64
			if tsFloat, ok := messageTimestampRaw.(float64); ok {
				messageTimestamp = int64(tsFloat)
			} else {
				log.Printf("[%s] ✗ Invalid messageTimestamp format", socketIDStr)
				return
			}

			voteType, ok := voteTypeRaw.(string)
			if !ok || (voteType != "up" && voteType != "down") {
				log.Printf("[%s] ✗ Invalid voteType, must be 'up' or 'down'", socketIDStr)
				return
			}

			chatServer.mu.Lock()

			// Find the message
			messages, exists := chatServer.messages[room]
			if !exists {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ Room %s not found", socketIDStr, room)
				return
			}

			var targetMessage *Message
			for i := range messages {
				if messages[i].Timestamp == messageTimestamp {
					targetMessage = &messages[i]
					break
				}
			}

			if targetMessage == nil {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ Message with timestamp %d not found in room %s", socketIDStr, messageTimestamp, room)
				return
			}

			// Initialize vote fields if needed
			if targetMessage.UserVotes == nil {
				targetMessage.UserVotes = make(map[string]string)
			}
			if targetMessage.VoteTotal == nil {
				zero := 0
				targetMessage.VoteTotal = &zero
			}

			// Get current vote for this user
			currentVote, hasVote := targetMessage.UserVotes[username]

			// Handle vote logic
			if hasVote && currentVote == voteType {
				// User is clicking the same vote again - remove it
				delete(targetMessage.UserVotes, username)
				if currentVote == "up" {
					*targetMessage.VoteTotal--
				} else {
					*targetMessage.VoteTotal++
				}
				log.Printf("[%s] ✓ Removed %s vote from message %d by %s (new total: %d)", socketIDStr, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
			} else if hasVote && currentVote != voteType {
				// User is switching votes - remove old, add new
				if currentVote == "up" {
					*targetMessage.VoteTotal--
				} else {
					*targetMessage.VoteTotal++
				}
				targetMessage.UserVotes[username] = voteType
				if voteType == "up" {
					*targetMessage.VoteTotal++
				} else {
					*targetMessage.VoteTotal--
				}
				log.Printf("[%s] ✓ Switched vote from %s to %s for message %d by %s (new total: %d)", socketIDStr, currentVote, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
			} else {
				// User is voting for the first time
				targetMessage.UserVotes[username] = voteType
				if voteType == "up" {
					*targetMessage.VoteTotal++
				} else {
					*targetMessage.VoteTotal--
				}
				log.Printf("[%s] ✓ Added %s vote to message %d by %s (new total: %d)", socketIDStr, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
			}

			// Copy data for saving and response while holding the lock
			messagesCopyForSave := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopyForSave[k] = make([]Message, len(v))
				copy(messagesCopyForSave[k], v)
			}
			roomsCopyForSave := make([]string, len(chatServer.rooms))
			copy(roomsCopyForSave, chatServer.rooms)
			usersCopyForSave := make(map[string]string)
			for k, v := range chatServer.users {
				usersCopyForSave[k] = v
			}
			
			// Prepare response with updated messages
			messagesCopy := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopy[k] = make([]Message, len(v))
				copy(messagesCopy[k], v)
			}
			usersList := make([]string, 0, len(chatServer.users))
			for user := range chatServer.users {
				usersList = append(usersList, user)
			}
			
			// Copy userPubKeys for save
			userPubKeysCopy := make(map[string]string)
			for k, v := range chatServer.userPubKeys {
				userPubKeysCopy[k] = v
			}
			
			chatServer.mu.Unlock()

			// Save state in background (outside of lock)
			go func() {
				if err := chatServer.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
					log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
				}
			}()

			response := map[string]interface{}{
				"messages": messagesCopy,
				"users":    usersList,
			}

			// Broadcast to all clients
			defaultNsp.Emit(EventServerVoteUpdate, response)
			log.Printf("[%s] ✓ Broadcasted vote update", socketIDStr)
		})

		// Register edit message handler (per-socket)
		socket.OnEvent(EventClientEditMessage, func(editData interface{}) {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_EDIT_MESSAGE (per-socket) handler: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_EDIT_MESSAGE EVENT (per-socket) ======", socketIDStr)
			
			editMap, ok := editData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid edit data format, type: %T", socketIDStr, editData)
				return
			}

			room, _ := editMap["room"].(string)
			messageTimestampRaw, hasTimestamp := editMap["messageTimestamp"]
			username, _ := editMap["username"].(string)
			encryptedForRaw, hasEncrypted := editMap["encryptedFor"]

			if !hasTimestamp || username == "" || room == "" {
				log.Printf("[%s] ✗ Missing required edit fields", socketIDStr)
				return
			}

			var messageTimestamp int64
			if tsFloat, ok := messageTimestampRaw.(float64); ok {
				messageTimestamp = int64(tsFloat)
			} else {
				log.Printf("[%s] ✗ Invalid messageTimestamp format", socketIDStr)
				return
			}

			var encryptedFor map[string]string
			if hasEncrypted {
				if efMap, ok := encryptedForRaw.(map[string]interface{}); ok {
					encryptedFor = make(map[string]string)
					for k, v := range efMap {
						if str, ok := v.(string); ok {
							encryptedFor[k] = str
						}
					}
				}
			}

			chatServer.mu.Lock()

			// Find the message
			messages, exists := chatServer.messages[room]
			if !exists {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ Room %s not found", socketIDStr, room)
				return
			}

			var targetMessage *Message
			for i := range messages {
				if messages[i].Timestamp == messageTimestamp {
					targetMessage = &messages[i]
					break
				}
			}

			if targetMessage == nil {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ Message with timestamp %d not found in room %s", socketIDStr, messageTimestamp, room)
				return
			}

			// Validate that the editor is the original sender
			if targetMessage.Username != username {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ User %s attempted to edit message by %s (unauthorized)", socketIDStr, username, targetMessage.Username)
				return
			}

			// Update the message
			targetMessage.Content = "" // Clear plaintext (encrypted only)
			targetMessage.EncryptedFor = encryptedFor
			targetMessage.Edited = true

			log.Printf("[%s] ✓ Message %d edited by %s", socketIDStr, messageTimestamp, username)

			// Copy data for saving and response while holding the lock
			messagesCopyForSave := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopyForSave[k] = make([]Message, len(v))
				copy(messagesCopyForSave[k], v)
			}
			roomsCopyForSave := make([]string, len(chatServer.rooms))
			copy(roomsCopyForSave, chatServer.rooms)
			usersCopyForSave := make(map[string]string)
			for k, v := range chatServer.users {
				usersCopyForSave[k] = v
			}
			
			// Prepare response with updated messages
			messagesCopy := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopy[k] = make([]Message, len(v))
				copy(messagesCopy[k], v)
			}
			usersList := make([]string, 0, len(chatServer.users))
			for user := range chatServer.users {
				usersList = append(usersList, user)
			}
			
			// Copy userPubKeys for save
			userPubKeysCopy := make(map[string]string)
			for k, v := range chatServer.userPubKeys {
				userPubKeysCopy[k] = v
			}
			
			chatServer.mu.Unlock()

			// Save state in background (outside of lock)
			go func() {
				if err := chatServer.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
					log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
				}
			}()

			response := map[string]interface{}{
				"messages": messagesCopy,
				"users":    usersList,
			}

			// Broadcast to all clients
			defaultNsp.Emit(EventServerMessage, response)
			log.Printf("[%s] ✓ Broadcasted message edit update", socketIDStr)
		})

		socket.OnEvent(EventClientVoteJoin, func(voteData interface{}) {
			socketIDStr := string(socket.ID())
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[%s] ✗ PANIC in CLIENT_VOTE_JOIN: %v", socketIDStr, r)
				}
			}()
			log.Printf("[%s] ===== CLIENT_VOTE_JOIN EVENT ======", socketIDStr)

			voteMap, ok := voteData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid vote format", socketIDStr)
				return
			}

			room, _ := voteMap["room"].(string)
			requestingUser, _ := voteMap["requestingUser"].(string)
			vote, _ := voteMap["vote"].(bool) // true = accept, false = deny
			voter, _ := voteMap["voter"].(string)

			if room == "" || requestingUser == "" || voter == "" {
				log.Printf("[%s] ✗ Missing required fields in vote", socketIDStr)
				return
			}

			requestKey := fmt.Sprintf("%s:%s", room, requestingUser)
			chatServer.mu.Lock()
			req, exists := chatServer.joinRequests[requestKey]
			if !exists {
				chatServer.mu.Unlock()
				log.Printf("[%s] ✗ Join request not found: %s", socketIDStr, requestKey)
				return
			}

			// Record vote
			req.Votes[voter] = vote
			log.Printf("[%s] Vote recorded: %s voted %v for %s to join %s", socketIDStr, voter, vote, requestingUser, room)

			// Count votes
			accepts := 0
			denials := 0
			for _, v := range req.Votes {
				if v {
					accepts++
				} else {
					denials++
				}
			}

			// Get room member count (excluding the requesting user)
			roomMemberCount := len(chatServer.roomMembers[room])

			// Calculate threshold: min(3, halfMembers rounded up)
			threshold := 3
			if roomMemberCount > 0 {
				halfMembers := (roomMemberCount + 1) / 2 // Round up: (n+1)/2
				if halfMembers < threshold {
					threshold = halfMembers
				}
			} else {
				// If no members, require at least 1 vote (but this shouldn't happen as first person is auto-admitted)
				threshold = 1
			}

			log.Printf("[%s] Vote threshold for %s to join %s: %d (room has %d members)", socketIDStr, requestingUser, room, threshold, roomMemberCount)

			approved := false
			denied := false

			// Check if denied (any denial)
			if denials > 0 {
				denied = true
			} else if accepts >= threshold {
				approved = true
			}

			if approved {
				// Add user to room members
				if chatServer.roomMembers[room] == nil {
					chatServer.roomMembers[room] = make(map[string]bool)
				}
				chatServer.roomMembers[room][requestingUser] = true

				// Post join message
				joinMsg := Message{
					Timestamp: time.Now().Unix(),
					Username:  requestingUser,
					Content:   UserJoined,
				}
				if chatServer.messages[room] == nil {
					chatServer.messages[room] = []Message{}
				}
				chatServer.messages[room] = append([]Message{joinMsg}, chatServer.messages[room]...)

				// Remove join request
				delete(chatServer.joinRequests, requestKey)

				chatServer.mu.Unlock()

				// Broadcast approval
				approvalData := map[string]interface{}{
					"type":           "joinApproved",
					"requestingUser": requestingUser,
					"room":           room,
				}
				defaultNsp.Emit(EventServerJoinApproved, approvalData)

				// Broadcast updated message
				// Don't include users field - we're not updating the user list here
				response := map[string]interface{}{
					"messages": map[string][]Message{room: chatServer.messages[room]},
					"rooms":    chatServer.rooms,
					// Don't send users field - it would overwrite the client's user list
				}
				defaultNsp.Emit(EventServerMessage, response)

				log.Printf("[%s] ✓ Join request approved for %s to join %s", socketIDStr, requestingUser, room)
			} else if denied {
				// Remove join request
				delete(chatServer.joinRequests, requestKey)

				// Post denial message
				denialMsg := Message{
					Timestamp: time.Now().Unix(),
					Username:  "system",
					Content:   fmt.Sprintf("%s was denied access to this room", requestingUser),
				}
				if chatServer.messages[room] == nil {
					chatServer.messages[room] = []Message{}
				}
				chatServer.messages[room] = append([]Message{denialMsg}, chatServer.messages[room]...)

				chatServer.mu.Unlock()

				// Broadcast denial
				denialData := map[string]interface{}{
					"type":           "joinDenied",
					"requestingUser": requestingUser,
					"room":           room,
				}
				defaultNsp.Emit(EventServerJoinDenied, denialData)

				// Broadcast updated message
				// Don't include users field - we're not updating the user list here
				response := map[string]interface{}{
					"messages": map[string][]Message{room: chatServer.messages[room]},
					"rooms":    chatServer.rooms,
					// Don't send users field - it would overwrite the client's user list
				}
				defaultNsp.Emit(EventServerMessage, response)

				log.Printf("[%s] ✗ Join request denied for %s to join %s", socketIDStr, requestingUser, room)
			} else {
				chatServer.mu.Unlock()
				log.Printf("[%s] Vote recorded, waiting for more votes (accepts: %d/%d, denials: %d)", socketIDStr, accepts, threshold, denials)
			}
		})

		socket.OnEvent(EventClientDisconnecting, func(sessionID interface{}) {
			socketIDStr := string(socket.ID())
			sessionIDStrParam, ok := sessionID.(string)
			if !ok {
				return
			}
			chatServer.mu.Lock()
			for user, sid := range chatServer.users {
				if sid == sessionIDStrParam {
					delete(chatServer.users, user)
					break
				}
			}

			// Prepare data for saving
			messagesCopyForSave := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopyForSave[k] = make([]Message, len(v))
				copy(messagesCopyForSave[k], v)
			}
			roomsCopyForSave := make([]string, len(chatServer.rooms))
			copy(roomsCopyForSave, chatServer.rooms)
			usersCopyForSave := make(map[string]string)
			for k, v := range chatServer.users {
				usersCopyForSave[k] = v
			}
			chatServer.mu.Unlock()

			// Save to disk (outside of lock to avoid blocking)
			go func() {
				if err := chatServer.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, chatServer.userPubKeys); err != nil {
					log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
				}
			}()

			log.Printf("[%s] client disconnecting", socketIDStr)
		})

		log.Printf("[%s] ✓ Per-socket event handlers registered", socketIDStr)

		// Send INITIAL_DATA immediately after connection
		go func() {
			time.Sleep(50 * time.Millisecond) // Small delay to ensure connection is ready

			// Get current state from chatServer
			chatServer.mu.RLock()
			// Try to get username from users map (socketID -> username lookup)
			// Note: At connection time, user might not be in users map yet (they get added on first message)
			// If not found, we'll send all messages (no filtering) to avoid hanging
			usernameForFilter := ""
			for user, sid := range chatServer.users {
				if sid == socketIDStr {
					usernameForFilter = user
					break
				}
			}
			
			// If username not found, log it but continue (will send all messages)
			if usernameForFilter == "" {
				log.Printf("[%s] Username not found in users map at connection time - will send all messages (no filtering)", socketIDStr)
			} else {
				log.Printf("[%s] Found username for filtering: %s", socketIDStr, usernameForFilter)
			}
			
			messagesCopy := make(Messages)
			for k, v := range chatServer.messages {
				// Filter messages by visibility for this user (if username found, otherwise send all)
				filtered := filterMessagesByVisibility(v, usernameForFilter)
				if len(filtered) > 0 {
					messagesCopy[k] = filtered
				}
			}
			roomsCopy := make([]string, len(chatServer.rooms))
			copy(roomsCopy, chatServer.rooms)
			var usersCopy []string
			for user := range chatServer.users {
				if user != "" && user != "undefined" {
					usersCopy = append(usersCopy, user)
				}
			}
			sort.Slice(usersCopy, func(i, j int) bool {
				return strings.ToLower(usersCopy[i]) < strings.ToLower(usersCopy[j])
			})

			// Copy user public keys (still holding the lock)
			userPubKeysCopy := make(map[string]string)
			for k, v := range chatServer.userPubKeys {
				userPubKeysCopy[k] = v
			}
			chatServer.mu.RUnlock()

			log.Printf("[%s] Sending INITIAL_DATA - rooms: %d, users: %d, pubKeys: %d", socketIDStr, len(roomsCopy), len(usersCopy), len(userPubKeysCopy))
			// Get room members for each room
			roomMembersCopy := make(map[string][]string)
			for room, members := range chatServer.roomMembers {
				memberList := make([]string, 0, len(members))
				for member := range members {
					memberList = append(memberList, member)
				}
				roomMembersCopy[room] = memberList
			}

			// Get user last seen times
			userLastSeenCopy := make(map[string]int64)
			for user, lastSeen := range chatServer.userLastSeen {
				userLastSeenCopy[user] = lastSeen
			}

			socket.Emit(EventStatus, "Hello from Socket.io")
			// Get logged-in and active user lists
			loggedInUsers, activeUsers := chatServer.getUserLists()
			
			socket.Emit(EventInitialData, map[string]interface{}{
				"messages":       messagesCopy,
				"rooms":          roomsCopy,
				"users":          usersCopy, // Keep for backward compatibility
				"loggedInUsers":  loggedInUsers,
				"activeUsers":    activeUsers,
				"userPubKeys":    userPubKeysCopy,
				"roomMembers":    roomMembersCopy,
				"userLastSeen":   userLastSeenCopy,
			})
			log.Printf("[%s] ✓ INITIAL_DATA sent", socketIDStr)
		}()
	})
	log.Println("OnConnection handler registered")

	log.Println("Setting up socket handlers...")
	chatServer.setupSocketHandlers(sio)

	// Setup HTTP routes
	log.Println("Setting up HTTP routes...")
	mux := http.NewServeMux()

	// IMPORTANT: Register API routes BEFORE Socket.IO handler
	// API routes must be registered first to avoid Socket.IO intercepting them
	mux.HandleFunc("/api/server-public-key", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleGetServerPublicKey(w, r)
	})
	log.Println("Registered /api/server-public-key handler")

	mux.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("===== /api/login REQUEST (wrapper) ======")
		log.Printf("Method: %s", r.Method)
		log.Printf("Remote: %s", r.RemoteAddr)
		log.Printf("URL: %s", r.URL.String())

		// Use the response writer directly - don't wrap it as it might interfere
		chatServer.handleLogin(w, r)

		log.Printf("===== /api/login REQUEST (wrapper) COMPLETE ======")
	})
	log.Println("Registered /api/login handler")

	mux.HandleFunc("/api/delete-user", func(w http.ResponseWriter, r *http.Request) {
		chatServer.handleDeleteUser(w, r)
	})
	log.Println("Registered /api/delete-user handler")

	// Socket.IO handler - the new library handles HTTP automatically
	// Mount the Socket.IO server to handle /socket.io/ requests
	// This should only match /socket.io/* paths
	mux.Handle("/socket.io/", sio)
	log.Println("Registered /socket.io/ handler")

	// Static file serving from Next.js static export (out directory)
	outDir := "../out"

	// Check if out directory exists
	if _, err := os.Stat(outDir); os.IsNotExist(err) {
		log.Printf("Warning: out directory not found at %s. Please run 'npm run build' first.", outDir)
	}

	// Serve static assets from out/_next/static with correct MIME types
	staticDir := outDir + "/_next/static"

	// Also serve other static files from out directory (like favicon, etc.)
	fileServer := http.FileServer(http.Dir(outDir))
	mux.Handle("/_next/", http.StripPrefix("/_next/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Determine correct Content-Type based on file extension
		ext := filepath.Ext(r.URL.Path)
		var contentType string
		switch ext {
		case ".js":
			contentType = "application/javascript; charset=utf-8"
		case ".css":
			contentType = "text/css; charset=utf-8"
		case ".json":
			contentType = "application/json; charset=utf-8"
		case ".map":
			contentType = "application/json; charset=utf-8"
		default:
			// Use Go's MIME type detection
			contentType = mime.TypeByExtension(ext)
			if contentType == "" {
				contentType = "application/octet-stream"
			}
		}

		// Wrap the response writer to override Content-Type
		mw := &mimeOverrideWriter{
			ResponseWriter: w,
			contentType:    contentType,
		}
		fileServer.ServeHTTP(mw, r)
	})))

	if _, err := os.Stat(staticDir); err == nil {
		// Register MIME types globally
		mime.AddExtensionType(".js", "application/javascript")
		mime.AddExtensionType(".css", "text/css")
		mime.AddExtensionType(".json", "application/json")
		mime.AddExtensionType(".map", "application/json")

		// Create a file server with MIME type handling
		fileServer := http.FileServer(http.Dir(staticDir))
		mux.Handle("/_next/static/", http.StripPrefix("/_next/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Determine correct Content-Type based on file extension
			ext := filepath.Ext(r.URL.Path)
			var contentType string
			switch ext {
			case ".js":
				contentType = "application/javascript; charset=utf-8"
			case ".css":
				contentType = "text/css; charset=utf-8"
			case ".json":
				contentType = "application/json; charset=utf-8"
			case ".map":
				contentType = "application/json; charset=utf-8"
			default:
				// Use Go's MIME type detection
				contentType = mime.TypeByExtension(ext)
				if contentType == "" {
					contentType = "application/octet-stream"
				}
			}

			// Wrap the response writer to override Content-Type
			mw := &mimeOverrideWriter{
				ResponseWriter: w,
				contentType:    contentType,
			}
			fileServer.ServeHTTP(mw, r)
		})))
	}

	// Serve root and handle SPA routing - serve static HTML files from Next.js static export
	// Next.js static export generates HTML files in the out/ directory
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Skip API and socket.io routes
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/socket.io/") || strings.HasPrefix(r.URL.Path, "/_next/") {
			return
		}

		// Determine the file path in the out directory
		path := r.URL.Path
		if path == "/" || path == "" {
			path = "/index.html"
		} else if !strings.HasSuffix(path, ".html") {
			// For SPA routing, try the path with .html extension
			htmlPath := outDir + path + ".html"
			if info, err := os.Stat(htmlPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, htmlPath)
				return
			}
			// If not found, fall back to index.html for client-side routing
			path = "/index.html"
		}

		// Serve the HTML file from out directory
		filePath := outDir + path
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, filePath)
			return
		}

		// Fallback to index.html if file not found
		indexPath := outDir + "/index.html"
		if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, indexPath)
			return
		}

		// Last resort: return 404
		http.NotFound(w, r)
	})

	log.Println("===== SERVER STARTUP COMPLETE ======")
	log.Printf("Go server starting on port %s", port)
	log.Printf("Serving static files from out directory (Next.js static export)")
	log.Printf("Make sure to run 'npm run build' first to generate out directory")
	log.Printf("Server will listen on: http://localhost:%s", port)
	log.Printf("Socket.IO endpoint: http://localhost:%s/socket.io/", port)
	log.Printf("API endpoint: http://localhost:%s/api/login", port)
	log.Println("===== READY TO ACCEPT CONNECTIONS ======")

	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("FATAL: Server failed to start: %v", err)
	}
}

