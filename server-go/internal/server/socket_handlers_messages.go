package server

import (
	"fmt"
	"log"
	"strings"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/google/uuid"
)

func (cs *ChatServer) handleClientMessage(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_MESSAGE (per-socket) handler: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_MESSAGE EVENT (per-socket) ======", socketIDStr)

	dataMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid message format received, type: %T", socketIDStr, data)
		return
	}
	if rawContent, hasContent := dataMap["content"].(string); hasContent && strings.TrimSpace(rawContent) != "" {
		log.Printf("[%s] ✗ Rejected plaintext content in CLIENT_MESSAGE", socketIDStr)
		emitActionResult(socket, "send", false, "invalid_request", "Plaintext content is not allowed")
		return
	}
	auth, verified := cs.verifySignedMutation(socket, dataMap, EventClientMessage, []string{"roomId"})
	if !verified {
		return
	}
	dataMap["userId"] = auth.UserID

	room := cs.resolveRoomFromPayload(dataMap, "roomId")
	roomID := parseStringField(dataMap, "roomId")
	requestedRoomHint := parseStringField(dataMap, "room")
	username := cs.resolveUsernameFromPayload(dataMap, "userId")
	actorUserID := parseStringField(dataMap, "userId")
	content, _ := dataMap["content"].(string)
	replyToRaw, hasReplyTo := dataMap["replyTo"]
	encryptedMessage, _ := dataMap["encryptedMessage"].(string)

	if room == "" && requestedRoomHint != "" {
		room = requestedRoomHint
	}

	if roomID == "" && room != "" {
		roomID = room
	}

	if roomHintA, roomHintB, ok := parseDMParticipants(requestedRoomHint); ok && (actorUserID == roomHintA || actorUserID == roomHintB) {
		cs.mu.Lock()
		if dmRoom, dmRoomID, _ := cs.ensureCanonicalDMRoomLocked(requestedRoomHint, actorUserID); dmRoom != "" {
			room = dmRoom
			roomID = dmRoomID
		}
		cs.mu.Unlock()
	}

	if roomID == "" || actorUserID == "" || room == "" || username == "" {
		log.Printf("[%s] ✗ Missing required identity fields in message payload", socketIDStr)
		emitActionResult(socket, "send", false, "invalid_request", "Missing required identity fields")
		return
	}

	if exceedsMessageTextLimit(content) {
		log.Printf("[%s] ✗ Rejected oversized plaintext message from %s (%d bytes)", socketIDStr, username, len([]byte(content)))
		emitActionResult(
			socket,
			"send",
			false,
			"message_too_large",
			fmt.Sprintf("Message exceeds max size (%d bytes)", maxMessageTextBytes),
		)
		return
	}

	if encryptedMessage != "" && exceedsMessageCiphertextLimit(encryptedMessage) {
		log.Printf("[%s] ✗ Rejected oversized encrypted message from %s (%d bytes)", socketIDStr, username, len([]byte(encryptedMessage)))
		emitActionResult(
			socket,
			"send",
			false,
			"message_too_large",
			fmt.Sprintf("Encrypted message exceeds max size (%d bytes)", maxMessageCiphertextBytes),
		)
		return
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

	log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, contentPresent=%v, HasEncryptedPacket: %v, ReplyTo: %v", socketIDStr, username, room, strings.TrimSpace(content) != "", encryptedMessage != "", replyTo)

	if !isRoomVisibleToUser(cs.messages, room, actorUserID) {
		log.Printf("[%s] ✗ Rejected DM send by non-participant user=%s room=%s", socketIDStr, username, room)
		return
	}

	// Set user when they send a message
	userJustRegistered := false
	if actorUserID != "" {
		cs.mu.Lock()
		existingSessionID, userExists := cs.users[actorUserID]
		cs.mu.Unlock()
		log.Printf("[%s] Checking user registration - exists: %v, existing ID: %s, current ID: %s", socketIDStr, userExists, existingSessionID, socketIDStr)
		if !userExists || existingSessionID != socketIDStr {
			cs.setUser(actorUserID, socketIDStr)
			cs.mu.Lock()
			cs.userSocketsByID[actorUserID] = socketIDStr
			cs.mu.Unlock()
			userJustRegistered = true
			log.Printf("[%s] ✓ User %s registered with connection ID %s", socketIDStr, actorUserID, socketIDStr)
		} else {
			log.Printf("[%s] User %s already registered", socketIDStr, actorUserID)
		}
	} else {
		log.Printf("[%s] ✗ No userId in message", socketIDStr)
	}

	cs.mu.Lock()
	if cs.messages[room] == nil {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Rejected message for unknown room %s", socketIDStr, room)
		emitActionResult(socket, "send", false, "invalid_room", "Unknown room")
		return
	}
	if !contains(cs.rooms, room) {
		cs.rooms = append(cs.rooms, room)
	}

	// Reject join messages from clients - server sends these automatically
	if content == UserJoined {
		log.Printf("[%s] ✗ Rejecting client-sent join message from %s - server sends these automatically", socketIDStr, username)
		cs.mu.Unlock()
		return
	}

	// Join message should already be sent or scheduled on login via setUser
	// DO NOT add join message here - it should already exist from login
	// If it doesn't exist and it's not scheduled, log a warning.
	if actorUserID != "" && !cs.hasSentJoinMsg[actorUserID] && !cs.joinScheduled[actorUserID] {
		log.Printf("[%s] ⚠ WARNING: Join message not sent for %s during login! This should not happen.", socketIDStr, actorUserID)
		// Don't add join message here - it will cause issues
		// Instead, just log the warning and continue with the user's message
	}

	// Update user last seen
	cs.userLastSeen[actorUserID] = time.Now().Unix()

	beforeCount := len(cs.messages[room])

	// Normal message handling (join messages are rejected earlier)
	// Auto-upvote own message
	one := 1
	if actorUserID == "" {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Missing actor userId", socketIDStr)
		return
	}
	roomID = cs.ensureRoomIDLocked(room)
	userVotes := make(map[string]string)
	userVotes[actorUserID] = "up"
	newMessage := Message{
		ID:               uuid.NewString(),
		Timestamp:        time.Now().Unix(),
		Username:         username,
		UserID:           actorUserID,
		RoomID:           roomID,
		Content:          content,
		EncryptedMessage: encryptedMessage,
		EncryptedFor:     nil,
		ReplyTo:          replyTo,
		VoteTotal:        &one,
		UserVotes:        userVotes,
	}
	cs.messages[room] = append([]Message{newMessage}, cs.messages[room]...)

	log.Printf("[%s] Added message to room %s (was %d, now has %d messages)", socketIDStr, room, beforeCount, len(cs.messages[room]))
	roomNameHash := ""
	for candidateHash, candidateRoomID := range cs.roomNameHashes {
		if candidateRoomID == roomID {
			roomNameHash = candidateHash
			break
		}
	}
	persistenceMetadata := MessagePersistenceMetadata{
		RoomKey:                room,
		RoomNameHash:           roomNameHash,
		RoomNameCiphertext:     cs.roomNameCiphertexts[roomID],
		RoomDirectoryUpdatedAt: cs.roomDirectoryUpdatedAt[roomID],
		UserPublicKey:          cs.userPubKeys[actorUserID],
		UserPublicKeyUpdatedAt: cs.userPubKeysUpdatedAt[actorUserID],
		UsernameCiphertext:     cs.usernameCiphertexts[actorUserID],
		UserDirectoryUpdatedAt: cs.userDirectoryUpdatedAt[actorUserID],
	}
	cs.mu.Unlock()

	if err := cs.store.SaveMessage(newMessage, persistenceMetadata); err != nil {
		log.Printf("[%s] ✗ Failed to persist message: %v", socketIDStr, err)
	}

	cs.mu.Lock() // Re-acquire lock for response preparation

	// Get current state for response while holding the lock.
	messagesCopy, roomsCopy, usersList, userPubKeysCopy := cs.snapshotMessageContextLocked()
	userPubKeysUpdatedAtCopy := cloneInt64Map(cs.userPubKeysUpdatedAt)
	cs.mu.Unlock()

	log.Printf("[%s] Prepared response - rooms: %d, users: %d, message rooms: %d", socketIDStr, len(roomsCopy), len(usersList), len(messagesCopy))

	// If this is the user's first message (just registered), send initial data
	if userJustRegistered {
		roomsCopy = filterRoomsForUser(roomsCopy, messagesCopy, actorUserID)
		// Get logged-in and active user lists
		loggedInUsers, activeUsers := cs.getUserLists()

		initialData := map[string]interface{}{
			"messages":               messagesCopy,
			"rooms":                  roomsCopy,
			"loggedInUsers":          loggedInUsers,
			"activeUsers":            activeUsers,
			"userPubKeys":            userPubKeysCopy,
			"userPubKeysUpdatedAt":   userPubKeysUpdatedAtCopy,
			"roomNameCiphertexts":    cs.roomNameCiphertextsForRooms(roomsCopy),
			"roomDirectoryUpdatedAt": cs.roomDirectoryUpdatedAtForRooms(roomsCopy),
		}
		log.Printf("[%s] ✓ User just registered, sending INITIAL_DATA to %s", socketIDStr, actorUserID)
		cs.emitSocketSigned(socket, EventInitialData, initialData)
		log.Printf("[%s] ✓ INITIAL_DATA sent to newly registered user", socketIDStr)
	}

	// Prepare delta response with only the new message.
	response := map[string]interface{}{
		"messages": map[string][]Message{room: {newMessage}},
	}
	cs.attachIdentityDirectories(response)

	log.Printf("[%s] Broadcasting SERVER_MESSAGE - rooms: %d, users: %d", socketIDStr, len(messagesCopy), len(usersList))

	if userAID, userBID, ok := parseDMParticipants(room); ok {
		roomNames := []string{room}
		response["rooms"] = roomNames
		response["roomNameCiphertexts"] = cs.roomNameCiphertextsForRooms(roomNames)
		response["roomDirectoryUpdatedAt"] = cs.roomDirectoryUpdatedAtForRooms(roomNames)
		cs.sendToUserIDs(defaultNsp, []string{userAID, userBID}, EventServerMessage, response)
		// Ensure the sender always gets immediate local echo even if user-id routing mismatches.
		cs.emitSocketSigned(socket, EventServerMessage, response)
		log.Printf("[%s] ✓ Sent DM message only to participants: %s, %s", socketIDStr, userAID, userBID)
	} else {
		// Broadcast to all clients (excluding sender)
		cs.emitBroadcastSigned(socket.Broadcast(), EventServerMessage, response)
		log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)

		// Also emit directly to sender so they see their own messages
		cs.emitSocketSigned(socket, EventServerMessage, response)
	}
	log.Printf("[%s] ✓ Emitted message update, CLIENT_MESSAGE handler complete", socketIDStr)

}

func (cs *ChatServer) handleVoteMessage(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_VOTE_MESSAGE (per-socket) handler: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_VOTE_MESSAGE EVENT (per-socket) ======", socketIDStr)

	voteMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid vote data format, type: %T", socketIDStr, data)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, voteMap, EventClientVoteMessage, []string{"roomId", "messageTimestamp", "voteType"})
	if !verified {
		return
	}
	voteMap["userId"] = auth.UserID

	room := cs.resolveRoomFromPayload(voteMap, "roomId")
	roomID := parseStringField(voteMap, "roomId")
	username := cs.resolveUsernameFromPayload(voteMap, "userId")
	actorUserID := parseStringField(voteMap, "userId")
	voteTypeRaw, hasVoteType := voteMap["voteType"]
	messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(voteMap)

	if (!hasMessageID && !hasTimestamp) || !hasVoteType || actorUserID == "" || roomID == "" || room == "" || username == "" {
		log.Printf("[%s] ✗ Missing required vote fields", socketIDStr)
		return
	}
	if !cs.roomPayloadConsistent(room, roomID) || !cs.roomExists(room) {
		log.Printf("[%s] ✗ Rejected vote for invalid room identity room=%s roomId=%s", socketIDStr, room, roomID)
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

	targetIndex := findMessageIndex(messages, messageID, messageTimestamp)
	if targetIndex < 0 {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Message not found in room %s (id=%s, ts=%d)", socketIDStr, room, messageID, messageTimestamp)
		return
	}

	targetMessage := &messages[targetIndex]

	// Initialize vote fields if needed
	if targetMessage.UserVotes == nil {
		targetMessage.UserVotes = make(map[string]string)
	}
	if targetMessage.VoteTotal == nil {
		zero := 0
		targetMessage.VoteTotal = &zero
	}

	// Get current vote for this user
	currentVote, hasVote := targetMessage.UserVotes[actorUserID]

	// Handle vote logic
	if hasVote && currentVote == voteType {
		// User is clicking the same vote again - remove it
		delete(targetMessage.UserVotes, actorUserID)
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
		targetMessage.UserVotes[actorUserID] = voteType
		if voteType == "up" {
			*targetMessage.VoteTotal++
		} else {
			*targetMessage.VoteTotal--
		}
		log.Printf("[%s] ✓ Switched vote from %s to %s for message %d by %s (new total: %d)", socketIDStr, currentVote, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
	} else {
		// User is voting for the first time
		targetMessage.UserVotes[actorUserID] = voteType
		if voteType == "up" {
			*targetMessage.VoteTotal++
		} else {
			*targetMessage.VoteTotal--
		}
		log.Printf("[%s] ✓ Added %s vote to message %d by %s (new total: %d)", socketIDStr, voteType, messageTimestamp, username, *targetMessage.VoteTotal)
	}

	messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy := cs.snapshotStateForSaveLocked()

	cs.mu.Unlock()

	// Save state to disk
	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
		log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
	}

	response := map[string]interface{}{
		"messages": map[string][]Message{room: {*targetMessage}},
	}
	cs.attachIdentityDirectories(response)

	// Broadcast to all clients
	cs.emitNamespaceSigned(defaultNsp, EventServerVoteUpdate, response)
	log.Printf("[%s] ✓ Broadcasted vote update", socketIDStr)

}

func (cs *ChatServer) handleEditMessage(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] ✗ PANIC in CLIENT_EDIT_MESSAGE (per-socket) handler: %v", socketIDStr, r)
		}
	}()
	log.Printf("[%s] ===== CLIENT_EDIT_MESSAGE EVENT (per-socket) ======", socketIDStr)

	editMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid edit data format, type: %T", socketIDStr, data)
		return
	}
	if rawContent, hasContent := editMap["content"].(string); hasContent && strings.TrimSpace(rawContent) != "" {
		log.Printf("[%s] ✗ Rejected plaintext content in CLIENT_EDIT_MESSAGE", socketIDStr)
		emitActionResult(socket, "edit", false, "invalid_request", "Plaintext content is not allowed")
		return
	}
	auth, verified := cs.verifySignedMutation(socket, editMap, EventClientEditMessage, []string{"userId", "roomId", "messageTimestamp", "encryptedMessage"})
	if !verified {
		return
	}
	editMap["userId"] = auth.UserID
	editMap["sessionId"] = auth.SessionID

	room := cs.resolveRoomFromPayload(editMap, "roomId")
	roomID := parseStringField(editMap, "roomId")
	username := cs.resolveUsernameFromPayload(editMap, "userId")
	actorUserID := parseStringField(editMap, "userId")
	sessionID, _ := editMap["sessionId"].(string)
	encryptedMessage, _ := editMap["encryptedMessage"].(string)
	messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(editMap)

	if encryptedMessage != "" && exceedsMessageCiphertextLimit(encryptedMessage) {
		log.Printf("[%s] ✗ Rejected oversized encrypted edit from %s (%d bytes)", socketIDStr, username, len([]byte(encryptedMessage)))
		emitActionResult(
			socket,
			"edit",
			false,
			"message_too_large",
			fmt.Sprintf("Encrypted message exceeds max size (%d bytes)", maxMessageCiphertextBytes),
		)
		return
	}

	if (!hasMessageID && !hasTimestamp) || actorUserID == "" || roomID == "" || room == "" || username == "" || sessionID == "" {
		log.Printf("[%s] ✗ Missing required edit fields", socketIDStr)
		emitActionResult(socket, "edit", false, "invalid_request", "Missing required edit fields")
		return
	}
	if !cs.roomPayloadConsistent(room, roomID) || !cs.roomExists(room) {
		log.Printf("[%s] ✗ Rejected edit for invalid room identity room=%s roomId=%s", socketIDStr, room, roomID)
		emitActionResult(socket, "edit", false, "invalid_room", "Unknown room")
		return
	}

	if !cs.isSessionAuthorizedForUser(sessionID, actorUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, actorUserID)
		log.Printf("[%s] ✗ Rejected edit attempt by %s (%s)", socketIDStr, username, code)
		emitActionResult(socket, "edit", false, code, message)
		return
	}

	cs.mu.Lock()

	// Find the message
	messages, exists := cs.messages[room]
	if !exists {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Room %s not found", socketIDStr, room)
		emitActionResult(socket, "edit", false, "not_found", "Room not found")
		return
	}

	targetIndex := findMessageIndex(messages, messageID, messageTimestamp)
	if targetIndex < 0 {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Message not found in room %s (id=%s, ts=%d)", socketIDStr, room, messageID, messageTimestamp)
		emitActionResult(socket, "edit", false, "not_found", "Message not found")
		return
	}

	targetMessage := &messages[targetIndex]

	// Validate that the editor is the original sender
	if targetMessage.UserID != actorUserID {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ User %s attempted to edit message by %s (unauthorized)", socketIDStr, actorUserID, targetMessage.UserID)
		emitActionResult(socket, "edit", false, "not_owner", "Not owner")
		return
	}

	// Prevent editing system messages
	if targetMessage.UserID == SystemUserID {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ User %s attempted to edit system message (not allowed)", socketIDStr, actorUserID)
		emitActionResult(socket, "edit", false, "not_allowed", "System messages cannot be edited")
		return
	}

	// Update the message
	targetMessage.Content = "" // Clear plaintext (encrypted only)
	targetMessage.EncryptedMessage = encryptedMessage
	targetMessage.EncryptedFor = nil
	targetMessage.Edited = true
	if actorUserID != "" {
		cs.userLastSeen[actorUserID] = time.Now().Unix()
	}

	log.Printf("[%s] ✓ Message %d edited by %s", socketIDStr, messageTimestamp, actorUserID)

	messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy := cs.snapshotStateForSaveLocked()

	userLastSeenCopy := make(map[string]int64)
	for user, lastSeen := range cs.userLastSeen {
		userLastSeenCopy[user] = lastSeen
	}

	cs.mu.Unlock()

	// Save state to disk
	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
		log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
	}

	response := map[string]interface{}{
		"messages": map[string][]Message{room: {*targetMessage}},
	}
	cs.attachIdentityDirectories(response)

	// Broadcast to all clients
	cs.emitNamespaceSigned(defaultNsp, EventServerMessage, response)
	log.Printf("[%s] ✓ Broadcasted message edit update", socketIDStr)
	cs.broadcastUserListUpdate()
	emitActionResult(socket, "edit", true, "ok", "Message updated")

}

func (cs *ChatServer) handleDeleteMessage(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	log.Printf("[%s] ===== CLIENT_DELETE_MESSAGE EVENT (per-socket) ======", socketIDStr)

	deleteMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid delete data format, type: %T", socketIDStr, data)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, deleteMap, EventClientDeleteMessage, []string{"userId", "roomId", "messageTimestamp"})
	if !verified {
		return
	}
	deleteMap["userId"] = auth.UserID
	deleteMap["sessionId"] = auth.SessionID

	room := cs.resolveRoomFromPayload(deleteMap, "roomId")
	roomID := parseStringField(deleteMap, "roomId")
	username := cs.resolveUsernameFromPayload(deleteMap, "userId")
	actorUserID := parseStringField(deleteMap, "userId")
	sessionID, _ := deleteMap["sessionId"].(string)
	messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(deleteMap)

	if (!hasMessageID && !hasTimestamp) || actorUserID == "" || roomID == "" || room == "" || username == "" || sessionID == "" {
		log.Printf("[%s] ✗ Missing required delete fields", socketIDStr)
		emitActionResult(socket, "delete", false, "invalid_request", "Missing required delete fields")
		return
	}
	if !cs.roomPayloadConsistent(room, roomID) || !cs.roomExists(room) {
		log.Printf("[%s] ✗ Rejected delete for invalid room identity room=%s roomId=%s", socketIDStr, room, roomID)
		emitActionResult(socket, "delete", false, "invalid_room", "Unknown room")
		return
	}

	if !cs.isSessionAuthorizedForUser(sessionID, actorUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, actorUserID)
		log.Printf("[%s] ✗ Rejected delete attempt by %s (%s)", socketIDStr, username, code)
		emitActionResult(socket, "delete", false, code, message)
		return
	}

	cs.mu.Lock()
	messages, exists := cs.messages[room]
	if !exists {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Room %s not found for delete", socketIDStr, room)
		emitActionResult(socket, "delete", false, "not_found", "Room not found")
		return
	}

	targetIndex := findMessageIndex(messages, messageID, messageTimestamp)
	if targetIndex < 0 {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ Message not found in room %s (id=%s, ts=%d)", socketIDStr, room, messageID, messageTimestamp)
		emitActionResult(socket, "delete", false, "not_found", "Message not found")
		return
	}

	targetMessage := &messages[targetIndex]
	if targetMessage.Deleted {
		cs.mu.Unlock()
		emitActionResult(socket, "delete", true, "ok", "Message deleted")
		return
	}

	if targetMessage.UserID != actorUserID {
		cs.mu.Unlock()
		log.Printf("[%s] ✗ User %s attempted to delete message by %s (unauthorized)", socketIDStr, actorUserID, targetMessage.UserID)
		emitActionResult(socket, "delete", false, "not_owner", "Not owner")
		return
	}

	if targetMessage.UserID == SystemUserID {
		cs.mu.Unlock()
		emitActionResult(socket, "delete", false, "not_allowed", "System messages cannot be deleted")
		return
	}

	targetMessage.Content = "Message deleted"
	targetMessage.EncryptedMessage = ""
	targetMessage.EncryptedFor = nil
	targetMessage.Versions = nil
	targetMessage.CurrentVersion = nil
	targetMessage.VisibleTo = nil
	targetMessage.VoteTotal = nil
	targetMessage.UserVotes = nil
	targetMessage.Edited = false
	targetMessage.Deleted = true
	if actorUserID != "" {
		cs.userLastSeen[actorUserID] = time.Now().Unix()
	}

	messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy := cs.snapshotStateForSaveLocked()

	updatedMessage := *targetMessage
	cs.mu.Unlock()

	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
		log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
	}

	response := map[string]interface{}{
		"messages": map[string][]Message{room: {updatedMessage}},
	}
	cs.emitNamespaceSigned(defaultNsp, EventServerMessage, response)
	cs.broadcastUserListUpdate()
	emitActionResult(socket, "delete", true, "ok", "Message deleted")
	log.Printf("[%s] ✓ Broadcasted message delete update", socketIDStr)

}
