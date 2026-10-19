package server

import (
	"fmt"
	"log"
	"strings"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/google/uuid"
)

func (cs *ChatServer) handleRequestAccess(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_REQUEST_ACCESS: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_REQUEST_ACCESS EVENT ======", socketIDStr)

	dataMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid request access format", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, dataMap, EventClientRequestAccess, []string{"userId", "requestAccess.originalSenderId", "requestAccess.originalRoomId", "requestAccess.messageTimestamp"})
	if !verified {
		return
	}
	dataMap["userId"] = auth.UserID

	// Forward the access request to the original poster
	// Note: The room name in the message is a hint, but we'll use @originalSender for the DM room
	requestingUser := cs.resolveUsernameFromPayload(dataMap, "userId")
	requestingUserID := parseStringField(dataMap, "userId")
	requestAccessRaw, hasRequestAccess := dataMap["requestAccess"]
	if !hasRequestAccess {
		log.Printf("[%s] ✗ Missing requestAccess field", socketIDStr)
		return
	}

	requestAccess, ok := requestAccessRaw.(map[string]interface{})
	if !ok || requestAccess == nil {
		log.Printf("[%s] ✗ Invalid requestAccess format", socketIDStr)
		return
	}

	originalSenderID := parseStringField(requestAccess, "originalSenderId")
	originalSender := cs.resolveUsernameFromPayload(requestAccess, "originalSenderId")
	if requestingUserID == "" || requestingUser == "" || originalSenderID == "" || originalSender == "" {
		log.Printf("[%s] ✗ Missing originalSender identity in requestAccess", socketIDStr)
		return
	}
	originalRoomID := parseStringField(requestAccess, "originalRoomId")
	if originalRoomID == "" {
		emitActionResult(socket, "accessRequest", false, "invalid_request", "Missing original room identity")
		return
	}
	var messageTimestamp int64
	switch ts := requestAccess["messageTimestamp"].(type) {
	case float64:
		messageTimestamp = int64(ts)
	case int64:
		messageTimestamp = ts
	case int:
		messageTimestamp = int64(ts)
	}
	if messageTimestamp <= 0 {
		emitActionResult(socket, "accessRequest", false, "invalid_request", "Missing message timestamp")
		return
	}
	cs.mu.RLock()
	_, roomKnown := cs.roomsByID[originalRoomID]
	cs.mu.RUnlock()
	if !roomKnown {
		emitActionResult(socket, "accessRequest", false, "invalid_request", "Unknown room identity")
		return
	}
	if err := cs.store.QueueAccessGrantRequest(requestingUserID, originalSenderID, originalRoomID, messageTimestamp, time.Now().Unix()); err != nil {
		log.Printf("[%s] Failed to persist access request: %v", socketIDStr, err)
		emitActionResult(socket, "accessRequest", false, "server_error", "Unable to queue access request")
		return
	}

	log.Printf("[%s] Forwarding access request from %s to %s", socketIDStr, requestingUser, originalSender)

	// Find the original sender and send them the request
	cs.mu.RLock()
	_, exists := cs.userSocketsByID[originalSenderID]
	cs.mu.RUnlock()

	if exists {
		// DM room name: both users see it as @{the other user}
		// For the original sender, it's @requestingUser
		// For the requesting user, it's @originalSender
		// We'll use @originalSender as the canonical name, but both users will see messages
		dmRoom := buildCanonicalDMRoom(requestingUserID, originalSenderID)

		// Find the original message to get its content for quoting
		cs.mu.RLock()
		originalRoom := cs.roomsByID[originalRoomID]
		cs.mu.RUnlock()
		if strings.TrimSpace(originalRoom) == "" {
			log.Printf("[%s] ✗ Unknown originalRoomId in requestAccess", socketIDStr)
			return
		}

		cs.mu.Lock()
		// Find the original message content and fail closed if target message doesn't exist.
		originalMessageContent := ""
		foundOriginalMessage := false
		if originalRoomMessages, exists := cs.messages[originalRoom]; exists {
			for _, data := range originalRoomMessages {
				if data.Timestamp == messageTimestamp && data.UserID == originalSenderID {
					foundOriginalMessage = true
					// Try to get decrypted content if available, otherwise use encrypted indicator
					if data.Content != "" && !strings.Contains(data.Content, "🔒") {
						originalMessageContent = data.Content
					} else {
						originalMessageContent = "[Encrypted message]"
					}
					break
				}
			}
		}
		if !foundOriginalMessage {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Request access target message not found in room %s ts=%d", socketIDStr, originalRoom, messageTimestamp)
			return
		}

		// Reuse the DM room if it exists, otherwise create it
		roomExists := false
		for _, r := range cs.rooms {
			if r == dmRoom {
				roomExists = true
				break
			}
		}
		if !roomExists {
			log.Printf("[%s] Creating new DM room: %s", socketIDStr, dmRoom)
			cs.messages[dmRoom] = []Message{}
			cs.rooms = append(cs.rooms, dmRoom)
			cs.ensureRoomIDLocked(dmRoom)
		} else {
			log.Printf("[%s] Reusing existing DM room: %s", socketIDStr, dmRoom)
			if cs.messages[dmRoom] == nil {
				cs.messages[dmRoom] = []Message{}
			}
		}

		// Create message for original sender (with quoted content and prompt)
		originalSenderContent := fmt.Sprintf("%s requests access to your message in %s (timestamp: %v)",
			formatSystemUserRef(requestingUserID), originalRoom, messageTimestamp)
		if originalMessageContent != "" {
			originalSenderContent += fmt.Sprintf(":\n\n> %s", originalMessageContent)
		}

		// Create message for requesting user (status message)
		requestingUserContent := fmt.Sprintf("You requested access to %s's message in %s (timestamp: %v) [Pending]",
			formatSystemUserRef(originalSenderID), originalRoom, messageTimestamp)

		// Post messages to both DM rooms (each user sees their own room name)
		// Message for original sender (they'll see this with prompt buttons) - visible only to original sender
		originalSenderMsg := Message{
			Timestamp:    time.Now().Unix(),
			Username:     requestingUser,
			UserID:       requestingUserID,
			RoomID:       cs.ensureRoomIDLocked(dmRoom),
			Content:      originalSenderContent,
			EncryptedFor: make(map[string]string),
			VisibleTo:    []string{originalSenderID}, // Only original sender can see this
		}

		// Message for requesting user (they'll see this with status) - visible only to requesting user
		requestingUserMsg := Message{
			Timestamp:    time.Now().Unix(),
			Username:     originalSender, // Show original sender's name
			UserID:       originalSenderID,
			RoomID:       cs.ensureRoomIDLocked(dmRoom),
			Content:      requestingUserContent,
			EncryptedFor: make(map[string]string),
			VisibleTo:    []string{requestingUserID}, // Only requesting user can see this
		}

		cs.messages[dmRoom] = append([]Message{requestingUserMsg, originalSenderMsg}, cs.messages[dmRoom]...)

		cs.mu.Unlock()

		// Send messages only to the intended recipients
		if defaultNsp != nil {
			// Include the requesting user's public key so the client can encrypt for them
			requestingUserPubKey := ""
			requestingUserPubKeyUpdatedAt := int64(0)
			cs.mu.RLock()
			if key, exists := cs.userPubKeys[requestingUserID]; exists {
				requestingUserPubKey = key
			}
			if updatedAt, exists := cs.userPubKeysUpdatedAt[requestingUserID]; exists {
				requestingUserPubKeyUpdatedAt = updatedAt
			}
			cs.mu.RUnlock()

			// Send to original sender: access request with their room name
			accessRequestDataForOriginalSender := map[string]interface{}{
				"requestAccess":                 requestAccess,
				"requestRoom":                   dmRoom,
				"requestingUserId":              requestingUserID,
				"originalSenderId":              originalSenderID,
				"requestingUserPubKey":          requestingUserPubKey,
				"requestingUserPubKeyUpdatedAt": requestingUserPubKeyUpdatedAt,
			}
			cs.sendToUserIDs(defaultNsp, []string{originalSenderID}, EventServerAccessRequest, accessRequestDataForOriginalSender)

			// Send message update to original sender (only their visible message)
			responseForOriginalSender := map[string]interface{}{
				"messages": map[string][]Message{dmRoom: {originalSenderMsg}},
				"rooms":    cs.rooms,
			}
			cs.sendToUserIDs(defaultNsp, []string{originalSenderID}, EventServerMessage, responseForOriginalSender)

			// Send message update to requesting user (only their visible message)
			responseForRequestingUser := map[string]interface{}{
				"messages": map[string][]Message{dmRoom: {requestingUserMsg}},
				"rooms":    cs.rooms,
			}
			cs.sendToUserIDs(defaultNsp, []string{requestingUserID}, EventServerMessage, responseForRequestingUser)

			log.Printf("[%s] ✓ Access request sent to %s and %s in room %s", socketIDStr, originalSender, requestingUser, dmRoom)
		} else {
			log.Printf("[%s] ✗ defaultNsp is nil, cannot forward access request", socketIDStr)
		}
	} else {
		log.Printf("[%s] ✗ Original sender %s not found", socketIDStr, originalSender)
	}

}

func (cs *ChatServer) handleGrantAccess(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_GRANT_ACCESS: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_GRANT_ACCESS EVENT RECEIVED ======", socketIDStr)
	log.Printf("[%s] Grant data type: %T", socketIDStr, data)
	log.Printf("[%s] Grant data: %+v", socketIDStr, data)
	log.Printf("[%s] ✓ Handler is executing - event was successfully received by server", socketIDStr)

	grantMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid grant access format", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, grantMap, EventClientGrantAccess, []string{"requestingUserId", "originalRoomId", "messageTimestamp", "encryptedMessage"})
	if !verified {
		return
	}

	requestingUser := cs.resolveUsernameFromPayload(grantMap, "requestingUserId")
	requestingUserID := parseStringField(grantMap, "requestingUserId")
	originalRoom := cs.resolveRoomFromPayload(grantMap, "originalRoomId")
	originalRoomID := parseStringField(grantMap, "originalRoomId")
	encryptedMessage, _ := grantMap["encryptedMessage"].(string)

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

	if requestingUser == "" || requestingUserID == "" || originalRoomID == "" || originalRoom == "" || encryptedMessage == "" {
		log.Printf("[%s] ✗ Missing required fields in grant access: requestingUser=%s, originalRoom=%s, hasEncryptedMessage=%v", socketIDStr, requestingUser, originalRoom, encryptedMessage != "")
		return
	}
	if !cs.roomPayloadConsistent(originalRoom, originalRoomID) || !cs.roomExists(originalRoom) {
		log.Printf("[%s] ✗ Rejected grant access for invalid room identity room=%s roomId=%s", socketIDStr, originalRoom, originalRoomID)
		return
	}

	log.Printf("[%s] Granting access: user=%s, room=%s, timestamp=%d, packetSize=%d", socketIDStr, requestingUser, originalRoom, messageTimestamp, len(encryptedMessage))

	log.Printf("[%s] About to update message in room %s with timestamp %d", socketIDStr, originalRoom, messageTimestamp)
	// Update the message with new version
	cs.mu.Lock()
	log.Printf("[%s] Lock acquired for message update", socketIDStr)
	foundTargetMessage := false
	if messages, exists := cs.messages[originalRoom]; exists && messages != nil {
		log.Printf("[%s] Room %s exists with %d messages", socketIDStr, originalRoom, len(messages))
		for i := range messages {
			if messages[i].Timestamp == messageTimestamp && messages[i].UserID == auth.UserID {
				foundTargetMessage = true
				// Initialize versions array if needed
				if messages[i].Versions == nil {
					messages[i].Versions = []MessageVersion{}
					if messages[i].EncryptedMessage != "" {
						messages[i].Versions = append(messages[i].Versions, MessageVersion{
							EncryptedMessage: messages[i].EncryptedMessage,
							Version:          0,
							ChangeSummary:    "original version",
							Timestamp:        messages[i].Timestamp,
						})
					}
				}

				changeSummary := fmt.Sprintf("access grant re-encryption for %s", requestingUser)

				// Add new version (newest first)
				newVersion := MessageVersion{
					EncryptedMessage: encryptedMessage,
					Version:          len(messages[i].Versions),
					ChangeSummary:    changeSummary,
					Timestamp:        time.Now().Unix(),
				}
				messages[i].Versions = append([]MessageVersion{newVersion}, messages[i].Versions...)
				messages[i].CurrentVersion = new(int)
				*messages[i].CurrentVersion = 0 // Index of newest version

				messages[i].EncryptedMessage = encryptedMessage
				messages[i].EncryptedFor = nil

				log.Printf("[%s] ✓ Added new message version %d (packetSize=%d)", socketIDStr, newVersion.Version, len(encryptedMessage))
				break
			}
		}
	} else {
		log.Printf("[%s] ✗ Room %s not found or has no messages", socketIDStr, originalRoom)
	}
	if !foundTargetMessage {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Grant access target message not found in room %s ts=%d", socketIDStr, originalRoom, messageTimestamp)
		return
	}

	// Get original sender while we still have the lock
	originalSenderForDM := ""
	originalSenderID := ""
	if messages, exists := cs.messages[originalRoom]; exists {
		for _, msg := range messages {
			if msg.Timestamp == messageTimestamp && msg.UserID == auth.UserID {
				originalSenderForDM = msg.UserID
				originalSenderID = msg.UserID
				log.Printf("[%s] ✓ Found original sender: %s", socketIDStr, originalSenderForDM)
				break
			}
		}
		if originalSenderForDM == "" {
			log.Printf("[%s] ✗ Could not find original sender for timestamp %d", socketIDStr, messageTimestamp)
		}
	}

	dmRoom := buildCanonicalDMRoom(requestingUserID, originalSenderID)
	log.Printf("[%s] Original sender for DM: %s, DM room: %s", socketIDStr, originalSenderForDM, dmRoom)

	if originalSenderForDM != "" {
		if dmRoomMessages, exists := cs.messages[dmRoom]; exists {
			for i := range dmRoomMessages {
				if len(dmRoomMessages[i].VisibleTo) == 1 && dmRoomMessages[i].VisibleTo[0] == originalSenderID && strings.Contains(dmRoomMessages[i].Content, "requests access") {
					if !strings.Contains(dmRoomMessages[i].Content, "[Access Granted]") {
						dmRoomMessages[i].Content = strings.Replace(
							dmRoomMessages[i].Content,
							"requests access",
							"requests access [Access Granted]",
							1,
						)
						log.Printf("[%s] ✓ Updated access request message to show grant in %s", socketIDStr, dmRoom)
					}
				}
				if len(dmRoomMessages[i].VisibleTo) == 1 && dmRoomMessages[i].VisibleTo[0] == requestingUserID && strings.Contains(dmRoomMessages[i].Content, "You requested access") {
					dmRoomMessages[i].Content = strings.Replace(
						dmRoomMessages[i].Content,
						"[Pending]",
						"[Access Granted]",
						1,
					)
					log.Printf("[%s] ✓ Updated requesting user status message to show grant in %s", socketIDStr, dmRoom)
				}
			}
		}
	}
	cs.mu.Unlock()
	log.Printf("[%s] Lock released after all updates", socketIDStr)

	// Notify both users with filtered message updates
	if defaultNsp != nil {
		cs.mu.RLock()
		// Get updated messages for the original room
		// Deep copy to ensure encryptedFor is included
		messagesCopy := make([]Message, len(cs.messages[originalRoom]))
		for i, msg := range cs.messages[originalRoom] {
			messagesCopy[i] = Message{
				ID:               msg.ID,
				Timestamp:        msg.Timestamp,
				Username:         msg.Username,
				UserID:           msg.UserID,
				RoomID:           msg.RoomID,
				Content:          msg.Content, // This will be empty for encrypted messages
				EncryptedMessage: msg.EncryptedMessage,
				EncryptedFor:     make(map[string]string),
				Versions:         msg.Versions,
				CurrentVersion:   msg.CurrentVersion,
				VisibleTo:        msg.VisibleTo,
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
					}(), len(msg.Versions) > 0)
				if len(msg.Versions) > 0 {
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
			cs.messages[dmRoom],
			originalSenderID,
		)
		dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
			cs.messages[dmRoom],
			requestingUserID,
		)

		cs.mu.RUnlock()

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
				if msg.EncryptedFor == nil {
					log.Printf("[%s] ⚠ WARNING: Target message has empty encryptedFor! This should not happen!", socketIDStr)
				}
			}
		}

		// Send to original sender: original room + their DM room
		responseForOriginalSender := map[string]interface{}{
			"accessGrant": map[string]interface{}{
				"originalRoom":     originalRoom,
				"originalRoomId":   cs.ensureRoomID(originalRoom),
				"messageTimestamp": messageTimestamp,
				"encryptedMessage": encryptedMessage,
			},
			"messages": map[string][]Message{
				originalRoom: messagesCopy,
				dmRoom:       dmRoomMessagesForOriginalSender,
			},
			"rooms": cs.rooms,
		}
		log.Printf("[%s] Sending to original sender: %s", socketIDStr, originalSenderForDM)
		cs.sendToUserIDs(defaultNsp, []string{originalSenderID}, EventServerMessage, responseForOriginalSender)

		// Send to requesting user: original room + their DM room
		responseForRequestingUser := map[string]interface{}{
			"accessGrant": map[string]interface{}{
				"originalRoom":     originalRoom,
				"originalRoomId":   cs.ensureRoomID(originalRoom),
				"messageTimestamp": messageTimestamp,
				"encryptedMessage": encryptedMessage,
			},
			"messages": map[string][]Message{
				originalRoom: messagesCopy,
				dmRoom:       dmRoomMessagesForRequestingUser,
			},
			"rooms": cs.rooms,
		}
		log.Printf("[%s] About to send to requesting user: %s", socketIDStr, requestingUser)
		log.Printf("[%s] Checking if requesting user is in users map...", socketIDStr)
		cs.mu.RLock()
		if socketIDForRequestingUser, exists := cs.userSocketsByID[requestingUserID]; exists {
			log.Printf("[%s] ✓ Requesting user %s found in users map with socketID: %s", socketIDStr, requestingUser, socketIDForRequestingUser)
		} else {
			log.Printf("[%s] ✗ Requesting user %s NOT found in users map!", socketIDStr, requestingUser)
			log.Printf("[%s] Available users in map: %v", socketIDStr, func() []string {
				users := make([]string, 0, len(cs.userSocketsByID))
				for u := range cs.userSocketsByID {
					users = append(users, u)
				}
				return users
			}())
		}
		cs.mu.RUnlock()
		log.Printf("[%s] Sending to requesting user: %s", socketIDStr, requestingUser)
		cs.sendToUserIDs(defaultNsp, []string{requestingUserID}, EventServerMessage, responseForRequestingUser)

		log.Printf("[%s] ✓ Access grant notifications sent to %s and %s", socketIDStr, originalSenderForDM, requestingUser)
	} else {
		log.Printf("[%s] ✗ defaultNsp is nil, cannot send access grant notification", socketIDStr)
	}

}

func (cs *ChatServer) handleDenyAccess(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_DENY_ACCESS: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_DENY_ACCESS EVENT ======", socketIDStr)

	denyMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid deny access format", socketIDStr)
		return
	}
	_, verified := cs.verifySignedMutation(socket, denyMap, EventClientDenyAccess, []string{"requestingUserId", "originalRoomId", "messageTimestamp"})
	if !verified {
		return
	}

	requestingUser := cs.resolveUsernameFromPayload(denyMap, "requestingUserId")
	requestingUserID := parseStringField(denyMap, "requestingUserId")
	originalRoom := cs.resolveRoomFromPayload(denyMap, "originalRoomId")
	originalRoomID := parseStringField(denyMap, "originalRoomId")

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

	if requestingUser == "" || requestingUserID == "" || originalRoomID == "" || originalRoom == "" {
		log.Printf("[%s] ✗ Missing required fields in deny access", socketIDStr)
		return
	}
	if !cs.roomPayloadConsistent(originalRoom, originalRoomID) || !cs.roomExists(originalRoom) {
		log.Printf("[%s] ✗ Rejected deny access for invalid room identity room=%s roomId=%s", socketIDStr, originalRoom, originalRoomID)
		return
	}

	log.Printf("[%s] Denying access: user=%s, room=%s, timestamp=%d", socketIDStr, requestingUser, originalRoom, messageTimestamp)

	// Find the original sender to determine DM room names
	cs.mu.RLock()
	originalSender := ""
	originalSenderID := ""
	if originalRoomMessages, exists := cs.messages[originalRoom]; exists {
		for _, msg := range originalRoomMessages {
			if msg.Timestamp == messageTimestamp {
				originalSender = msg.UserID
				originalSenderID = msg.UserID
				break
			}
		}
	}
	cs.mu.RUnlock()

	if originalSender == "" {
		log.Printf("[%s] ✗ Could not find original sender for message", socketIDStr)
		return
	}

	dmRoom := buildCanonicalDMRoom(requestingUserID, originalSenderID)

	cs.mu.Lock()
	// Update original sender's room (@requestingUser)
	if dmRoomMessages, exists := cs.messages[dmRoom]; exists {
		for i := range dmRoomMessages {
			if len(dmRoomMessages[i].VisibleTo) == 1 && dmRoomMessages[i].VisibleTo[0] == originalSenderID && strings.Contains(dmRoomMessages[i].Content, "requests access") {
				dmRoomMessages[i].Content = strings.Replace(
					dmRoomMessages[i].Content,
					"requests access",
					"requests access [Access Denied]",
					1,
				)
				log.Printf("[%s] ✓ Updated access request message to show denial in %s", socketIDStr, dmRoom)
			}
		}
	}
	if dmRoomMessages, exists := cs.messages[dmRoom]; exists {
		for i := range dmRoomMessages {
			if len(dmRoomMessages[i].VisibleTo) == 1 && dmRoomMessages[i].VisibleTo[0] == requestingUserID && strings.Contains(dmRoomMessages[i].Content, "You requested access") {
				dmRoomMessages[i].Content = strings.Replace(
					dmRoomMessages[i].Content,
					"[Pending]",
					"[Access Denied]",
					1,
				)
				log.Printf("[%s] ✓ Updated requesting user status message to show denial in %s", socketIDStr, dmRoom)
			}
		}
	}
	cs.mu.Unlock()

	// Send updated DM room messages only to the intended recipients
	if defaultNsp != nil {
		cs.mu.RLock()
		dmRoomMessagesForOriginalSender := filterMessagesByVisibility(
			cs.messages[dmRoom],
			originalSenderID,
		)
		dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
			cs.messages[dmRoom],
			requestingUserID,
		)
		cs.mu.RUnlock()

		// Send to original sender
		responseForOriginalSender := map[string]interface{}{
			"messages": map[string][]Message{dmRoom: dmRoomMessagesForOriginalSender},
			"rooms":    cs.rooms,
		}
		cs.sendToUserIDs(defaultNsp, []string{originalSenderID}, EventServerMessage, responseForOriginalSender)

		// Send to requesting user
		responseForRequestingUser := map[string]interface{}{
			"messages": map[string][]Message{dmRoom: dmRoomMessagesForRequestingUser},
			"rooms":    cs.rooms,
		}
		cs.sendToUserIDs(defaultNsp, []string{requestingUserID}, EventServerMessage, responseForRequestingUser)
	}

	// Notify the requesting user
	if defaultNsp != nil {
		denialData := map[string]interface{}{
			"accessDenied": map[string]interface{}{
				"originalRoom":     originalRoom,
				"messageTimestamp": messageTimestamp,
			},
		}
		cs.emitNamespaceSigned(defaultNsp, EventServerAccessDenied, denialData)
		log.Printf("[%s] ✓ Access denial notification sent to %s", socketIDStr, requestingUser)
	} else {
		log.Printf("[%s] ✗ defaultNsp is nil, cannot send access denial notification", socketIDStr)
	}

}

func (cs *ChatServer) handleVoteJoin(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_VOTE_JOIN: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_VOTE_JOIN EVENT ======", socketIDStr)

	voteMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid vote format", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, voteMap, EventClientVoteJoin, []string{"roomId", "requestingUserId", "voterUserId", "vote"})
	if !verified {
		return
	}
	voteMap["voterUserId"] = auth.UserID

	room := cs.resolveRoomFromPayload(voteMap, "roomId")
	roomID := parseStringField(voteMap, "roomId")
	requestingUser := cs.resolveUsernameFromPayload(voteMap, "requestingUserId")
	requestingUserID := parseStringField(voteMap, "requestingUserId")
	vote, _ := voteMap["vote"].(bool) // true = accept, false = deny
	voter := cs.resolveUsernameFromPayload(voteMap, "voterUserId")
	voterUserID := parseStringField(voteMap, "voterUserId")

	if room == "" || roomID == "" || requestingUser == "" || requestingUserID == "" || voterUserID == "" {
		log.Printf("[%s] ✗ Missing required fields in vote", socketIDStr)
		return
	}
	if !cs.roomPayloadConsistent(room, roomID) || !cs.roomExists(room) {
		log.Printf("[%s] ✗ Rejected vote-join for invalid room identity room=%s roomId=%s", socketIDStr, room, roomID)
		return
	}

	requestKey := fmt.Sprintf("%s:%s", roomID, requestingUserID)
	cs.mu.Lock()
	req, exists := cs.joinRequests[requestKey]
	if !exists {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Join request not found: %s", socketIDStr, requestKey)
		return
	}

	// Record vote
	req.Votes[voterUserID] = vote
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
	roomMemberCount := len(cs.roomMembers[roomID])

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
		if cs.roomMembers[roomID] == nil {
			cs.roomMembers[roomID] = make(map[string]bool)
		}
		cs.roomMembers[roomID][requestingUserID] = true

		// Post join message (system message, not editable)
		targetRoom, targetRoomID := cs.systemMessageRoomLocked(room)
		joinMsg := Message{
			ID:        uuid.NewString(),
			Timestamp: time.Now().Unix(),
			Username:  "system",
			UserID:    SystemUserID,
			RoomID:    targetRoomID,
			Content:   fmt.Sprintf("%s %s", formatSystemUserRef(requestingUserID), UserJoined),
			Edited:    false, // System messages can't be edited
		}
		if cs.messages[targetRoom] == nil {
			cs.messages[targetRoom] = []Message{}
		}
		cs.messages[targetRoom] = append([]Message{joinMsg}, cs.messages[targetRoom]...)

		// Remove join request
		delete(cs.joinRequests, requestKey)

		cs.mu.Unlock()

		// Broadcast approval
		approvalData := map[string]interface{}{
			"type":             "joinApproved",
			"requestingUserId": requestingUserID,
			"room":             room,
			"roomId":           roomID,
		}
		cs.emitNamespaceSigned(defaultNsp, EventServerJoinApproved, approvalData)

		// Broadcast updated message
		// Don't include users field - we're not updating the user list here
		response := map[string]interface{}{
			"messages": map[string][]Message{targetRoom: cs.messages[targetRoom]},
			"rooms":    cs.rooms,
			// Don't send users field - it would overwrite the client's user list
		}
		cs.emitNamespaceSigned(defaultNsp, EventServerMessage, response)

		log.Printf("[%s] ✓ Join request approved for %s to join %s", socketIDStr, requestingUser, room)
	} else if denied {
		// Remove join request
		delete(cs.joinRequests, requestKey)

		// Post denial message
		targetRoom, targetRoomID := cs.systemMessageRoomLocked(room)
		denialMsg := Message{
			ID:        uuid.NewString(),
			Timestamp: time.Now().Unix(),
			Username:  "system",
			UserID:    SystemUserID,
			RoomID:    targetRoomID,
			Content:   fmt.Sprintf("%s was denied access to this room", formatSystemUserRef(requestingUserID)),
		}
		if cs.messages[targetRoom] == nil {
			cs.messages[targetRoom] = []Message{}
		}
		cs.messages[targetRoom] = append([]Message{denialMsg}, cs.messages[targetRoom]...)

		cs.mu.Unlock()

		// Broadcast denial
		denialData := map[string]interface{}{
			"type":             "joinDenied",
			"requestingUserId": requestingUserID,
			"room":             room,
			"roomId":           roomID,
		}
		cs.emitNamespaceSigned(defaultNsp, EventServerJoinDenied, denialData)

		// Broadcast updated message
		// Don't include users field - we're not updating the user list here
		response := map[string]interface{}{
			"messages": map[string][]Message{targetRoom: cs.messages[targetRoom]},
			"rooms":    cs.rooms,
			// Don't send users field - it would overwrite the client's user list
		}
		cs.emitNamespaceSigned(defaultNsp, EventServerMessage, response)

		log.Printf("[%s] ✗ Join request denied for %s to join %s", socketIDStr, requestingUser, room)
	} else {
		cs.mu.Unlock()
		log.Printf("[%s] Vote recorded, waiting for more votes (accepts: %d/%d, denials: %d)", socketIDStr, accepts, threshold, denials)
	}

}
