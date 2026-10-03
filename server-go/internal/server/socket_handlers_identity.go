package server

import (
	"fmt"
	"log"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/google/uuid"
)

func (cs *ChatServer) handleIdentityDirectoryRefresh(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	payload, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] âœ— Invalid identity refresh payload", socketIDStr)
		return
	}

	auth, verified := cs.verifySignedMutation(
		socket,
		payload,
		EventClientIdentityDirectoryRefresh,
		[]string{"userId", "refreshedForUserIds"},
	)
	if !verified {
		return
	}

	payload["userId"] = auth.UserID
	actorUserID := parseStringField(payload, "userId")
	if actorUserID == "" {
		emitActionResult(socket, "identityRefresh", false, "invalid_request", "Missing sender identity")
		return
	}

	refreshedForUserIDs := parseStringList(payload["refreshedForUserIds"])
	if len(refreshedForUserIDs) == 0 {
		emitActionResult(socket, "identityRefresh", false, "invalid_request", "Missing refreshed user IDs")
		return
	}

	roomCiphertexts := parseCiphertextMap(payload["roomNameCiphertexts"], maxIdentityCiphertextBytes)
	userCiphertexts := parseCiphertextMap(payload["userDirectoryCiphertexts"], maxIdentityCiphertextBytes)
	roomUpdatedAtMap := parseTimestampMap(payload["roomDirectoryUpdatedAt"])
	userUpdatedAtMap := parseTimestampMap(payload["userDirectoryUpdatedAt"])
	if len(roomCiphertexts) == 0 && len(userCiphertexts) == 0 {
		emitActionResult(socket, "identityRefresh", false, "invalid_request", "No directory ciphertexts provided")
		return
	}

	acceptedRoomCiphertexts := make(map[string]string)
	acceptedUserCiphertexts := make(map[string]string)
	acceptedRoomUpdatedAt := make(map[string]int64)
	acceptedUserUpdatedAt := make(map[string]int64)
	acceptedRefreshedUsers := make([]string, 0, len(refreshedForUserIDs))

	cs.mu.Lock()
	for _, targetUserID := range refreshedForUserIDs {
		if targetUserID == "" {
			continue
		}
		if _, exists := cs.userPubKeys[targetUserID]; exists {
			acceptedRefreshedUsers = append(acceptedRefreshedUsers, targetUserID)
		}
	}

	if cs.roomNameCiphertexts == nil {
		cs.roomNameCiphertexts = make(map[string]string)
	}
	if cs.roomDirectoryUpdatedAt == nil {
		cs.roomDirectoryUpdatedAt = make(map[string]int64)
	}
	for roomID, cipher := range roomCiphertexts {
		if roomID == "" || cipher == "" {
			continue
		}
		if _, exists := cs.roomsByID[roomID]; !exists {
			continue
		}
		incomingUpdatedAt := int64(0)
		if roomUpdatedAtMap != nil {
			incomingUpdatedAt = roomUpdatedAtMap[roomID]
		}
		if incomingUpdatedAt <= 0 {
			incomingUpdatedAt = time.Now().UTC().UnixMilli()
		}
		existingUpdatedAt := cs.roomDirectoryUpdatedAt[roomID]
		if existingUpdatedAt > 0 && incomingUpdatedAt < existingUpdatedAt {
			continue
		}
		cs.roomNameCiphertexts[roomID] = cipher
		cs.roomDirectoryUpdatedAt[roomID] = incomingUpdatedAt
		acceptedRoomCiphertexts[roomID] = cipher
		acceptedRoomUpdatedAt[roomID] = incomingUpdatedAt
	}

	if cs.usernameCiphertexts == nil {
		cs.usernameCiphertexts = make(map[string]string)
	}
	if cs.userDirectoryUpdatedAt == nil {
		cs.userDirectoryUpdatedAt = make(map[string]int64)
	}
	for userID, cipher := range userCiphertexts {
		if userID == "" || cipher == "" {
			continue
		}
		if _, exists := cs.userPubKeys[userID]; !exists {
			continue
		}
		incomingUpdatedAt := int64(0)
		if userUpdatedAtMap != nil {
			incomingUpdatedAt = userUpdatedAtMap[userID]
		}
		if incomingUpdatedAt <= 0 {
			incomingUpdatedAt = time.Now().UTC().UnixMilli()
		}
		// The signed sender owns their own entry, so a self-update always wins.
		// Registration stores a ciphertext readable only by the server, and
		// timestamp ordering would otherwise pin that unreadable value forever.
		isSelfUpdate := userID == actorUserID
		if isSelfUpdate {
			if serverNow := time.Now().UTC().UnixMilli(); incomingUpdatedAt < serverNow {
				incomingUpdatedAt = serverNow
			}
		} else if existingUpdatedAt := cs.userDirectoryUpdatedAt[userID]; existingUpdatedAt > 0 && incomingUpdatedAt < existingUpdatedAt {
			continue
		}
		cs.usernameCiphertexts[userID] = cipher
		cs.userDirectoryUpdatedAt[userID] = incomingUpdatedAt
		acceptedUserCiphertexts[userID] = cipher
		acceptedUserUpdatedAt[userID] = incomingUpdatedAt
	}
	cs.mu.Unlock()

	if len(acceptedRoomCiphertexts) == 0 && len(acceptedUserCiphertexts) == 0 {
		emitActionResult(socket, "identityRefresh", true, "noop", "No new directory updates")
		return
	}

	cs.mu.RLock()
	messagesCopyForSave := cloneMessages(cs.messages)
	roomsCopyForSave := cloneStringSlice(cs.rooms)
	usersCopyForSave := cloneStringMap(cs.users)
	userPubKeysCopyForSave := cloneStringMap(cs.userPubKeys)
	cs.mu.RUnlock()
	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave); err != nil {
		log.Printf("[%s] âœ— Failed to save identity refresh state: %v", socketIDStr, err)
	}

	response := map[string]interface{}{
		"refreshedByUserId":        actorUserID,
		"refreshedForUserIds":      acceptedRefreshedUsers,
		"roomNameCiphertexts":      acceptedRoomCiphertexts,
		"roomDirectoryUpdatedAt":   acceptedRoomUpdatedAt,
		"userDirectoryCiphertexts": acceptedUserCiphertexts,
		"userDirectoryUpdatedAt":   acceptedUserUpdatedAt,
	}

	cs.emitNamespaceSigned(defaultNsp, EventServerIdentityDirectoryRefresh, response)
	cs.emitSocketSigned(socket, EventServerIdentityDirectoryRefresh, response)
	emitActionResult(socket, "identityRefresh", true, "ok", "Identity directory refresh propagated")
	log.Printf("[%s] âœ“ Identity directory refresh accepted from %s (rooms=%d users=%d)", socketIDStr, actorUserID, len(acceptedRoomCiphertexts), len(acceptedUserCiphertexts))
}

func (cs *ChatServer) handleSendPublicKey(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	dataMap, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid send public key payload", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, dataMap, EventClientSendPublicKey, []string{"fromUserId", "publicKey"})
	if !verified {
		return
	}
	if parseStringField(dataMap, "fromUserId") != auth.UserID {
		log.Printf("[%s] ✗ Signed identity mismatch in send public key", socketIDStr)
		emitActionResult(socket, "sendPublicKey", false, "unauthorized", "Signed identity mismatch")
		return
	}
	fromUserID := parseStringField(dataMap, "fromUserId")
	targetUserID := parseStringField(dataMap, "targetUserId")
	targetUser := cs.resolveUsernameFromPayload(dataMap, "targetUserId")
	fromUser := cs.resolveUsernameFromPayload(dataMap, "fromUserId")
	publicKey, _ := dataMap["publicKey"].(string)
	encryptedAccountPackage, _ := dataMap["encryptedAccountPackage"].(string)
	if fromUserID == "" || fromUser == "" || publicKey == "" {
		log.Printf("[%s] ✗ Missing fields in send public key payload", socketIDStr)
		return
	}

	var dmRoomForTransfer string
	var dmMessagesForTarget []Message
	var dmMessagesForSender []Message
	var dmIntroTimestamp int64
	dmRoomCreatedForTransfer := false

	cs.mu.Lock()
	cs.userPubKeys[fromUserID] = publicKey
	if cs.userPubKeysUpdatedAt == nil {
		cs.userPubKeysUpdatedAt = make(map[string]int64)
	}
	publicKeyUpdatedAt := time.Now().UTC().UnixMilli()
	cs.userPubKeysUpdatedAt[fromUserID] = publicKeyUpdatedAt

	if targetUser != "" {
		dmRoomForTransfer = buildCanonicalDMRoom(fromUserID, targetUserID)
		dmRoomIDForTransfer := cs.ensureRoomIDLocked(dmRoomForTransfer)
		if _, exists := cs.messages[dmRoomForTransfer]; !exists {
			dmRoomCreatedForTransfer = true
			cs.messages[dmRoomForTransfer] = []Message{}
			if introMessage, ok := buildDMIntroMessage(dmRoomForTransfer, targetUserID); ok {
				introMessage.UserID = SystemUserID
				introMessage.RoomID = dmRoomIDForTransfer
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
			ID:                          uuid.NewString(),
			Timestamp:                   transferTimestamp,
			Username:                    "system",
			UserID:                      SystemUserID,
			RoomID:                      dmRoomIDForTransfer,
			Content:                     fmt.Sprintf("%s sent you a private key bundle. You can switch to this imported account from login.", formatSystemUserRef(fromUserID)),
			KeyTransferEncryptedPackage: encryptedAccountPackage,
			KeyTransferFromUserID:       fromUserID,
			Edited:                      false,
			VisibleTo:                   []string{targetUserID},
		}
		senderTransferNotice := Message{
			ID:        uuid.NewString(),
			Timestamp: senderTransferTimestamp,
			Username:  "system",
			UserID:    SystemUserID,
			RoomID:    dmRoomIDForTransfer,
			Content:   fmt.Sprintf("you sent key to user %s", formatSystemUserRef(targetUserID)),
			Edited:    false,
			VisibleTo: []string{fromUserID},
		}
		cs.messages[dmRoomForTransfer] = append(
			[]Message{senderTransferNotice, transferNotice},
			cs.messages[dmRoomForTransfer]...,
		)

		dmMessagesForTarget = filterMessagesByVisibility(
			cs.messages[dmRoomForTransfer],
			targetUserID,
		)
		dmMessagesForSender = filterMessagesByVisibility(
			cs.messages[dmRoomForTransfer],
			fromUserID,
		)
	}

	messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy := cs.snapshotStateForSaveLocked()
	activeUsers := make([]string, 0, len(cs.users))
	for user := range cs.users {
		if user != fromUserID {
			activeUsers = append(activeUsers, user)
		}
	}
	cs.mu.Unlock()

	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
		log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
	}

	payload := map[string]interface{}{
		"fromUserId":         fromUserID,
		"publicKey":          publicKey,
		"publicKeyUpdatedAt": publicKeyUpdatedAt,
	}
	if targetUser != "" && encryptedAccountPackage != "" {
		payload["transferDmRoom"] = dmRoomForTransfer
		payload["transferDmRoomId"] = cs.ensureRoomID(dmRoomForTransfer)
		payload["targetUserId"] = targetUserID
	}
	cs.attachIdentityDirectories(payload)

	if targetUser == "" {
		if len(activeUsers) > 0 {
			cs.sendToUserIDs(defaultNsp, activeUsers, EventServerPublicKeyReceived, payload)
		}
		log.Printf("[%s] ✓ Broadcasted public key from %s to %d active users", socketIDStr, fromUser, len(activeUsers))
		return
	}

	cs.sendToUserIDs(defaultNsp, []string{targetUserID}, EventServerPublicKeyReceived, payload)
	if dmRoomForTransfer != "" && len(dmMessagesForTarget) > 0 {
		cs.sendToUserIDs(defaultNsp, []string{targetUserID}, EventServerMessage, map[string]interface{}{
			"messages": map[string][]Message{
				dmRoomForTransfer: dmMessagesForTarget,
			},
		})
	}
	if dmRoomForTransfer != "" && len(dmMessagesForSender) > 0 {
		cs.sendToUserIDs(defaultNsp, []string{fromUserID}, EventServerMessage, map[string]interface{}{
			"messages": map[string][]Message{
				dmRoomForTransfer: dmMessagesForSender,
			},
		})
	}
	log.Printf("[%s] ✓ Relayed key transfer from %s to %s", socketIDStr, fromUser, targetUser)

}

func (cs *ChatServer) handleDisconnecting(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	dataStrParam, ok := data.(string)
	if !ok {
		return
	}
	cs.mu.Lock()
	for user, sid := range cs.users {
		if sid == dataStrParam {
			delete(cs.userSocketsByID, user)
			delete(cs.users, user)
			break
		}
	}

	messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave := cs.snapshotStateForSaveLocked()
	cs.mu.Unlock()

	// Save to disk
	if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave); err != nil {
		log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
	}

	log.Printf("[%s] client disconnecting", socketIDStr)

}

func (cs *ChatServer) handleUnblockUserDelta(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	payload, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid unblock delta payload", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, payload, EventClientUnblockUserDelta, []string{"userId", "targetUserId", "blockedSince"})
	if !verified {
		return
	}
	payload["userId"] = auth.UserID

	requestingUser := cs.resolveUsernameFromPayload(payload, "userId")
	requestingUserID := parseStringField(payload, "userId")
	sessionID, _ := payload["sessionId"].(string)
	targetUser := cs.resolveUsernameFromPayload(payload, "targetUserId")
	targetUserID := parseStringField(payload, "targetUserId")
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

	if requestingUserID == "" || requestingUser == "" || targetUserID == "" || targetUser == "" || sessionID == "" {
		log.Printf("[%s] ✗ Missing fields in unblock delta payload", socketIDStr)
		emitActionResult(socket, "unblockDelta", false, "invalid_request", "Missing required fields")
		return
	}

	if !cs.isSessionAuthorizedForUser(sessionID, requestingUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, requestingUserID)
		log.Printf("[%s] ✗ Rejected unblock delta request by %s (%s)", socketIDStr, requestingUser, code)
		emitActionResult(socket, "unblockDelta", false, code, message)
		return
	}

	cs.mu.RLock()
	delta := make(Messages)
	for room, roomMessages := range cs.messages {
		filtered := make([]Message, 0)
		for _, msg := range roomMessages {
			if msg.UserID != targetUserID {
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

		visible := filterMessagesByVisibility(filtered, requestingUserID)
		if len(visible) > 0 {
			delta[room] = visible
		}
	}
	cs.mu.RUnlock()

	if len(delta) == 0 {
		emitActionResult(socket, "unblockDelta", true, "ok", "No message delta")
		return
	}

	cs.emitSocketSigned(socket, EventServerMessage, map[string]interface{}{
		"messages": delta,
	})
	emitActionResult(socket, "unblockDelta", true, "ok", "Message delta synced")
	log.Printf("[%s] ✓ Sent unblock delta to %s for target %s (%d rooms)", socketIDStr, requestingUser, targetUser, len(delta))

}

func (cs *ChatServer) handleRequestInitialData(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	payload, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid initial data request payload", socketIDStr)
		return
	}

	username := cs.resolveUsernameFromPayload(payload, "userId")
	requestUserID := parseStringField(payload, "userId")
	sessionID, _ := payload["sessionId"].(string)
	defaultRoom, _ := payload["defaultRoom"].(string)
	currentRoom := cs.resolveRoomFromPayload(payload, "currentRoomId")
	openRooms := parseStringList(payload["openRooms"])
	openRoomIDs := parseStringList(payload["openRoomIds"])

	if defaultRoom == "" {
		defaultRoom = DefaultRoom
	}
	if currentRoom == "" {
		currentRoom = defaultRoom
	}
	cs.mu.RLock()
	if mappedRoomID := cs.roomIDs[currentRoom]; mappedRoomID != "" {
		if mappedRoomName := cs.roomsByID[mappedRoomID]; mappedRoomName != "" {
			currentRoom = mappedRoomName
		}
	}
	cs.mu.RUnlock()
	if len(openRooms) == 0 {
		openRooms = []string{defaultRoom}
	}
	if len(openRoomIDs) > 0 {
		for _, roomID := range openRoomIDs {
			cs.mu.RLock()
			roomName := cs.roomsByID[roomID]
			cs.mu.RUnlock()
			if roomName != "" {
				openRooms = append(openRooms, roomName)
			}
		}
	}

	if username == "" || requestUserID == "" || sessionID == "" {
		emitActionResult(socket, "initialData", false, "invalid_request", "Missing authentication fields")
		return
	}

	if !cs.isSessionAuthorizedForUser(sessionID, requestUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, requestUserID)
		log.Printf("[%s] ✗ Rejected initial data request by %s (userId=%s, sessionId=%s): %s", socketIDStr, username, requestUserID, sessionIDPreview(sessionID), code)
		emitActionResult(socket, "initialData", false, code, message)
		return
	}

	// Keep presence mapping accurate for online users even if they haven't sent chat messages yet.
	cs.registerUserFromAuth(requestUserID, socketIDStr)

	cs.mu.RLock()
	selectedRoom := currentRoom
	if selectedRoom == "" {
		selectedRoom = cs.roomNameForIDLocked(cs.oldestExtantRoomIDLocked())
	}
	if selectedRoom == "" {
		selectedRoom = defaultRoom
	}
	selectedMessages, hasMore := paginateMessagesBefore(cs.messages[selectedRoom], requestUserID, cs.userJoinedAt[requestUserID], defaultMessageWindowSize, 0, "")
	messagesCopy := make(Messages)
	if len(selectedMessages) > 0 {
		messagesCopy[selectedRoom] = selectedMessages
	}
	roomsCopy := cloneStringSlice(cs.rooms)
	roomsCopy = filterRoomsForUser(roomsCopy, cs.messages, requestUserID)
	userPubKeysCopy := cloneStringMap(cs.userPubKeys)
	userPubKeysUpdatedAtCopy := cloneInt64Map(cs.userPubKeysUpdatedAt)

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

	initialData := map[string]interface{}{
		"messages":               messagesCopy,
		"rooms":                  roomsCopy,
		"loggedInUsers":          loggedInUsers,
		"activeUsers":            activeUsers,
		"userPubKeys":            userPubKeysCopy,
		"userPubKeysUpdatedAt":   userPubKeysUpdatedAtCopy,
		"roomMembers":            roomMembersCopy,
		"userLastSeen":           userLastSeenCopy,
		"currentUserId":          requestUserID,
		"roomNameCiphertexts":    cs.roomNameCiphertextsForRooms(roomsCopy),
		"roomDirectoryUpdatedAt": cs.roomDirectoryUpdatedAtForRooms(roomsCopy),
		"messageWindow": map[string]interface{}{
			"room":    selectedRoom,
			"hasMore": hasMore,
			"limit":   defaultMessageWindowSize,
		},
	}
	cs.attachIdentityDirectories(initialData)
	cs.emitSocketSigned(socket, EventInitialData, initialData)
	emitActionResult(socket, "initialData", true, "ok", "Initial data sent")
	log.Printf("[%s] ✓ Sent filtered initial data to %s (rooms requested: %d, rooms returned: %d)", socketIDStr, username, len(openRooms), len(messagesCopy))

}
