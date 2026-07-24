package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	socketio "github.com/karagenc/socket.io-go"
)

func parseMessageReference(raw map[string]interface{}) (string, int64, bool, bool) {
	messageID := ""
	if rawID, ok := raw["messageId"]; ok {
		if id, ok := rawID.(string); ok {
			messageID = strings.TrimSpace(id)
		}
	}

	var messageTimestamp int64
	hasTimestamp := false
	if rawTimestamp, ok := raw["messageTimestamp"]; ok {
		switch value := rawTimestamp.(type) {
		case float64:
			messageTimestamp = int64(value)
			hasTimestamp = true
		case int64:
			messageTimestamp = value
			hasTimestamp = true
		case int:
			messageTimestamp = int64(value)
			hasTimestamp = true
		}
	}

	return messageID, messageTimestamp, messageID != "", hasTimestamp
}

func findMessageIndex(messages []Message, messageID string, messageTimestamp int64) int {
	if messageID != "" {
		for i := range messages {
			if messages[i].ID == messageID {
				return i
			}
		}
	}

	for i := range messages {
		if messages[i].Timestamp == messageTimestamp {
			return i
		}
	}

	return -1
}

func parseStringList(raw interface{}) []string {
	items, ok := raw.([]interface{})
	if !ok {
		return nil
	}

	result := make([]string, 0, len(items))
	seen := make(map[string]struct{})
	for _, item := range items {
		value, ok := item.(string)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}

	return result
}

func buildScopedMessagesForUser(all Messages, username, defaultRoom, currentRoom string, openRooms []string) Messages {
	targetRooms := make(map[string]struct{})
	if defaultRoom != "" {
		targetRooms[defaultRoom] = struct{}{}
	}
	if currentRoom != "" {
		targetRooms[currentRoom] = struct{}{}
	}
	for _, room := range openRooms {
		room = strings.TrimSpace(room)
		if room == "" {
			continue
		}
		targetRooms[room] = struct{}{}
	}

	result := make(Messages)
	for room := range targetRooms {
		if !isRoomVisibleToUser(room, username) {
			continue
		}
		messages, exists := all[room]
		if !exists {
			continue
		}
		visible := filterMessagesByVisibility(messages, username)
		if len(visible) > 0 {
			result[room] = visible
		}
	}

	return result
}

func isRoomVisibleToUser(room, username string) bool {
	userA, userB, ok := parseDMParticipants(room)
	if !ok {
		return true
	}
	return username == userA || username == userB
}

func filterRoomsForUser(rooms []string, username string) []string {
	filtered := make([]string, 0, len(rooms))
	for _, room := range rooms {
		if isRoomVisibleToUser(room, username) {
			filtered = append(filtered, room)
		}
	}
	return filtered
}

func parseDMParticipants(room string) (string, string, bool) {
	if !strings.HasPrefix(room, "@dm:") {
		return "", "", false
	}
	parts := strings.Split(room, ":")
	if len(parts) != 3 {
		return "", "", false
	}
	if strings.TrimSpace(parts[1]) == "" || strings.TrimSpace(parts[2]) == "" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func buildDMIntroMessage(room, requestingUser string) (Message, bool) {
	userA, userB, ok := parseDMParticipants(room)
	if !ok {
		return Message{}, false
	}

	otherUser := ""
	switch requestingUser {
	case userA:
		otherUser = userB
	case userB:
		otherUser = userA
	}
	if otherUser == "" {
		otherUser = userA
	}

	return Message{
		ID:        uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Username:  "system",
		Content:   fmt.Sprintf("You are at the beginning of an awesome conversation with %s", otherUser),
		Edited:    false,
	}, true
}

func buildCanonicalDMRoom(userA, userB string) string {
	first := strings.TrimSpace(userA)
	second := strings.TrimSpace(userB)
	if strings.ToLower(first) > strings.ToLower(second) {
		first, second = second, first
	}
	return formatRoomName(fmt.Sprintf("@dm:%s:%s", first, second))
}

func (cs *ChatServer) isSessionAuthorizedForUser(sessionID, username string) bool {
	if sessionID == "" || username == "" {
		return false
	}

	storedUsername, exists := cs.sessionCache.Get(sessionID)
	if !exists || storedUsername == "" {
		return false
	}

	return storedUsername == username
}

func (cs *ChatServer) getSessionAuthFailure(sessionID, username string) (string, string) {
	if sessionID == "" || username == "" {
		return "invalid_request", "Missing authentication fields"
	}

	storedUsername, exists := cs.sessionCache.Get(sessionID)
	if !exists || storedUsername == "" {
		return "session_expired", "Session expired"
	}

	if storedUsername != username {
		return "unauthorized", "Unauthorized"
	}

	return "", ""
}

func emitActionResult(
	socket socketio.ServerSocket,
	action string,
	success bool,
	code string,
	message string,
) {
	socket.Emit(EventServerActionResult, map[string]interface{}{
		"action":  action,
		"success": success,
		"code":    code,
		"message": message,
	})
}

func (cs *ChatServer) setupSocketHandlers(sio *socketio.Server) {
	log.Println("===== SETTING UP SOCKET HANDLERS =====")

	// Get the default namespace
	defaultNsp := sio.Of("/")

	cs.mu.Lock()
	cs.defaultNsp = defaultNsp
	cs.mu.Unlock()

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
		encryptedMessage, _ := msgMap["encryptedMessage"].(string)

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

		// Reject join messages from clients - server sends these automatically
		if content == UserJoined {
			log.Printf("[%s] ✗ Rejecting client-sent join message from %s - server sends these automatically", socketIDStr, username)
			return
		}

		// For encrypted messages, content may be empty - that's expected
		if encryptedMessage != "" {
			log.Printf("[%s] ✓ Parsed encrypted message - User: %s, Room: %s, packetSize=%d", socketIDStr, username, room, len(encryptedMessage))
		} else {
			log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s", socketIDStr, username, room, content)
		}

		if !isRoomVisibleToUser(room, username) {
			log.Printf("[%s] ✗ Rejected DM send by non-participant user=%s room=%s", socketIDStr, username, room)
			return
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

		// If user was just registered, wait for the join message to be sent
		// to prevent the first client message from being processed before the join
		if userJustRegistered {
			log.Printf("[%s] User just registered - waiting for join message to be sent", socketIDStr)
			for i := 0; i < 50; i++ { // Wait up to 5 seconds (50 * 100ms)
				cs.mu.RLock()
				joinSent := cs.hasSentJoinMsg[username]
				joinScheduled := cs.joinScheduled[username]
				cs.mu.RUnlock()

				if joinSent {
					log.Printf("[%s] ✓ Join message sent, proceeding with user message", socketIDStr)
					break
				}

				if !joinScheduled {
					// Join wasn't scheduled; this shouldn't happen but avoid infinite loop
					log.Printf("[%s] ⚠ Join message not scheduled; proceeding anyway", socketIDStr)
					break
				}

				time.Sleep(100 * time.Millisecond)
			}
		}

		cs.mu.Lock()
		if cs.messages[room] == nil {
			log.Printf("[%s] Creating new room: %s", socketIDStr, room)
			cs.messages[room] = []Message{}
		}

		// Join message should already be sent on login via setUser
		// DO NOT add join message here - it should already exist from login
		// If it doesn't exist, that's a bug that should be fixed, not worked around
		if username != "" && !cs.hasSentJoinMsg[username] {
			log.Printf("[%s] ⚠ WARNING: Join message not sent for %s during login! This should not happen.", socketIDStr, username)
			// Don't add join message here - it will cause issues
			// Instead, just log the warning and continue with the user's message
		}

		beforeCount := len(cs.messages[room])
		// Auto-upvote own message
		one := 1
		userVotes := make(map[string]string)
		userVotes[username] = "up"
		newMessage := Message{
			ID:           uuid.NewString(),
			Timestamp:    time.Now().Unix(),
			Username:     username,
			Content:      content,
			EncryptedMessage: encryptedMessage,
			EncryptedFor: nil,
			ReplyTo:      replyTo,
			VoteTotal:    &one,
			UserVotes:    userVotes,
		}
		cs.messages[room] = append([]Message{newMessage}, cs.messages[room]...)
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

		// Save to disk
		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

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
			roomsCopy = filterRoomsForUser(roomsCopy, username)
			// Get logged-in and active user lists
			loggedInUsers, activeUsers := cs.getUserLists()

			initialData := map[string]interface{}{
				"messages":      messagesCopy,
				"rooms":         roomsCopy,
				"users":         usersList, // Keep for backward compatibility
				"loggedInUsers": loggedInUsers,
				"activeUsers":   activeUsers,
				"userPubKeys":   userPubKeysCopy,
			}
			log.Printf("[%s] ✓ User just registered, sending INITIAL_DATA to %s", socketIDStr, username)
			dataJSON, _ := json.Marshal(initialData)
			log.Printf("[%s] INITIAL_DATA payload: %s", socketIDStr, string(dataJSON))
			socket.Emit(EventInitialData, initialData)
			log.Printf("[%s] ✓ INITIAL_DATA sent to newly registered user", socketIDStr)
		}

		// Prepare delta response: only send the newly created message.
		response := map[string]interface{}{
			"messages": map[string][]Message{room: {newMessage}},
		}

		log.Printf("[%s] Broadcasting SERVER_MESSAGE - rooms: %d, users: %d", socketIDStr, len(messagesCopy), len(usersList))

		if userA, userB, ok := parseDMParticipants(room); ok {
			cs.sendToUsers(defaultNsp, []string{userA, userB}, EventServerMessage, response)
			log.Printf("[%s] ✓ Sent DM message only to participants: %s, %s", socketIDStr, userA, userB)
		} else {
			// Broadcast to all clients for non-DM rooms.
			defaultNsp.Emit(EventServerMessage, response)
			log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)
		}
		log.Printf("[%s] ✓ CLIENT_MESSAGE handler complete", socketIDStr)
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
		formattedRoom := formatRoomName(roomNameStr)
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
			requestingUser := ""
			for user, sid := range cs.users {
				if sid == socketIDStr {
					requestingUser = user
					break
				}
			}

			cs.rooms = append(cs.rooms, formattedRoom)
			cs.messages[formattedRoom] = []Message{}
			if introMessage, ok := buildDMIntroMessage(formattedRoom, requestingUser); ok {
				cs.messages[formattedRoom] = append([]Message{introMessage}, cs.messages[formattedRoom]...)
			}
			if cs.roomMembers[formattedRoom] == nil {
				cs.roomMembers[formattedRoom] = make(map[string]bool)
			}
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

		// Save to disk
		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

		// Prepare response
		response := map[string]interface{}{
			"rooms": sortedRooms,
		}

		log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))

		// Broadcast to all clients.
		defaultNsp.Emit(EventServerNewRoom, response)
		log.Printf("[%s] ✓ Broadcasted SERVER_NEW_ROOM", socketIDStr)
		log.Printf("[%s] ✓ SERVER_NEW_ROOM update sent", socketIDStr)
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

		// Save to disk
		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

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
		username, _ := voteMap["username"].(string)
		voteTypeRaw, hasVoteType := voteMap["voteType"]
		messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(voteMap)

		if (!hasMessageID && !hasTimestamp) || !hasVoteType || username == "" || room == "" {
			log.Printf("[%s] ✗ Missing required vote fields", socketIDStr)
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

		// Save state to disk
		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

		response := map[string]interface{}{
			"messages": map[string][]Message{room: {*targetMessage}},
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
		username, _ := editMap["username"].(string)
		sessionID, _ := editMap["sessionId"].(string)
		encryptedMessage, _ := editMap["encryptedMessage"].(string)
		messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(editMap)

		if (!hasMessageID && !hasTimestamp) || username == "" || room == "" || sessionID == "" {
			log.Printf("[%s] ✗ Missing required edit fields", socketIDStr)
			emitActionResult(socket, "edit", false, "invalid_request", "Missing required edit fields")
			return
		}

		if !cs.isSessionAuthorizedForUser(sessionID, username) {
			code, message := cs.getSessionAuthFailure(sessionID, username)
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
		if targetMessage.Username != username {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ User %s attempted to edit message by %s (unauthorized)", socketIDStr, username, targetMessage.Username)
			emitActionResult(socket, "edit", false, "not_owner", "Not owner")
			return
		}

		// Prevent editing system messages
		if targetMessage.Username == "system" {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ User %s attempted to edit system message (not allowed)", socketIDStr, username)
			emitActionResult(socket, "edit", false, "not_allowed", "System messages cannot be edited")
			return
		}

		// Update the message
		targetMessage.Content = "" // Clear plaintext (encrypted only)
		targetMessage.EncryptedMessage = encryptedMessage
		targetMessage.EncryptedFor = nil
		targetMessage.Edited = true
		cs.userLastSeen[username] = time.Now().Unix()

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

		userLastSeenCopy := make(map[string]int64)
		for user, lastSeen := range cs.userLastSeen {
			userLastSeenCopy[user] = lastSeen
		}

		cs.mu.Unlock()

		// Save state to disk
		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

		response := map[string]interface{}{
			"messages": map[string][]Message{room: {*targetMessage}},
		}

		// Broadcast to all clients
		defaultNsp.Emit(EventServerMessage, response)
		log.Printf("[%s] ✓ Broadcasted message edit update", socketIDStr)
		cs.broadcastUserListUpdate()
		emitActionResult(socket, "edit", true, "ok", "Message updated")
	})

	defaultNsp.OnEvent(EventClientDeleteMessage, func(socket socketio.ServerSocket, deleteData interface{}) {
		socketIDStr := string(socket.ID())
		log.Printf("[%s] ===== CLIENT_DELETE_MESSAGE EVENT ======", socketIDStr)

		deleteMap, ok := deleteData.(map[string]interface{})
		if !ok {
			log.Printf("[%s] ✗ Invalid delete data format, type: %T", socketIDStr, deleteData)
			return
		}

		room, _ := deleteMap["room"].(string)
		username, _ := deleteMap["username"].(string)
		sessionID, _ := deleteMap["sessionId"].(string)
		messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(deleteMap)

		if (!hasMessageID && !hasTimestamp) || username == "" || room == "" || sessionID == "" {
			log.Printf("[%s] ✗ Missing required delete fields", socketIDStr)
			emitActionResult(socket, "delete", false, "invalid_request", "Missing required delete fields")
			return
		}

		if !cs.isSessionAuthorizedForUser(sessionID, username) {
			code, message := cs.getSessionAuthFailure(sessionID, username)
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
			log.Printf("[%s] ✓ Message %d already deleted; treating delete as idempotent", socketIDStr, messageTimestamp)
			emitActionResult(socket, "delete", true, "ok", "Message deleted")
			return
		}

		if targetMessage.Username != username {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ User %s attempted to delete message by %s (unauthorized)", socketIDStr, username, targetMessage.Username)
			emitActionResult(socket, "delete", false, "not_owner", "Not owner")
			return
		}

		if targetMessage.Username == "system" {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ User %s attempted to delete system message (not allowed)", socketIDStr, username)
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
		cs.userLastSeen[username] = time.Now().Unix()

		log.Printf("[%s] ✓ Marked message %d by %s as deleted", socketIDStr, messageTimestamp, username)

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

		messagesCopy := make(Messages)
		for k, v := range cs.messages {
			messagesCopy[k] = make([]Message, len(v))
			copy(messagesCopy[k], v)
		}
		usersList := make([]string, 0, len(cs.users))
		for user := range cs.users {
			usersList = append(usersList, user)
		}

		userPubKeysCopy := make(map[string]string)
		for k, v := range cs.userPubKeys {
			userPubKeysCopy[k] = v
		}

		userLastSeenCopy := make(map[string]int64)
		for user, lastSeen := range cs.userLastSeen {
			userLastSeenCopy[user] = lastSeen
		}

		cs.mu.Unlock()

		if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
			log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
		}

		response := map[string]interface{}{
			"messages": map[string][]Message{room: {*targetMessage}},
		}

		defaultNsp.Emit(EventServerMessage, response)
		log.Printf("[%s] ✓ Broadcasted message delete update", socketIDStr)
		cs.broadcastUserListUpdate()
		emitActionResult(socket, "delete", true, "ok", "Message deleted")
	})

	// Register per-socket connection handler
	defaultNsp.OnConnection(func(socket socketio.ServerSocket) {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("✗ PANIC in OnConnection handler: %v", r)
			}
		}()
		socketIDStr := string(socket.ID())
		log.Printf("===== CLIENT CONNECTING ======")
		log.Printf("Socket ID: %s", socketIDStr)

		// Targeted sends use namespace room addressing by socket ID.
		// Explicitly join this room so sendToUsers can reliably route DM events.
		socket.Join(socketio.Room(socketIDStr))
		log.Printf("[%s] ✓ Joined personal delivery room", socketIDStr)

		// Register disconnect handler for this socket
		socket.OnDisconnect(func(reason socketio.Reason) {
			log.Printf("[%s] ===== CLIENT DISCONNECTED ======", socketIDStr)
			log.Printf("[%s] Reason: %s", socketIDStr, string(reason))

			// Remove user from active users list (unreserve username) and send leave message
			cs.mu.Lock()
			var disconnectedUsername string
			for username, sessionID := range cs.users {
				if sessionID == socketIDStr {
					disconnectedUsername = username
					delete(cs.users, username)
					// Clear the join message flag so they'll get a new one on next login
					delete(cs.hasSentJoinMsg, username)
					delete(cs.joinScheduled, username)
					log.Printf("[%s] ✓ Removed user %s from active users (username unreserved)", socketIDStr, username)

					// Send leave message to default room
					if cs.messages[DefaultRoom] == nil {
						cs.messages[DefaultRoom] = []Message{}
					}
					leaveMsg := Message{
						Timestamp: time.Now().Unix(),
						Username:  "system",
						Content:   fmt.Sprintf("%s %s", username, UserLeft),
						Edited:    false, // System messages can't be edited
					}
					cs.messages[DefaultRoom] = append([]Message{leaveMsg}, cs.messages[DefaultRoom]...)
					log.Printf("[%s] ✓ Auto-sent leave message for %s from %s", socketIDStr, username, DefaultRoom)

					// Remove user from room members
					if cs.roomMembers[DefaultRoom] != nil {
						delete(cs.roomMembers[DefaultRoom], username)
					}

					break
				}
			}

			// Prepare response with updated messages
			messagesCopy := make(Messages)
			for k, v := range cs.messages {
				messagesCopy[k] = make([]Message, len(v))
				copy(messagesCopy[k], v)
			}
			cs.mu.Unlock()

			// Broadcast updated messages (including leave message)
			if defaultNsp != nil && disconnectedUsername != "" {
				response := map[string]interface{}{
					"messages": messagesCopy,
				}
				defaultNsp.Emit(EventServerMessage, response)
				log.Printf("[%s] ✓ Broadcasted leave message for %s", socketIDStr, disconnectedUsername)
			}

			// Broadcast updated user list
			cs.broadcastUserListUpdate()
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
			encryptedMessage, _ := msgMap["encryptedMessage"].(string)

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

			log.Printf("[%s] ✓ Parsed message - User: %s, Room: %s, Content: %s, HasEncryptedPacket: %v, ReplyTo: %v", socketIDStr, username, room, content, encryptedMessage != "", replyTo)

			if !isRoomVisibleToUser(room, username) {
				log.Printf("[%s] ✗ Rejected DM send by non-participant user=%s room=%s", socketIDStr, username, room)
				return
			}

			// Set user when they send a message
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

			// Reject join messages from clients - server sends these automatically
			if content == UserJoined {
				log.Printf("[%s] ✗ Rejecting client-sent join message from %s - server sends these automatically", socketIDStr, username)
				cs.mu.Unlock()
				return
			}

			// Join message should already be sent or scheduled on login via setUser
			// DO NOT add join message here - it should already exist from login
			// If it doesn't exist and it's not scheduled, log a warning.
			if username != "" && !cs.hasSentJoinMsg[username] && !cs.joinScheduled[username] {
				log.Printf("[%s] ⚠ WARNING: Join message not sent for %s during login! This should not happen.", socketIDStr, username)
				// Don't add join message here - it will cause issues
				// Instead, just log the warning and continue with the user's message
			}

			// Update user last seen
			cs.userLastSeen[username] = time.Now().Unix()

			beforeCount := len(cs.messages[room])

			// Normal message handling (join messages are rejected earlier)
			// Auto-upvote own message
			one := 1
			userVotes := make(map[string]string)
			userVotes[username] = "up"
			newMessage := Message{
				ID:           uuid.NewString(),
				Timestamp:    time.Now().Unix(),
				Username:     username,
				Content:      content,
				EncryptedMessage: encryptedMessage,
				EncryptedFor: nil,
				ReplyTo:      replyTo,
				VoteTotal:    &one,
				UserVotes:    userVotes,
			}
			cs.messages[room] = append([]Message{newMessage}, cs.messages[room]...)

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

			// Save to disk
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

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
			if userJustRegistered {
				roomsCopy = filterRoomsForUser(roomsCopy, username)
				// Get logged-in and active user lists
				loggedInUsers, activeUsers := cs.getUserLists()

				initialData := map[string]interface{}{
					"messages":      messagesCopy,
					"rooms":         roomsCopy,
					"users":         usersList, // Keep for backward compatibility
					"loggedInUsers": loggedInUsers,
					"activeUsers":   activeUsers,
					"userPubKeys":   userPubKeysCopy,
				}
				log.Printf("[%s] ✓ User just registered, sending INITIAL_DATA to %s", socketIDStr, username)
				socket.Emit(EventInitialData, initialData)
				log.Printf("[%s] ✓ INITIAL_DATA sent to newly registered user", socketIDStr)
			}

			// Prepare delta response with only the new message.
			response := map[string]interface{}{
				"messages": map[string][]Message{room: {newMessage}},
			}

			log.Printf("[%s] Broadcasting SERVER_MESSAGE - rooms: %d, users: %d", socketIDStr, len(messagesCopy), len(usersList))

			if userA, userB, ok := parseDMParticipants(room); ok {
				cs.sendToUsers(defaultNsp, []string{userA, userB}, EventServerMessage, response)
				log.Printf("[%s] ✓ Sent DM message only to participants: %s, %s", socketIDStr, userA, userB)
			} else {
				// Broadcast to all clients (excluding sender)
				defaultNsp.Emit(EventServerMessage, response)
				log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)

				// Also emit directly to sender so they see their own messages
				socket.Emit(EventServerMessage, response)
			}
			log.Printf("[%s] ✓ Emitted message update, CLIENT_MESSAGE handler complete", socketIDStr)
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
			formattedRoom := formatRoomName(roomNameStr)
			log.Printf("[%s] Formatted room name: %s", socketIDStr, formattedRoom)
			cs.mu.Lock()
			requestingUser := ""
			for user, sid := range cs.users {
				if sid == socketIDStr {
					requestingUser = user
					break
				}
			}

			if !isRoomVisibleToUser(formattedRoom, requestingUser) {
				cs.mu.Unlock()
				log.Printf("[%s] ✗ Rejected DM room creation by non-participant user=%s room=%s", socketIDStr, requestingUser, formattedRoom)
				return
			}

			roomExists := false
			for _, r := range cs.rooms {
				if r == formattedRoom {
					roomExists = true
					break
				}
			}
			if !roomExists {
				cs.rooms = append(cs.rooms, formattedRoom)
				cs.messages[formattedRoom] = []Message{}
				if introMessage, ok := buildDMIntroMessage(formattedRoom, requestingUser); ok {
					cs.messages[formattedRoom] = append([]Message{introMessage}, cs.messages[formattedRoom]...)
				}
				if cs.roomMembers[formattedRoom] == nil {
					cs.roomMembers[formattedRoom] = make(map[string]bool)
				}
				log.Printf("[%s] ✓ Created new room: %s", socketIDStr, formattedRoom)
			}
			sortedRooms := cs.alphabeticalSort(cs.rooms)
			roomMessages := make([]Message, len(cs.messages[formattedRoom]))
			copy(roomMessages, cs.messages[formattedRoom])
			cs.mu.Unlock()

			if userA, userB, ok := parseDMParticipants(formattedRoom); ok {
				for _, participant := range []string{userA, userB} {
					payload := map[string]interface{}{
						"messages": map[string][]Message{
							formattedRoom: filterMessagesByVisibility(roomMessages, participant),
						},
						"rooms": filterRoomsForUser(sortedRooms, participant),
					}
					cs.sendToUsers(defaultNsp, []string{participant}, EventServerNewRoom, payload)
				}
				log.Printf("[%s] ✓ Sent DM room update only to participants", socketIDStr)
				return
			}

			response := map[string]interface{}{
				"rooms": sortedRooms,
			}

			log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))
			defaultNsp.Emit(EventServerNewRoom, response)
			socket.Emit(EventServerNewRoom, response)
			log.Printf("[%s] ✓ SERVER_NEW_ROOM sent", socketIDStr)
		})

		socket.OnEvent(EventClientSendPublicKey, func(data interface{}) {
			socketIDStr := string(socket.ID())
			dataMap, ok := data.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid send public key payload", socketIDStr)
				return
			}
			targetUser, _ := dataMap["targetUser"].(string)
			fromUser, _ := dataMap["fromUser"].(string)
			publicKey, _ := dataMap["publicKey"].(string)
			encryptedAccountPackage, _ := dataMap["encryptedAccountPackage"].(string)
			if fromUser == "" || publicKey == "" {
				log.Printf("[%s] ✗ Missing fields in send public key payload", socketIDStr)
				return
			}

			var dmRoomForTransfer string
			var dmMessagesForTarget []Message
			var dmMessagesForSender []Message
			var dmIntroTimestamp int64
			dmRoomCreatedForTransfer := false

			cs.mu.Lock()
			cs.userPubKeys[fromUser] = publicKey

			if targetUser != "" {
				dmRoomForTransfer = buildCanonicalDMRoom(fromUser, targetUser)
				if _, exists := cs.messages[dmRoomForTransfer]; !exists {
					dmRoomCreatedForTransfer = true
					cs.messages[dmRoomForTransfer] = []Message{}
					if introMessage, ok := buildDMIntroMessage(dmRoomForTransfer, targetUser); ok {
						dmIntroTimestamp = introMessage.Timestamp
						cs.messages[dmRoomForTransfer] = append(
							[]Message{introMessage},
							cs.messages[dmRoomForTransfer]...,
						)
					}
				}

				if !contains(cs.rooms, dmRoomForTransfer) {
					cs.rooms = append(cs.rooms, dmRoomForTransfer)
				}

				transferTimestamp := time.Now().Unix()
				senderTransferTimestamp := transferTimestamp
				if dmRoomCreatedForTransfer && dmIntroTimestamp > 0 {
					if transferTimestamp <= dmIntroTimestamp {
						transferTimestamp = dmIntroTimestamp + 1
					}
					senderTransferTimestamp = transferTimestamp + 1
				}

				transferNotice := Message{
					ID:        uuid.NewString(),
					Timestamp: transferTimestamp,
					Username:  "system",
					Content:   fmt.Sprintf("%s sent you a private key bundle. You can switch to this imported account from login.", fromUser),
					KeyTransferEncryptedPackage: encryptedAccountPackage,
					KeyTransferFromUser: fromUser,
					Edited:    false,
					VisibleTo: []string{targetUser},
				}
				senderTransferNotice := Message{
					ID:        uuid.NewString(),
					Timestamp: senderTransferTimestamp,
					Username:  "system",
					Content:   fmt.Sprintf("you sent key to user %s", targetUser),
					Edited:    false,
					VisibleTo: []string{fromUser},
				}
				cs.messages[dmRoomForTransfer] = append(
					[]Message{senderTransferNotice, transferNotice},
					cs.messages[dmRoomForTransfer]...,
				)

				dmMessagesForTarget = filterMessagesByVisibility(
					cs.messages[dmRoomForTransfer],
					targetUser,
				)
				dmMessagesForSender = filterMessagesByVisibility(
					cs.messages[dmRoomForTransfer],
					fromUser,
				)
			}

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
			userPubKeysCopy := make(map[string]string)
			for k, v := range cs.userPubKeys {
				userPubKeysCopy[k] = v
			}
			activeUsers := make([]string, 0, len(cs.users))
			for user := range cs.users {
				if user != fromUser {
					activeUsers = append(activeUsers, user)
				}
			}
			cs.mu.Unlock()

			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

			payload := map[string]interface{}{
				"fromUser":  fromUser,
				"publicKey": publicKey,
			}
			if targetUser != "" && encryptedAccountPackage != "" {
				payload["transferDmRoom"] = dmRoomForTransfer
			}

			if targetUser == "" {
				if len(activeUsers) > 0 {
					cs.sendToUsers(defaultNsp, activeUsers, EventServerPublicKeyReceived, payload)
				}
				log.Printf("[%s] ✓ Broadcasted public key from %s to %d active users", socketIDStr, fromUser, len(activeUsers))
				return
			}

			cs.sendToUsers(defaultNsp, []string{targetUser}, EventServerPublicKeyReceived, payload)
			if dmRoomForTransfer != "" && len(dmMessagesForTarget) > 0 {
				cs.sendToUsers(defaultNsp, []string{targetUser}, EventServerMessage, map[string]interface{}{
					"messages": map[string][]Message{
						dmRoomForTransfer: dmMessagesForTarget,
					},
				})
			}
			if dmRoomForTransfer != "" && len(dmMessagesForSender) > 0 {
				cs.sendToUsers(defaultNsp, []string{fromUser}, EventServerMessage, map[string]interface{}{
					"messages": map[string][]Message{
						dmRoomForTransfer: dmMessagesForSender,
					},
				})
			}
			log.Printf("[%s] ✓ Relayed key transfer from %s to %s", socketIDStr, fromUser, targetUser)
		})

		socket.OnEvent(EventClientUnblockUserDelta, func(data interface{}) {
			socketIDStr := string(socket.ID())
			payload, ok := data.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid unblock delta payload", socketIDStr)
				return
			}

			requestingUser, _ := payload["username"].(string)
			sessionID, _ := payload["sessionId"].(string)
			targetUser, _ := payload["targetUser"].(string)
			blockedSince := int64(0)
			if rawBlockedSince, ok := payload["blockedSince"]; ok {
				switch value := rawBlockedSince.(type) {
				case float64:
					blockedSince = int64(value)
				case int64:
					blockedSince = value
				case int:
					blockedSince = int64(value)
				}
			}

			if requestingUser == "" || targetUser == "" || sessionID == "" {
				log.Printf("[%s] ✗ Missing fields in unblock delta payload", socketIDStr)
				emitActionResult(socket, "unblockDelta", false, "invalid_request", "Missing required fields")
				return
			}

			if !cs.isSessionAuthorizedForUser(sessionID, requestingUser) {
				code, message := cs.getSessionAuthFailure(sessionID, requestingUser)
				log.Printf("[%s] ✗ Rejected unblock delta request by %s (%s)", socketIDStr, requestingUser, code)
				emitActionResult(socket, "unblockDelta", false, code, message)
				return
			}

			cs.mu.RLock()
			delta := make(Messages)
			for room, roomMessages := range cs.messages {
				filtered := make([]Message, 0)
				for _, msg := range roomMessages {
					if msg.Username != targetUser {
						continue
					}
					if blockedSince > 0 && msg.Timestamp < blockedSince {
						continue
					}
					filtered = append(filtered, msg)
				}

				if len(filtered) == 0 {
					continue
				}

				visible := filterMessagesByVisibility(filtered, requestingUser)
				if len(visible) > 0 {
					delta[room] = visible
				}
			}
			cs.mu.RUnlock()

			if len(delta) == 0 {
				emitActionResult(socket, "unblockDelta", true, "ok", "No message delta")
				return
			}

			socket.Emit(EventServerMessage, map[string]interface{}{
				"messages": delta,
			})
			emitActionResult(socket, "unblockDelta", true, "ok", "Message delta synced")
			log.Printf("[%s] ✓ Sent unblock delta to %s for target %s (%d rooms)", socketIDStr, requestingUser, targetUser, len(delta))
		})

		socket.OnEvent(EventClientRequestInitialData, func(data interface{}) {
			socketIDStr := string(socket.ID())
			payload, ok := data.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid initial data request payload", socketIDStr)
				return
			}

			username, _ := payload["username"].(string)
			sessionID, _ := payload["sessionId"].(string)
			defaultRoom, _ := payload["defaultRoom"].(string)
			currentRoom, _ := payload["currentRoom"].(string)
			openRooms := parseStringList(payload["openRooms"])

			if defaultRoom == "" {
				defaultRoom = DefaultRoom
			}
			if currentRoom == "" {
				currentRoom = defaultRoom
			}
			if len(openRooms) == 0 {
				openRooms = []string{defaultRoom}
			}

			if username == "" || sessionID == "" {
				emitActionResult(socket, "initialData", false, "invalid_request", "Missing authentication fields")
				return
			}

			if !cs.isSessionAuthorizedForUser(sessionID, username) {
				code, message := cs.getSessionAuthFailure(sessionID, username)
				log.Printf("[%s] ✗ Rejected initial data request by %s (%s)", socketIDStr, username, code)
				emitActionResult(socket, "initialData", false, code, message)
				return
			}

			// Keep presence mapping accurate for online users even if they haven't sent chat messages yet.
			cs.registerUserFromAuth(username, socketIDStr)

			cs.mu.RLock()
			messagesCopy := buildScopedMessagesForUser(cs.messages, username, defaultRoom, currentRoom, openRooms)
			roomsCopy := make([]string, len(cs.rooms))
			copy(roomsCopy, cs.rooms)
			roomsCopy = filterRoomsForUser(roomsCopy, username)

			var usersCopy []string
			for user := range cs.users {
				if user != "" && user != "undefined" {
					usersCopy = append(usersCopy, user)
				}
			}
			sort.Slice(usersCopy, func(i, j int) bool {
				return strings.ToLower(usersCopy[i]) < strings.ToLower(usersCopy[j])
			})

			userPubKeysCopy := make(map[string]string)
			for k, v := range cs.userPubKeys {
				userPubKeysCopy[k] = v
			}

			roomMembersCopy := make(map[string][]string)
			for room, members := range cs.roomMembers {
				memberList := make([]string, 0, len(members))
				for member := range members {
					memberList = append(memberList, member)
				}
				roomMembersCopy[room] = memberList
			}

			userLastSeenCopy := make(map[string]int64)
			for user, lastSeen := range cs.userLastSeen {
				userLastSeenCopy[user] = lastSeen
			}
			cs.mu.RUnlock()

			loggedInUsers, activeUsers := cs.getUserLists()

			socket.Emit(EventInitialData, map[string]interface{}{
				"messages":      messagesCopy,
				"rooms":         roomsCopy,
				"users":         usersCopy,
				"loggedInUsers": loggedInUsers,
				"activeUsers":   activeUsers,
				"userPubKeys":   userPubKeysCopy,
				"roomMembers":   roomMembersCopy,
				"userLastSeen":  userLastSeenCopy,
			})
			emitActionResult(socket, "initialData", true, "ok", "Initial data sent")
			log.Printf("[%s] ✓ Sent filtered initial data to %s (rooms requested: %d, rooms returned: %d)", socketIDStr, username, len(openRooms), len(messagesCopy))
		})

		socket.OnEvent(EventClientRequestRoomData, func(data interface{}) {
			socketIDStr := string(socket.ID())
			payload, ok := data.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid room data request payload", socketIDStr)
				return
			}

			username, _ := payload["username"].(string)
			sessionID, _ := payload["sessionId"].(string)
			room, _ := payload["room"].(string)

			if username == "" || sessionID == "" || room == "" {
				emitActionResult(socket, "roomData", false, "invalid_request", "Missing required fields")
				return
			}

			if !cs.isSessionAuthorizedForUser(sessionID, username) {
				code, message := cs.getSessionAuthFailure(sessionID, username)
				log.Printf("[%s] ✗ Rejected room data request by %s (%s)", socketIDStr, username, code)
				emitActionResult(socket, "roomData", false, code, message)
				return
			}

			if !isRoomVisibleToUser(room, username) {
				log.Printf("[%s] ✗ Rejected room data request by non-participant user=%s room=%s", socketIDStr, username, room)
				emitActionResult(socket, "roomData", false, "unauthorized", "Unauthorized room access")
				return
			}

			cs.mu.RLock()
			roomMessages := cs.messages[room]
			visible := filterMessagesByVisibility(roomMessages, username)
			cs.mu.RUnlock()

			delta := make(Messages)
			if len(visible) > 0 {
				delta[room] = visible
			}

			socket.Emit(EventServerMessage, map[string]interface{}{
				"messages": delta,
			})
			emitActionResult(socket, "roomData", true, "ok", "Room data sent")
			log.Printf("[%s] ✓ Sent lazy room data to %s for room %s (%d messages)", socketIDStr, username, room, len(visible))
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
			cs.mu.RLock()
			_, exists := cs.users[originalSender]
			cs.mu.RUnlock()

			if exists {
				// DM room name: both users see it as @{the other user}
				// For the original sender, it's @requestingUser
				// For the requesting user, it's @originalSender
				// We'll use @originalSender as the canonical name, but both users will see messages
				dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser) // Original sender sees @requestingUser
				dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSender) // Requesting user sees @originalSender
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

				cs.mu.Lock()
				// Find the original message content
				originalMessageContent := ""
				if originalRoomMessages, exists := cs.messages[originalRoom]; exists {
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
				} else {
					log.Printf("[%s] Reusing existing DM room: %s", socketIDStr, dmRoom)
					if cs.messages[dmRoom] == nil {
						cs.messages[dmRoom] = []Message{}
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
				cs.messages[dmRoomForOriginalSender] = append([]Message{originalSenderMsg}, cs.messages[dmRoomForOriginalSender]...)
				cs.messages[dmRoomForRequestingUser] = append([]Message{requestingUserMsg}, cs.messages[dmRoomForRequestingUser]...)

				// Add both rooms to room list if they don't exist
				roomExists1 := false
				roomExists2 := false
				for _, r := range cs.rooms {
					if r == dmRoomForOriginalSender {
						roomExists1 = true
					}
					if r == dmRoomForRequestingUser {
						roomExists2 = true
					}
				}
				if !roomExists1 {
					cs.rooms = append(cs.rooms, dmRoomForOriginalSender)
				}
				if !roomExists2 {
					cs.rooms = append(cs.rooms, dmRoomForRequestingUser)
				}

				cs.mu.Unlock()

				// Send messages only to the intended recipients
				if defaultNsp != nil {
					// Include the requesting user's public key so the client can encrypt for them
					requestingUserPubKey := ""
					cs.mu.RLock()
					if key, exists := cs.userPubKeys[requestingUser]; exists {
						requestingUserPubKey = key
					}
					cs.mu.RUnlock()

					// Send to original sender: access request with their room name
					accessRequestDataForOriginalSender := map[string]interface{}{
						"requestAccess":        requestAccess,
						"requestingUser":       requestingUser,
						"requestRoom":          dmRoomForOriginalSender, // Original sender sees @requestingUser
						"requestingUserPubKey": requestingUserPubKey,
					}
					cs.sendToUsers(defaultNsp, []string{originalSender}, EventServerAccessRequest, accessRequestDataForOriginalSender)

					// Send message update to original sender (only their visible message)
					responseForOriginalSender := map[string]interface{}{
						"messages": map[string][]Message{dmRoomForOriginalSender: {originalSenderMsg}},
						"rooms":    cs.rooms,
					}
					cs.sendToUsers(defaultNsp, []string{originalSender}, EventServerMessage, responseForOriginalSender)

					// Send message update to requesting user (only their visible message)
					responseForRequestingUser := map[string]interface{}{
						"messages": map[string][]Message{dmRoomForRequestingUser: {requestingUserMsg}},
						"rooms":    cs.rooms,
					}
					cs.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)

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

			if requestingUser == "" || originalRoom == "" || encryptedMessage == "" {
				log.Printf("[%s] ✗ Missing required fields in grant access: requestingUser=%s, originalRoom=%s, hasEncryptedMessage=%v", socketIDStr, requestingUser, originalRoom, encryptedMessage != "")
				return
			}

			log.Printf("[%s] Granting access: user=%s, room=%s, timestamp=%d, packetSize=%d", socketIDStr, requestingUser, originalRoom, messageTimestamp, len(encryptedMessage))

			log.Printf("[%s] About to update message in room %s with timestamp %d", socketIDStr, originalRoom, messageTimestamp)
			// Update the message with new version
			cs.mu.Lock()
			log.Printf("[%s] Lock acquired for message update", socketIDStr)
			if messages, exists := cs.messages[originalRoom]; exists && messages != nil {
				log.Printf("[%s] Room %s exists with %d messages", socketIDStr, originalRoom, len(messages))
				for i := range messages {
					if messages[i].Timestamp == messageTimestamp {
						// Initialize versions array if needed
						if messages[i].Versions == nil {
							messages[i].Versions = []MessageVersion{}
							if messages[i].EncryptedMessage != "" {
								messages[i].Versions = append(messages[i].Versions, MessageVersion{
									EncryptedMessage: messages[i].EncryptedMessage,
									Version:       0,
									ChangeSummary: "original version",
									Timestamp:     messages[i].Timestamp,
								})
							}
						}

						changeSummary := fmt.Sprintf("access grant re-encryption for %s", requestingUser)

						// Add new version (newest first)
						newVersion := MessageVersion{
							EncryptedMessage: encryptedMessage,
							Version:       len(messages[i].Versions),
							ChangeSummary: changeSummary,
							Timestamp:     time.Now().Unix(),
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

			// Get original sender while we still have the lock
			originalSenderForDM := ""
			if messages, exists := cs.messages[originalRoom]; exists {
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

			dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser)      // Original sender sees @requestingUser
			dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSenderForDM) // Requesting user sees @originalSender
			log.Printf("[%s] Original sender for DM: %s, DM rooms: %s (original sender) and %s (requesting user)", socketIDStr, originalSenderForDM, dmRoomForOriginalSender, dmRoomForRequestingUser)

			if originalSenderForDM != "" {
				// Update DM room messages while we still have the lock
				// Update original sender's room (@requestingUser)
				if dmRoomMessages, exists := cs.messages[dmRoomForOriginalSender]; exists && dmRoomMessages != nil {
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
				if dmRoomMessages, exists := cs.messages[dmRoomForRequestingUser]; exists && dmRoomMessages != nil {
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
						Timestamp:      msg.Timestamp,
						Username:       msg.Username,
						Content:        msg.Content, // This will be empty for encrypted messages
						EncryptedFor:   make(map[string]string),
						Versions:       msg.Versions,
						CurrentVersion: msg.CurrentVersion,
						VisibleTo:      msg.VisibleTo,
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
					cs.messages[dmRoomForOriginalSender],
					originalSenderForDM,
				)
				dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
					cs.messages[dmRoomForRequestingUser],
					requestingUser,
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
						"messageTimestamp": messageTimestamp,
						"encryptedMessage": encryptedMessage,
					},
					"messages": map[string][]Message{
						originalRoom:            messagesCopy,
						dmRoomForOriginalSender: dmRoomMessagesForOriginalSender,
					},
					"rooms": cs.rooms,
				}
				log.Printf("[%s] Sending to original sender: %s", socketIDStr, originalSenderForDM)
				cs.sendToUsers(defaultNsp, []string{originalSenderForDM}, EventServerMessage, responseForOriginalSender)

				// Send to requesting user: original room + their DM room
				responseForRequestingUser := map[string]interface{}{
					"accessGrant": map[string]interface{}{
						"originalRoom":     originalRoom,
						"messageTimestamp": messageTimestamp,
						"encryptedMessage": encryptedMessage,
					},
					"messages": map[string][]Message{
						originalRoom:            messagesCopy,
						dmRoomForRequestingUser: dmRoomMessagesForRequestingUser,
					},
					"rooms": cs.rooms,
				}
				log.Printf("[%s] About to send to requesting user: %s", socketIDStr, requestingUser)
				log.Printf("[%s] Checking if requesting user is in users map...", socketIDStr)
				cs.mu.RLock()
				if socketIDForRequestingUser, exists := cs.users[requestingUser]; exists {
					log.Printf("[%s] ✓ Requesting user %s found in users map with socketID: %s", socketIDStr, requestingUser, socketIDForRequestingUser)
				} else {
					log.Printf("[%s] ✗ Requesting user %s NOT found in users map!", socketIDStr, requestingUser)
					log.Printf("[%s] Available users in map: %v", socketIDStr, func() []string {
						users := make([]string, 0, len(cs.users))
						for u := range cs.users {
							users = append(users, u)
						}
						return users
					}())
				}
				cs.mu.RUnlock()
				log.Printf("[%s] Sending to requesting user: %s", socketIDStr, requestingUser)
				cs.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)

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
			cs.mu.RLock()
			originalSender := ""
			if originalRoomMessages, exists := cs.messages[originalRoom]; exists {
				for _, msg := range originalRoomMessages {
					if msg.Timestamp == messageTimestamp {
						originalSender = msg.Username
						break
					}
				}
			}
			cs.mu.RUnlock()

			if originalSender == "" {
				log.Printf("[%s] ✗ Could not find original sender for message", socketIDStr)
				return
			}

			dmRoomForOriginalSender := fmt.Sprintf("@%s", requestingUser) // Original sender sees @requestingUser
			dmRoomForRequestingUser := fmt.Sprintf("@%s", originalSender) // Requesting user sees @originalSender

			cs.mu.Lock()
			// Update original sender's room (@requestingUser)
			if dmRoomMessages, exists := cs.messages[dmRoomForOriginalSender]; exists && dmRoomMessages != nil {
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
			if dmRoomMessages, exists := cs.messages[dmRoomForRequestingUser]; exists && dmRoomMessages != nil {
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
			cs.mu.Unlock()

			// Send updated DM room messages only to the intended recipients
			if defaultNsp != nil {
				cs.mu.RLock()
				dmRoomMessagesForOriginalSender := filterMessagesByVisibility(
					cs.messages[dmRoomForOriginalSender],
					originalSender,
				)
				dmRoomMessagesForRequestingUser := filterMessagesByVisibility(
					cs.messages[dmRoomForRequestingUser],
					requestingUser,
				)
				cs.mu.RUnlock()

				// Send to original sender
				responseForOriginalSender := map[string]interface{}{
					"messages": map[string][]Message{dmRoomForOriginalSender: dmRoomMessagesForOriginalSender},
					"rooms":    cs.rooms,
				}
				cs.sendToUsers(defaultNsp, []string{originalSender}, EventServerMessage, responseForOriginalSender)

				// Send to requesting user
				responseForRequestingUser := map[string]interface{}{
					"messages": map[string][]Message{dmRoomForRequestingUser: dmRoomMessagesForRequestingUser},
					"rooms":    cs.rooms,
				}
				cs.sendToUsers(defaultNsp, []string{requestingUser}, EventServerMessage, responseForRequestingUser)
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

			// Save state to disk
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

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
			encryptedMessage, _ := editMap["encryptedMessage"].(string)

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

			// Prevent editing system messages
			if targetMessage.Username == "system" {
				cs.mu.Unlock()
				log.Printf("[%s] ✗ User %s attempted to edit system message (not allowed)", socketIDStr, username)
				return
			}

			// Update the message
			targetMessage.Content = "" // Clear plaintext (encrypted only)
			targetMessage.EncryptedMessage = encryptedMessage
			targetMessage.EncryptedFor = nil
			targetMessage.Edited = true
			cs.userLastSeen[username] = time.Now().Unix()

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

			userLastSeenCopy := make(map[string]int64)
			for user, lastSeen := range cs.userLastSeen {
				userLastSeenCopy[user] = lastSeen
			}

			cs.mu.Unlock()
			loggedInUsers, activeUsers := cs.getUserLists()

			// Save state to disk
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

			response := map[string]interface{}{
				"messages": messagesCopy,
				"users":    usersList,
				"loggedInUsers": loggedInUsers,
				"activeUsers":   activeUsers,
				"userLastSeen":  userLastSeenCopy,
			}

			// Broadcast to all clients
			defaultNsp.Emit(EventServerMessage, response)
			log.Printf("[%s] ✓ Broadcasted message edit update", socketIDStr)
			cs.broadcastUserListUpdate()
		})

		socket.OnEvent(EventClientDeleteMessage, func(deleteData interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_DELETE_MESSAGE EVENT (per-socket) ======", socketIDStr)

			deleteMap, ok := deleteData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid delete data format, type: %T", socketIDStr, deleteData)
				return
			}

			room, _ := deleteMap["room"].(string)
			username, _ := deleteMap["username"].(string)
			sessionID, _ := deleteMap["sessionId"].(string)
			messageID, messageTimestamp, hasMessageID, hasTimestamp := parseMessageReference(deleteMap)

			if (!hasMessageID && !hasTimestamp) || username == "" || room == "" || sessionID == "" {
				log.Printf("[%s] ✗ Missing required delete fields", socketIDStr)
				emitActionResult(socket, "delete", false, "invalid_request", "Missing required delete fields")
				return
			}

			if !cs.isSessionAuthorizedForUser(sessionID, username) {
				code, message := cs.getSessionAuthFailure(sessionID, username)
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

			if targetMessage.Username != username {
				cs.mu.Unlock()
				log.Printf("[%s] ✗ User %s attempted to delete message by %s (unauthorized)", socketIDStr, username, targetMessage.Username)
				emitActionResult(socket, "delete", false, "not_owner", "Not owner")
				return
			}

			if targetMessage.Username == "system" {
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
			cs.userLastSeen[username] = time.Now().Unix()

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
			userPubKeysCopy := make(map[string]string)
			for k, v := range cs.userPubKeys {
				userPubKeysCopy[k] = v
			}

			updatedMessage := *targetMessage
			cs.mu.Unlock()

			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

			response := map[string]interface{}{
				"messages": map[string][]Message{room: {updatedMessage}},
			}
			defaultNsp.Emit(EventServerMessage, response)
			cs.broadcastUserListUpdate()
			emitActionResult(socket, "delete", true, "ok", "Message deleted")
			log.Printf("[%s] ✓ Broadcasted message delete update", socketIDStr)
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
			cs.mu.Lock()
			req, exists := cs.joinRequests[requestKey]
			if !exists {
				cs.mu.Unlock()
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
			roomMemberCount := len(cs.roomMembers[room])

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
				if cs.roomMembers[room] == nil {
					cs.roomMembers[room] = make(map[string]bool)
				}
				cs.roomMembers[room][requestingUser] = true

				// Post join message (system message, not editable)
				joinMsg := Message{
					Timestamp: time.Now().Unix(),
					Username:  "system",
					Content:   fmt.Sprintf("%s %s", requestingUser, UserJoined),
					Edited:    false, // System messages can't be edited
				}
				if cs.messages[room] == nil {
					cs.messages[room] = []Message{}
				}
				cs.messages[room] = append([]Message{joinMsg}, cs.messages[room]...)

				// Remove join request
				delete(cs.joinRequests, requestKey)

				cs.mu.Unlock()

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
					"messages": map[string][]Message{room: cs.messages[room]},
					"rooms":    cs.rooms,
					// Don't send users field - it would overwrite the client's user list
				}
				defaultNsp.Emit(EventServerMessage, response)

				log.Printf("[%s] ✓ Join request approved for %s to join %s", socketIDStr, requestingUser, room)
			} else if denied {
				// Remove join request
				delete(cs.joinRequests, requestKey)

				// Post denial message
				denialMsg := Message{
					Timestamp: time.Now().Unix(),
					Username:  "system",
					Content:   fmt.Sprintf("%s was denied access to this room", requestingUser),
				}
				if cs.messages[room] == nil {
					cs.messages[room] = []Message{}
				}
				cs.messages[room] = append([]Message{denialMsg}, cs.messages[room]...)

				cs.mu.Unlock()

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
					"messages": map[string][]Message{room: cs.messages[room]},
					"rooms":    cs.rooms,
					// Don't send users field - it would overwrite the client's user list
				}
				defaultNsp.Emit(EventServerMessage, response)

				log.Printf("[%s] ✗ Join request denied for %s to join %s", socketIDStr, requestingUser, room)
			} else {
				cs.mu.Unlock()
				log.Printf("[%s] Vote recorded, waiting for more votes (accepts: %d/%d, denials: %d)", socketIDStr, accepts, threshold, denials)
			}
		})

		socket.OnEvent(EventClientDisconnecting, func(sessionID interface{}) {
			socketIDStr := string(socket.ID())
			sessionIDStrParam, ok := sessionID.(string)
			if !ok {
				return
			}
			cs.mu.Lock()
			for user, sid := range cs.users {
				if sid == sessionIDStrParam {
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

			// Save to disk
			if err := cs.store.Save(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, cs.userPubKeys); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
			}

			log.Printf("[%s] client disconnecting", socketIDStr)
		})

		log.Printf("[%s] ✓ Per-socket event handlers registered", socketIDStr)

		// Send a lightweight status ping after connection.
		// Initial data is sent in response to EventClientRequestInitialData.
		go func() {
			time.Sleep(50 * time.Millisecond) // Small delay to ensure connection is ready

			socket.Emit(EventStatus, "Hello from Socket.io")
			log.Printf("[%s] ✓ STATUS ping sent; awaiting initial data request", socketIDStr)
		}()
	})
	// Note: Disconnect handlers are registered per-socket in OnConnection

	log.Println("===== SOCKET HANDLERS SETUP COMPLETE =====")
}
