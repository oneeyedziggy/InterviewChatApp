package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/google/uuid"
)

// handleGetServerPublicKey returns the server's public key
func (cs *ChatServer) handleGetServerPublicKey(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	response := map[string]string{
		"publicKey": cs.serverPublicKey,
	}

	json.NewEncoder(w).Encode(response)
}

// handleAuth is a single auth endpoint used on page load to validate an
// existing session or return the server public key so the client can start
// a login flow. Request body may include { sessionId: string }.
func (cs *ChatServer) handleAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	var req struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Bad request; still provide server public key so client can proceed to login
		json.NewEncoder(w).Encode(map[string]any{"valid": false, "serverPublicKey": cs.serverPublicKey})
		return
	}

	if req.SessionID == "" {
		json.NewEncoder(w).Encode(map[string]any{"valid": false, "serverPublicKey": cs.serverPublicKey})
		return
	}

	// Check session cache
	storedUserID, exists := cs.sessionCache.Get(req.SessionID)
	if !exists || storedUserID == "" {
		json.NewEncoder(w).Encode(map[string]any{"valid": false, "serverPublicKey": cs.serverPublicKey})
		return
	}
	if storedUserID == "" {
		json.NewEncoder(w).Encode(map[string]any{"valid": false, "serverPublicKey": cs.serverPublicKey})
		return
	}

	json.NewEncoder(w).Encode(map[string]any{"valid": true, "userId": storedUserID})
}

// handleLogin handles GPG-based authentication
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

	if r.Method != http.MethodPost {
		log.Printf("[handleLogin] ✗ Method not allowed: %s", r.Method)
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(LoginResponse{Error: "Method not allowed"})
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[handleLogin] ✗ Failed to decode request body: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(LoginResponse{Error: "Invalid request"})
		return
	}

	log.Printf("[handleLogin] ✓ Decoded request - UserID: %s, Has PublicKey: %v, Has EncryptedUUID: %v",
		req.UserID, req.PublicKey != "", req.EncryptedUUID != "")

	if strings.TrimSpace(req.UserID) == "" {
		json.NewEncoder(w).Encode(LoginResponse{Error: "Missing userId"})
		return
	}

	cs.mu.RLock()
	userPubKey, userExists := cs.userPubKeys[req.UserID]
	cs.mu.RUnlock()

	// If user exists and they're sending a public key, check if it matches
	if req.PublicKey != "" && userExists {
		// Check if the public key matches the stored one
		if userPubKey == req.PublicKey {
			// Public key matches - this is a login attempt, send challenge
			log.Printf("[handleLogin] User exists with matching public key, sending challenge: %s", req.UserID)

			// Generate challenge UUID
			challengeUUID := uuid.New().String()

			// Encrypt challenge with user's public key
			userKey, err := crypto.NewKeyFromArmored(userPubKey)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to parse user public key: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			userKeyRing, err := crypto.NewKeyRing(userKey)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to create keyring: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			message := crypto.NewPlainMessage([]byte(challengeUUID))
			encrypted, err := userKeyRing.Encrypt(message, nil)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to encrypt challenge: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			encryptedArmored, err := encrypted.GetArmored()
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to armor encrypted challenge: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			// Store challenge temporarily
			cs.sessionCache.Set("challenge_"+req.UserID, challengeUUID)

			log.Printf("[handleLogin] ✓ Challenge sent to existing user: %s", req.UserID)
			json.NewEncoder(w).Encode(LoginResponse{
				Challenge: encryptedArmored,
				UserID:    req.UserID,
			})
			return
		} else {
			// Public key doesn't match - reject registration attempt
			log.Printf("[handleLogin] ✗ User already exists with different public key: %s", req.UserID)
			json.NewEncoder(w).Encode(LoginResponse{
				Error:  "Account already exists. Please sign in with the original keypair.",
				UserID: req.UserID,
			})
			return
		}
	}

	// First-time registration: user sends public key and opaque identity metadata
	if req.PublicKey != "" && !userExists {
		log.Printf("[handleLogin] First-time registration for userId: %s", req.UserID)

		if strings.TrimSpace(req.UsernameHash) == "" || strings.TrimSpace(req.UsernameCiphertext) == "" {
			json.NewEncoder(w).Encode(LoginResponse{
				Error:  "Missing encrypted identity metadata",
				UserID: req.UserID,
			})
			return
		}

		cs.mu.RLock()
		existingUserIDForHash, hashExists := cs.usernameHashes[req.UsernameHash]
		cs.mu.RUnlock()
		if hashExists && existingUserIDForHash != req.UserID {
			json.NewEncoder(w).Encode(LoginResponse{
				Error:  "Username already exists. Please use a different username.",
				UserID: req.UserID,
			})
			return
		}

		// Validate the public key
		_, err := crypto.NewKeyFromArmored(req.PublicKey)
		if err != nil {
			log.Printf("[handleLogin] ✗ Invalid public key format: %v", err)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Invalid public key format",
			})
			return
		}

		// Store the user's public key
		cs.mu.Lock()
		cs.userPubKeys[req.UserID] = req.PublicKey
		if cs.userPubKeysUpdatedAt == nil {
			cs.userPubKeysUpdatedAt = make(map[string]int64)
		}
		cs.userPubKeysUpdatedAt[req.UserID] = time.Now().UTC().UnixMilli()
		cs.usernameHashes[req.UsernameHash] = req.UserID
		cs.usernameCiphertexts[req.UserID] = req.UsernameCiphertext
		if req.UsernameCiphertext != "" {
			if cs.userDirectoryUpdatedAt == nil {
				cs.userDirectoryUpdatedAt = make(map[string]int64)
			}
			cs.userDirectoryUpdatedAt[req.UserID] = time.Now().UTC().UnixMilli()
		}
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}
		userPubKeysUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.userPubKeysUpdatedAt {
			userPubKeysUpdatedAtCopy[k] = v
		}
		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		roomsCopy := make([]string, len(cs.rooms))
		copy(roomsCopy, cs.rooms)
		usersCopy := make(map[string]string)
		for k, v := range cs.users {
			usersCopy[k] = v
		}
		userDirectoryUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.userDirectoryUpdatedAt {
			userDirectoryUpdatedAtCopy[k] = v
		}
		roomDirectoryUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.roomDirectoryUpdatedAt {
			roomDirectoryUpdatedAtCopy[k] = v
		}
		roomNameCiphertextsCopy := make(map[string]string)
		for k, v := range cs.roomNameCiphertexts {
			roomNameCiphertextsCopy[k] = v
		}
		roomNameHashesCopy := make(map[string]string)
		for k, v := range cs.roomNameHashes {
			roomNameHashesCopy[k] = v
		}
		usernameCiphertextsCopy := make(map[string]string)
		for k, v := range cs.usernameCiphertexts {
			usernameCiphertextsCopy[k] = v
		}
		cs.mu.Unlock()

		// Save to disk
		go func() {
			roomIDsCopy := cs.getIdentityMapsForSave()
			if err := cs.store.SaveWithIdentity(messagesCopy, roomsCopy, usersCopy, userPubKeysCopy, userPubKeysUpdatedAtCopy, nil, roomIDsCopy, roomNameHashesCopy, roomNameCiphertextsCopy, usernameCiphertextsCopy, userDirectoryUpdatedAtCopy, roomDirectoryUpdatedAtCopy); err != nil {
				log.Printf("[handleLogin] ✗ Failed to save state: %v", err)
			}
		}()

		// Create session and return success
		sessionID := generateSalt()
		userID := req.UserID
		cs.sessionCache.Set(sessionID, userID)
		cs.setUser(req.UserID, sessionID)

		log.Printf("[handleLogin] ✓ New user registered: %s", req.UserID)
		json.NewEncoder(w).Encode(LoginResponse{
			SessionID:       sessionID,
			UserID:          userID,
			ServerPublicKey: cs.serverPublicKey,
		})
		return
	}

	// Challenge-response authentication for existing users
	if userExists {
		// If no encrypted UUID provided, send challenge
		if req.EncryptedUUID == "" {
			log.Printf("[handleLogin] Sending challenge to user: %s", req.UserID)

			// Generate UUID challenge
			challengeUUID := uuid.New().String()
			log.Printf("[handleLogin] Generated login challenge for user: %s", req.UserID)

			// Encrypt UUID with user's public key
			userKey, err := crypto.NewKeyFromArmored(userPubKey)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to parse user public key: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			userKeyRing, err := crypto.NewKeyRing(userKey)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to create user key ring: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			message := crypto.NewPlainMessageFromString(challengeUUID)
			encrypted, err := userKeyRing.Encrypt(message, nil)
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to encrypt challenge: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			encryptedArmored, err := encrypted.GetArmored()
			if err != nil {
				log.Printf("[handleLogin] ✗ Failed to armor encrypted challenge: %v", err)
				json.NewEncoder(w).Encode(LoginResponse{
					Error: "Failed to process authentication",
				})
				return
			}

			// Store challenge temporarily (in production, use Redis with TTL)
			cs.sessionCache.Set("challenge_"+req.UserID, challengeUUID)

			log.Printf("[handleLogin] ✓ Challenge sent to user: %s", req.UserID)
			json.NewEncoder(w).Encode(LoginResponse{
				Challenge: encryptedArmored,
				UserID:    req.UserID,
			})
			return
		}

		// Verify encrypted UUID response
		log.Printf("[handleLogin] Verifying challenge response for user: %s", req.UserID)

		// Get stored challenge
		storedChallenge, exists := cs.sessionCache.Get("challenge_" + req.UserID)
		if !exists {
			log.Printf("[handleLogin] ✗ No challenge found for user: %s", req.UserID)
			json.NewEncoder(w).Encode(LoginResponse{
				Error:  "Challenge expired or not found",
				UserID: req.UserID,
			})
			return
		}

		// Decrypt the client's response with server's private key
		encryptedMessage, err := crypto.NewPGPMessageFromArmored(req.EncryptedUUID)
		if err != nil {
			log.Printf("[handleLogin] ✗ Failed to parse encrypted UUID: %v", err)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Invalid encrypted response",
			})
			return
		}

		decrypted, err := cs.serverKeyRing.Decrypt(encryptedMessage, nil, crypto.GetUnixTime())
		if err != nil {
			log.Printf("[handleLogin] ✗ Failed to decrypt response: %v", err)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Failed to decrypt response",
			})
			return
		}

		decryptedUUID := string(decrypted.GetString())

		// Compare UUIDs
		if decryptedUUID != storedChallenge {
			log.Printf("[handleLogin] ✗ UUID mismatch for user: %s", req.UserID)
			json.NewEncoder(w).Encode(LoginResponse{
				Error:  "Authentication failed",
				UserID: req.UserID,
			})
			return
		}

		// Authentication successful
		sessionID := generateSalt()
		userID := req.UserID
		cs.sessionCache.Set(sessionID, userID)
		cs.sessionCache.Delete("challenge_" + req.UserID) // Clean up challenge
		cs.setUser(req.UserID, sessionID)

		log.Printf("[handleLogin] ✓ Authentication successful for user: %s", req.UserID)
		json.NewEncoder(w).Encode(LoginResponse{
			SessionID: sessionID,
			UserID:    userID,
		})
		return
	}

	// User doesn't exist and no public key provided
	log.Printf("[handleLogin] ✗ User not found: %s", req.UserID)
	json.NewEncoder(w).Encode(LoginResponse{
		Error:  "User not found. Please register first.",
		UserID: req.UserID,
	})
}

// handleDeleteUser handles user account deletion
func (cs *ChatServer) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// Handle OPTIONS preflight
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(DeleteUserResponse{
			Error: "Method not allowed",
		})
		return
	}

	var req DeleteUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[handleDeleteUser] ✗ Failed to decode request: %v", err)
		json.NewEncoder(w).Encode(DeleteUserResponse{
			Error: "Invalid request format",
		})
		return
	}

	// Validate session
	if req.SessionID == "" {
		log.Printf("[handleDeleteUser] ✗ Missing session ID")
		json.NewEncoder(w).Encode(DeleteUserResponse{
			Error: "Session ID required",
		})
		return
	}

	// Verify session
	storedUserID, exists := cs.sessionCache.Get(req.SessionID)
	if !exists || storedUserID == "" || storedUserID != req.UserID {
		log.Printf("[handleDeleteUser] ✗ Invalid session for user: %s", req.UserID)
		json.NewEncoder(w).Encode(DeleteUserResponse{
			Error: "Invalid session",
		})
		return
	}

	log.Printf("[handleDeleteUser] Deleting user: %s", req.UserID)

	// Delete user from server state
	cs.mu.Lock()

	// Remove from users map
	delete(cs.users, req.UserID)
	delete(cs.userSocketsByID, req.UserID)

	// Remove from userPubKeys
	delete(cs.userPubKeys, req.UserID)
	delete(cs.userPubKeysUpdatedAt, req.UserID)
	delete(cs.usernameCiphertexts, req.UserID)
	delete(cs.userDirectoryUpdatedAt, req.UserID)
	for hash, userID := range cs.usernameHashes {
		if userID == req.UserID {
			delete(cs.usernameHashes, hash)
		}
	}

	// Remove from roomMembers
	for roomID := range cs.roomMembers {
		if cs.roomMembers[roomID] != nil {
			delete(cs.roomMembers[roomID], req.UserID)
		}
	}

	// Remove from userLastSeen
	delete(cs.userLastSeen, req.UserID)

	// Remove session from cache
	cs.sessionCache.Delete(req.SessionID)

	cs.mu.Unlock()

	// Save state to disk
	go func() {
		cs.mu.RLock()
		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		roomsCopy := make([]string, len(cs.rooms))
		copy(roomsCopy, cs.rooms)
		usersCopy := make(map[string]string)
		for k, v := range cs.users {
			usersCopy[k] = v
		}
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}
		userPubKeysUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.userPubKeysUpdatedAt {
			userPubKeysUpdatedAtCopy[k] = v
		}
		userDirectoryUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.userDirectoryUpdatedAt {
			userDirectoryUpdatedAtCopy[k] = v
		}
		roomDirectoryUpdatedAtCopy := make(map[string]int64)
		for k, v := range cs.roomDirectoryUpdatedAt {
			roomDirectoryUpdatedAtCopy[k] = v
		}
		roomNameCiphertextsCopy := make(map[string]string)
		for k, v := range cs.roomNameCiphertexts {
			roomNameCiphertextsCopy[k] = v
		}
		roomNameHashesCopy := make(map[string]string)
		for k, v := range cs.roomNameHashes {
			roomNameHashesCopy[k] = v
		}
		usernameCiphertextsCopy := make(map[string]string)
		for k, v := range cs.usernameCiphertexts {
			usernameCiphertextsCopy[k] = v
		}
		cs.mu.RUnlock()
		roomIDsCopy := cs.getIdentityMapsForSave()

		if err := cs.store.SaveWithIdentity(messagesCopy, roomsCopy, usersCopy, userPubKeysCopy, userPubKeysUpdatedAtCopy, nil, roomIDsCopy, roomNameHashesCopy, roomNameCiphertextsCopy, usernameCiphertextsCopy, userDirectoryUpdatedAtCopy, roomDirectoryUpdatedAtCopy); err != nil {
			log.Printf("[handleDeleteUser] ✗ Failed to save state: %v", err)
		}
	}()

	// Note: User list update will be broadcast by the socket handler
	// We don't have direct access to defaultNsp here, but the deletion
	// will be reflected in the next user list update

	log.Printf("[handleDeleteUser] ✓ User deleted: %s", req.UserID)
	json.NewEncoder(w).Encode(DeleteUserResponse{
		Success: true,
	})
}
