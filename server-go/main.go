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
	EventServerMessage        = "serverMessage"
	EventServerNewRoom        = "serverNewRoom"
	EventServerUserListUpdate = "serverUserListUpdate"
	EventInitialData          = "initialData"
	EventStatus               = "status"
	EventDisconnect           = "disconnect"
)

// System messages
const (
	UserJoined = "<-- has entered the room"
	UserLeft   = "says \"smell ya' later\" -->"
)

type Message struct {
	Timestamp int64  `json:"timestamp"`
	Username  string `json:"username"`
	Content   string `json:"content"`
}

type Messages map[string][]Message

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginResponse struct {
	SessionID string `json:"sessionId,omitempty"`
	Error     string `json:"error,omitempty"`
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

type ChatServer struct {
	sessionCache *Cache
	userCache    *Cache
	messages     Messages
	rooms        []string
	users        map[string]string
	mu           sync.RWMutex
}

func NewChatServer() *ChatServer {
	cs := &ChatServer{
		sessionCache: NewCache(SessionTTL),
		userCache:    NewCache(0), // No expiration
		messages:     make(Messages),
		rooms:        []string{DefaultRoom, "#cats"},
		users:        make(map[string]string),
	}
	cs.messages[DefaultRoom] = []Message{}
	cs.messages["#cats"] = []Message{}
	return cs
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

func (cs *ChatServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Set headers early to ensure CORS and content type
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// Handle OPTIONS preflight
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	log.Printf("[handleLogin] ===== ENTERING handleLogin ======")
	log.Printf("[handleLogin] Method: %s", r.Method)
	log.Printf("[handleLogin] URL: %s", r.URL.String())
	log.Printf("[handleLogin] Content-Type: %s", r.Header.Get("Content-Type"))

	if r.Method != http.MethodPost {
		log.Printf("[handleLogin] ✗ Method not allowed: %s", r.Method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[handleLogin] ✗ Failed to decode request body: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(LoginResponse{Error: "Invalid request"})
		return
	}

	log.Printf("[handleLogin] ✓ Decoded request - Username: %s, Password length: %d", req.Username, len(req.Password))

	// Validate input
	if req.Username == "" || len(req.Password) < MinPasswordLength {
		log.Printf("[handleLogin] ✗ Validation failed - Username empty: %v, Password length: %d", req.Username == "", len(req.Password))
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(LoginResponse{Error: "Required parameters missing"}); err != nil {
			log.Printf("[handleLogin] ✗ Failed to encode error response: %v", err)
		}
		log.Printf("[handleLogin] ✓ Validation error response sent")
		return
	}
	log.Printf("[handleLogin] ✓ Validation passed")

	// Generate salt (in production, this should be from env var)
	log.Printf("[handleLogin] Generating salt...")
	salt := generateSalt()
	log.Printf("[handleLogin] ✓ Salt generated: %s", salt)

	log.Printf("[handleLogin] Hashing password...")
	hashedPW, err := hashPassword(req.Password, salt)
	if err != nil {
		log.Printf("[handleLogin] ✗ Password hashing failed: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	log.Printf("[handleLogin] ✓ Password hashed successfully")

	// Check if user exists
	log.Printf("[handleLogin] Checking if user exists: %s", req.Username)
	userExists := cs.userCache.Has(req.Username)
	log.Printf("[handleLogin] User exists: %v", userExists)

	if userExists {
		log.Printf("[handleLogin] User exists, retrieving cached password...")
		cachedHashedPW, _ := cs.userCache.Get(req.Username)
		log.Printf("[handleLogin] ✓ Retrieved cached password")

		if len(req.Username) < MinUsernameLength {
			json.NewEncoder(w).Encode(LoginResponse{
				Error: fmt.Sprintf("Username must be at least %d", MinUsernameLength),
			})
			return
		}
		if len(req.Password) < MinPasswordLength {
			json.NewEncoder(w).Encode(LoginResponse{
				Error: fmt.Sprintf("Password must be at least %d", MinPasswordLength),
			})
			return
		}

		// Compare passwords with constant-time comparison
		log.Printf("[handleLogin] Comparing passwords...")
		passwordsMatch := constantTimeCompare(hashedPW, cachedHashedPW)
		log.Printf("[handleLogin] Passwords match: %v", passwordsMatch)

		if passwordsMatch {
			log.Printf("[handleLogin] ✓ Passwords match, creating session...")
			sessionID := generateSalt()
			cs.sessionCache.Set(sessionID, req.Username)
			cs.setUser(req.Username, sessionID)
			log.Printf("[LOGIN] ✓ Login successful for existing user: %s, session: %s", req.Username, sessionID)
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(LoginResponse{SessionID: sessionID}); err != nil {
				log.Printf("[LOGIN] ✗ Failed to encode response: %v", err)
			} else {
				log.Printf("[LOGIN] ✓ Response sent successfully")
			}
			log.Printf("[handleLogin] ===== EXITING handleLogin (success) ======")
			return
		} else {
			log.Printf("[LOGIN] ✗ Invalid credentials for user: %s", req.Username)
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(LoginResponse{Error: "Invalid Credentials"}); err != nil {
				log.Printf("[LOGIN] ✗ Failed to encode error response: %v", err)
			} else {
				log.Printf("[LOGIN] ✓ Error response sent")
			}
			log.Printf("[handleLogin] ===== EXITING handleLogin (invalid credentials) ======")
			return
		}
	} else {
		// New user
		log.Printf("[handleLogin] New user, creating account...")
		sessionID := generateSalt()
		log.Printf("[handleLogin] ✓ Session ID generated: %s", sessionID)

		log.Printf("[handleLogin] Setting user cache...")
		cs.userCache.Set(req.Username, hashedPW)
		log.Printf("[handleLogin] ✓ User cache set")

		log.Printf("[handleLogin] Setting session cache...")
		cs.sessionCache.Set(sessionID, req.Username)
		log.Printf("[handleLogin] ✓ Session cache set")

		log.Printf("[handleLogin] Calling setUser...")
		// Call setUser in a goroutine with timeout to detect deadlocks
		done := make(chan bool, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[handleLogin] ✗ PANIC in setUser: %v", r)
				}
			}()
			cs.setUser(req.Username, sessionID)
			done <- true
		}()

		select {
		case <-done:
			log.Printf("[handleLogin] ✓ setUser completed")
		case <-time.After(2 * time.Second):
			log.Printf("[handleLogin] ✗ setUser TIMEOUT - possible deadlock!")
			// Continue anyway - the user might still be set
		}

		log.Printf("[LOGIN] ✓ New user created: %s, session: %s", req.Username, sessionID)

		log.Printf("[handleLogin] Preparing response...")
		response := LoginResponse{SessionID: sessionID}
		log.Printf("[handleLogin] Response object created: %+v", response)

		log.Printf("[handleLogin] Setting status code to 200...")
		w.WriteHeader(http.StatusOK)
		log.Printf("[handleLogin] ✓ Status code set")

		log.Printf("[handleLogin] Encoding JSON response...")
		encoder := json.NewEncoder(w)
		if err := encoder.Encode(response); err != nil {
			log.Printf("[LOGIN] ✗ Failed to encode response: %v", err)
			return
		}
		log.Printf("[LOGIN] ✓ JSON encoded successfully")

		// Try to flush the response
		if flusher, ok := w.(http.Flusher); ok {
			log.Printf("[handleLogin] Flushing response...")
			flusher.Flush()
			log.Printf("[handleLogin] ✓ Response flushed")
		}

		log.Printf("[handleLogin] ===== EXITING handleLogin (new user) ======")
		return
	}
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
		content, _ := msgMap["content"].(string)

		log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s", socketIDStr, username, room, content)

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
		cs.messages[room] = append([]Message{{
			Timestamp: time.Now().Unix(),
			Username:  username,
			Content:   content,
		}}, cs.messages[room]...)
		log.Printf("[%s] Added message to room %s (was %d, now has %d messages)", socketIDStr, room, beforeCount, len(cs.messages[room]))

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

		// If this is the user's first message (just registered), send initial data
		// This ensures they get rooms, users, and messages even if they missed the initial emit
		if userJustRegistered {
			initialData := map[string]interface{}{
				"messages": messagesCopy,
				"rooms":    roomsCopy,
				"users":    usersList,
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
		cs.mu.Unlock()

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
		cs.mu.Unlock()
		log.Println("client disconnecting")
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
		socketIDStr := string(socket.ID())
		log.Printf("===== CLIENT CONNECTING ======")
		log.Printf("Socket ID: %s", socketIDStr)

		// Register disconnect handler for this socket
		socket.OnDisconnect(func(reason socketio.Reason) {
			log.Printf("[%s] ===== CLIENT DISCONNECTED ======", socketIDStr)
			log.Printf("[%s] Reason: %s", socketIDStr, string(reason))
		})

		// Register event handlers PER SOCKET - this is required for the new library
		log.Printf("[%s] Registering per-socket event handlers...", socketIDStr)

		// Register CLIENT_MESSAGE handler
		socket.OnEvent(EventClientMessage, func(msg interface{}) {
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

			log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s", socketIDStr, username, room, content)

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
			beforeCount := len(chatServer.messages[room])
			chatServer.messages[room] = append([]Message{{
				Timestamp: time.Now().Unix(),
				Username:  username,
				Content:   content,
			}}, chatServer.messages[room]...)
			log.Printf("[%s] Added message to room %s (was %d, now has %d messages)", socketIDStr, room, beforeCount, len(chatServer.messages[room]))

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

			// If this is the user's first message (just registered), send initial data
			if userJustRegistered {
				initialData := map[string]interface{}{
					"messages": messagesCopy,
					"rooms":    roomsCopy,
					"users":    usersList,
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

			// Prepare response
			response := map[string]interface{}{
				"messages": chatServer.messages,
				"rooms":    sortedRooms,
			}

			log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))
			defaultNsp.Emit(EventServerNewRoom, response)
			socket.Emit(EventServerNewRoom, response)
			log.Printf("[%s] ✓ SERVER_NEW_ROOM sent", socketIDStr)
		})

		// Register CLIENT_DISCONNECTING handler
		socket.OnEvent(EventClientDisconnecting, func(sessionID interface{}) {
			socketIDStr := string(socket.ID())
			sessionIDStr, ok := sessionID.(string)
			if !ok {
				return
			}
			chatServer.mu.Lock()
			for user, sid := range chatServer.users {
				if sid == sessionIDStr {
					delete(chatServer.users, user)
					break
				}
			}
			chatServer.mu.Unlock()
			log.Printf("[%s] client disconnecting", socketIDStr)
		})

		log.Printf("[%s] ✓ Per-socket event handlers registered", socketIDStr)

		// Send INITIAL_DATA immediately after connection
		go func() {
			time.Sleep(50 * time.Millisecond) // Small delay to ensure connection is ready

			// Get current state from chatServer
			chatServer.mu.RLock()
			messagesCopy := make(Messages)
			for k, v := range chatServer.messages {
				messagesCopy[k] = make([]Message, len(v))
				copy(messagesCopy[k], v)
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
			chatServer.mu.RUnlock()

			log.Printf("[%s] Sending INITIAL_DATA - rooms: %d, users: %d", socketIDStr, len(roomsCopy), len(usersCopy))
			socket.Emit(EventStatus, "Hello from Socket.io")
			socket.Emit(EventInitialData, map[string]interface{}{
				"messages": messagesCopy,
				"rooms":    roomsCopy,
				"users":    usersCopy,
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
