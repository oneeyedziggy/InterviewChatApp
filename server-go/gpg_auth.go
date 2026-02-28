package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

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

	log.Printf("[handleLogin] ✓ Decoded request - Username: %s, Has PublicKey: %v, Has EncryptedUUID: %v",
		req.Username, req.PublicKey != "", req.EncryptedUUID != "")

	// Validate username
	if req.Username == "" || len(req.Username) < MinUsernameLength {
		log.Printf("[handleLogin] ✗ Validation failed - Username: %s", req.Username)
		json.NewEncoder(w).Encode(LoginResponse{
			Error: fmt.Sprintf("Username must be at least %d characters", MinUsernameLength),
		})
		return
	}

	// Validate username doesn't contain whitespace
	if strings.ContainsAny(req.Username, " \t\n\r") {
		log.Printf("[handleLogin] ✗ Username contains whitespace: %s", req.Username)
		json.NewEncoder(w).Encode(LoginResponse{
			Error: "Username cannot contain whitespace",
		})
		return
	}

	cs.mu.RLock()
	userPubKey, userExists := cs.userPubKeys[req.Username]
	cs.mu.RUnlock()

	// If user exists and they're sending a public key, check if it matches
	if req.PublicKey != "" && userExists {
		// Check if the public key matches the stored one
		if userPubKey == req.PublicKey {
			// Public key matches - this is a login attempt, send challenge
			log.Printf("[handleLogin] User exists with matching public key, sending challenge: %s", req.Username)
			
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
			cs.sessionCache.Set("challenge_"+req.Username, challengeUUID)
			
			log.Printf("[handleLogin] ✓ Challenge sent to existing user: %s", req.Username)
			json.NewEncoder(w).Encode(LoginResponse{
				Challenge: encryptedArmored,
			})
			return
		} else {
			// Public key doesn't match - reject registration attempt
			log.Printf("[handleLogin] ✗ Username already exists with different public key: %s", req.Username)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Username already exists",
			})
			return
		}
	}

	// First-time registration: user sends public key
	if req.PublicKey != "" && !userExists {
		log.Printf("[handleLogin] First-time registration for user: %s", req.Username)

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
		cs.userPubKeys[req.Username] = req.PublicKey
		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
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
		cs.mu.Unlock()

		// Save to disk
		go func() {
			if err := cs.store.Save(messagesCopy, roomsCopy, usersCopy, userPubKeysCopy); err != nil {
				log.Printf("[handleLogin] ✗ Failed to save state: %v", err)
			}
		}()

		// Create session and return success
		sessionID := generateSalt()
		cs.sessionCache.Set(sessionID, req.Username)
		cs.setUser(req.Username, sessionID)

		log.Printf("[handleLogin] ✓ New user registered: %s", req.Username)
		json.NewEncoder(w).Encode(LoginResponse{
			SessionID:       sessionID,
			ServerPublicKey: cs.serverPublicKey,
		})
		return
	}

	// Challenge-response authentication for existing users
	if userExists {
		// If no encrypted UUID provided, send challenge
		if req.EncryptedUUID == "" {
			log.Printf("[handleLogin] Sending challenge to user: %s", req.Username)

			// Generate UUID challenge
			challengeUUID := uuid.New().String()
			log.Printf("[handleLogin] Generated challenge UUID: %s", challengeUUID)

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
			cs.sessionCache.Set("challenge_"+req.Username, challengeUUID)

			log.Printf("[handleLogin] ✓ Challenge sent to user: %s", req.Username)
			json.NewEncoder(w).Encode(LoginResponse{
				Challenge: encryptedArmored,
			})
			return
		}

		// Verify encrypted UUID response
		log.Printf("[handleLogin] Verifying challenge response for user: %s", req.Username)

		// Get stored challenge
		storedChallenge, exists := cs.sessionCache.Get("challenge_" + req.Username)
		if !exists {
			log.Printf("[handleLogin] ✗ No challenge found for user: %s", req.Username)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Challenge expired or not found",
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
		log.Printf("[handleLogin] Decrypted UUID: %s, Expected: %s", decryptedUUID, storedChallenge)

		// Compare UUIDs
		if decryptedUUID != storedChallenge {
			log.Printf("[handleLogin] ✗ UUID mismatch for user: %s", req.Username)
			json.NewEncoder(w).Encode(LoginResponse{
				Error: "Authentication failed",
			})
			return
		}

		// Authentication successful
		sessionID := generateSalt()
		cs.sessionCache.Set(sessionID, req.Username)
		cs.sessionCache.Delete("challenge_" + req.Username) // Clean up challenge
		cs.setUser(req.Username, sessionID)

		log.Printf("[handleLogin] ✓ Authentication successful for user: %s, session: %s", req.Username, sessionID)
		json.NewEncoder(w).Encode(LoginResponse{
			SessionID: sessionID,
		})
		return
	}

	// User doesn't exist and no public key provided
	log.Printf("[handleLogin] ✗ User not found: %s", req.Username)
	json.NewEncoder(w).Encode(LoginResponse{
		Error: "User not found. Please register with a public key first.",
	})
}

// DeleteUserRequest represents a request to delete a user account
type DeleteUserRequest struct {
	Username  string `json:"username"`
	SessionID string `json:"sessionId"`
}

// DeleteUserResponse represents the response from deleting a user
type DeleteUserResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
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
	storedUsername, exists := cs.sessionCache.Get(req.SessionID)
	if !exists || storedUsername != req.Username {
		log.Printf("[handleDeleteUser] ✗ Invalid session for user: %s", req.Username)
		json.NewEncoder(w).Encode(DeleteUserResponse{
			Error: "Invalid session",
		})
		return
	}

	log.Printf("[handleDeleteUser] Deleting user: %s", req.Username)

	// Delete user from server state
	cs.mu.Lock()
	
	// Remove from users map
	delete(cs.users, req.Username)
	
	// Remove from userPubKeys
	delete(cs.userPubKeys, req.Username)
	
	// Remove from roomMembers
	for room := range cs.roomMembers {
		if cs.roomMembers[room] != nil {
			delete(cs.roomMembers[room], req.Username)
		}
	}
	
	// Remove from userLastSeen
	delete(cs.userLastSeen, req.Username)
	
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
		cs.mu.RUnlock()

		if err := cs.store.Save(messagesCopy, roomsCopy, usersCopy, cs.userPubKeys); err != nil {
			log.Printf("[handleDeleteUser] ✗ Failed to save state: %v", err)
		}
	}()

	// Note: User list update will be broadcast by the socket handler
	// We don't have direct access to defaultNsp here, but the deletion
	// will be reflected in the next user list update

	log.Printf("[handleDeleteUser] ✓ User deleted: %s", req.Username)
	json.NewEncoder(w).Encode(DeleteUserResponse{
		Success: true,
	})
}
