package server

import (
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/google/uuid"
)

func (cs *ChatServer) handleNewRoom(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	log.Printf("[%s] ===== CLIENT_NEW_ROOM EVENT (per-socket) ======", socketIDStr)
	log.Printf("[%s] Received room name: %+v (type: %T)", socketIDStr, data, data)

	payload, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid room payload format (strict mode requires object payload)", socketIDStr)
		return
	}
	auth, verified := cs.verifySignedMutation(socket, payload, EventClientNewRoom, []string{"roomNameCiphertext", "roomNameHash", "roomDirectoryUpdatedAt"})
	if !verified {
		return
	}
	requestingUserID := auth.UserID
	roomNameCiphertext := parseStringField(payload, "roomNameCiphertext")
	roomNameHash := parseStringField(payload, "roomNameHash")
	if requestingUserID == "" || roomNameCiphertext == "" || roomNameHash == "" {
		log.Printf("[%s] ✗ Missing required identity fields for new room", socketIDStr)
		emitActionResult(socket, "newRoom", false, "invalid_request", "Missing required room metadata")
		return
	}

	roomID := ""
	formattedRoom := ""
	appliedRoomCiphertext := roomNameCiphertext
	appliedRoomUpdatedAt := int64(0)
	created := false
	roomDirectoryUpdatedAt := int64(0)
	switch typed := payload["roomDirectoryUpdatedAt"].(type) {
	case float64:
		roomDirectoryUpdatedAt = int64(typed)
	case int64:
		roomDirectoryUpdatedAt = typed
	case int:
		roomDirectoryUpdatedAt = int64(typed)
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			roomDirectoryUpdatedAt = parsed
		}
	}
	if roomDirectoryUpdatedAt <= 0 {
		roomDirectoryUpdatedAt = time.Now().UTC().UnixMilli()
	}

	cs.mu.Lock()
	requestingUser := requestingUserID
	if cs.roomNameHashes == nil {
		cs.roomNameHashes = make(map[string]string)
	}
	if cs.roomNameCiphertexts == nil {
		cs.roomNameCiphertexts = make(map[string]string)
	}

	if existingRoomID, exists := cs.roomNameHashes[roomNameHash]; exists && existingRoomID != "" {
		roomID = existingRoomID
		formattedRoom = cs.roomsByID[roomID]
		if formattedRoom == "" {
			for knownRoom, knownRoomID := range cs.roomIDs {
				if knownRoomID == roomID {
					formattedRoom = knownRoom
					break
				}
			}
		}
		if formattedRoom == "" {
			formattedRoom = DefaultRoom
		}
		existingUpdatedAt := cs.roomDirectoryUpdatedAt[roomID]
		if existingCiphertext := cs.roomNameCiphertexts[roomID]; existingCiphertext != "" {
			appliedRoomCiphertext = existingCiphertext
			appliedRoomUpdatedAt = existingUpdatedAt
		} else if existingUpdatedAt == 0 || roomDirectoryUpdatedAt >= existingUpdatedAt {
			cs.roomNameCiphertexts[roomID] = roomNameCiphertext
			cs.roomDirectoryUpdatedAt[roomID] = roomDirectoryUpdatedAt
			appliedRoomUpdatedAt = roomDirectoryUpdatedAt
		} else {
			appliedRoomUpdatedAt = existingUpdatedAt
		}
		if appliedRoomUpdatedAt == 0 {
			appliedRoomUpdatedAt = cs.roomDirectoryUpdatedAt[roomID]
		}
		cs.roomIDs[formattedRoom] = roomID
		cs.roomsByID[roomID] = formattedRoom
	} else {
		roomID = uuid.NewString()
		formattedRoom = roomID

		if !isRoomVisibleToUser(cs.messages, formattedRoom, requestingUserID) {
			cs.mu.Unlock()
			log.Printf("[%s] ✗ Rejected DM room creation by non-participant user=%s room=%s", socketIDStr, requestingUser, formattedRoom)
			return
		}

		cs.rooms = append(cs.rooms, formattedRoom)
		cs.roomIDs[formattedRoom] = roomID
		cs.roomsByID[roomID] = formattedRoom
		cs.roomNameCiphertexts[roomID] = roomNameCiphertext
		cs.roomDirectoryUpdatedAt[roomID] = roomDirectoryUpdatedAt
		cs.roomNameHashes[roomNameHash] = roomID
		appliedRoomUpdatedAt = roomDirectoryUpdatedAt
		cs.messages[formattedRoom] = []Message{}
		if introMessage, ok := buildDMIntroMessage(formattedRoom, requestingUserID); ok {
			introMessage.UserID = SystemUserID
			introMessage.RoomID = cs.ensureRoomIDLocked(formattedRoom)
			cs.messages[formattedRoom] = append([]Message{introMessage}, cs.messages[formattedRoom]...)
		}
		if cs.roomMembers[roomID] == nil {
			cs.roomMembers[roomID] = make(map[string]bool)
		}
		created = true
		log.Printf("[%s] ✓ Created new room id=%s", socketIDStr, roomID)
	}
	sortedRooms := cs.alphabeticalSort(cs.rooms)
	roomMessages := make([]Message, len(cs.messages[formattedRoom]))
	copy(roomMessages, cs.messages[formattedRoom])
	cs.mu.Unlock()

	if userAID, userBID, ok := parseDMParticipants(formattedRoom); ok {
		for _, participantID := range []string{userAID, userBID} {
			payload := map[string]interface{}{
				"messages": map[string][]Message{
					formattedRoom: filterMessagesByVisibility(roomMessages, participantID),
				},
				"rooms": filterRoomsForUser(sortedRooms, cs.messages, participantID),
				"roomNameCiphertexts": map[string]string{
					roomID: appliedRoomCiphertext,
				},
				"roomDirectoryUpdatedAt": map[string]int64{
					roomID: appliedRoomUpdatedAt,
				},
			}
			cs.attachIdentityDirectories(payload)
			cs.sendToUserIDs(defaultNsp, []string{participantID}, EventServerNewRoom, payload)
		}
		log.Printf("[%s] ✓ Sent DM room update only to participants", socketIDStr)
		return
	}

	response := map[string]interface{}{
		"rooms": sortedRooms,
		"roomNameCiphertexts": map[string]string{
			roomID: appliedRoomCiphertext,
		},
		"roomDirectoryUpdatedAt": map[string]int64{
			roomID: appliedRoomUpdatedAt,
		},
	}
	cs.attachIdentityDirectories(response)

	log.Printf("[%s] Broadcasting SERVER_NEW_ROOM with %d rooms", socketIDStr, len(sortedRooms))
	cs.emitNamespaceSigned(defaultNsp, EventServerNewRoom, response)
	cs.emitSocketSigned(socket, EventServerNewRoom, response)
	if created {
		emitActionResult(socket, "newRoom", true, "ok", "Room created")
	} else {
		emitActionResult(socket, "newRoom", true, "ok", "Room already exists")
	}
	log.Printf("[%s] ✓ SERVER_NEW_ROOM sent", socketIDStr)

}

func (cs *ChatServer) handleRequestRoomData(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	payload, ok := data.(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Invalid room data request payload", socketIDStr)
		return
	}

	username := cs.resolveUsernameFromPayload(payload, "userId")
	requestUserID := parseStringField(payload, "userId")
	sessionID, _ := payload["sessionId"].(string)
	requestedRoomHint := parseStringField(payload, "room")
	room := cs.resolveRoomFromPayload(payload, "roomId")
	roomID := parseStringField(payload, "roomId")

	if username == "" {
		username = requestUserID
	}
	if roomID == "" && requestedRoomHint != "" {
		roomID = requestedRoomHint
	}

	missingFields := make([]string, 0, 4)
	if username == "" {
		missingFields = append(missingFields, "username|userId")
	}
	if requestUserID == "" {
		missingFields = append(missingFields, "userId")
	}
	if sessionID == "" {
		missingFields = append(missingFields, "sessionId")
	}
	if roomID == "" {
		missingFields = append(missingFields, "roomId|room")
	}

	if len(missingFields) > 0 {
		payloadKeys := make([]string, 0, len(payload))
		for key := range payload {
			payloadKeys = append(payloadKeys, key)
		}
		sort.Strings(payloadKeys)
		log.Printf("[%s] ✗ roomData missing required fields: %s", socketIDStr, strings.Join(missingFields, ", "))
		log.Printf("[%s] roomData payload diagnostics: userId=%q username=%q sessionIdPresent=%t roomHint=%q roomId=%q resolvedRoom=%q payloadKeys=%v", socketIDStr, requestUserID, username, sessionID != "", requestedRoomHint, roomID, room, payloadKeys)
		emitActionResult(
			socket,
			"roomData",
			false,
			"invalid_request",
			fmt.Sprintf("Missing required fields: %s (expected: userId, sessionId, roomId or room hint)", strings.Join(missingFields, ", ")),
		)
		return
	}

	if !cs.isSessionAuthorizedForUser(sessionID, requestUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, requestUserID)
		log.Printf("[%s] ✗ Rejected room data request by %s (%s)", socketIDStr, username, code)
		emitActionResult(socket, "roomData", false, code, message)
		return
	}

	createdRoom := false
	if room == "" {
		candidateRoom := requestedRoomHint
		if candidateRoom == "" {
			candidateRoom = roomID
		}

		cs.mu.RLock()
		_, candidateExistsByName := cs.messages[candidateRoom]
		cs.mu.RUnlock()
		if candidateExistsByName {
			room = candidateRoom
			roomID = cs.ensureRoomID(candidateRoom)
		}

		if room == "" {
			cs.mu.Lock()
			if dmRoom, dmRoomID, created := cs.ensureCanonicalDMRoomLocked(candidateRoom, requestUserID); dmRoom != "" {
				room = dmRoom
				roomID = dmRoomID
				createdRoom = created
			}
			messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy := cs.snapshotStateForSaveLocked()
			cs.mu.Unlock()

			if room == "" {
				log.Printf("[%s] ✗ roomData could not resolve room after bootstrap: userId=%q roomHint=%q roomId=%q", socketIDStr, requestUserID, requestedRoomHint, roomID)
				emitActionResult(
					socket,
					"roomData",
					false,
					"invalid_request",
					fmt.Sprintf("Unable to resolve room from payload (roomHint=%q, roomId=%q)", requestedRoomHint, roomID),
				)
				return
			}

			if createdRoom {
				if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopy); err != nil {
					log.Printf("[%s] ✗ Failed to save DM room bootstrap state: %v", socketIDStr, err)
				}
			}
		}
	}

	if !isRoomVisibleToUser(cs.messages, room, requestUserID) {
		log.Printf("[%s] ✗ Rejected room data request by non-participant user=%s room=%s", socketIDStr, username, room)
		emitActionResult(socket, "roomData", false, "unauthorized", "Unauthorized room access")
		return
	}

	cs.mu.RLock()
	roomMessages := cs.messages[room]
	visible := filterMessagesForJoinTime(
		roomMessages,
		requestUserID,
		cs.userJoinedAt[requestUserID],
	)
	cs.mu.RUnlock()

	delta := make(Messages)
	if len(visible) > 0 {
		delta[room] = visible
	}

	response := map[string]interface{}{
		"messages": delta,
	}
	if createdRoom {
		cs.mu.RLock()
		roomsCopy := filterRoomsForUser(cloneStringSlice(cs.rooms), cs.messages, requestUserID)
		roomNameCiphertexts := cs.roomNameCiphertextsForRooms(roomsCopy)
		roomDirectoryUpdatedAt := cs.roomDirectoryUpdatedAtForRooms(roomsCopy)
		cs.mu.RUnlock()
		response["rooms"] = roomsCopy
		response["roomNameCiphertexts"] = roomNameCiphertexts
		response["roomDirectoryUpdatedAt"] = roomDirectoryUpdatedAt
	}
	cs.attachIdentityDirectories(response)
	cs.emitSocketSigned(socket, EventServerMessage, response)
	emitActionResult(socket, "roomData", true, "ok", "Room data sent")
	log.Printf("[%s] ✓ Sent lazy room data to %s for room %s (%d messages)", socketIDStr, username, room, len(visible))

}

func (cs *ChatServer) handleRequestRoomWindow(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	payload, ok := data.(map[string]interface{})
	if !ok {
		return
	}
	requestUserID := parseStringField(payload, "userId")
	sessionID := parseStringField(payload, "sessionId")
	roomID := parseStringField(payload, "roomId")
	room := cs.resolveRoomFromPayload(payload, "roomId")
	if room == "" {
		room = parseStringField(payload, "room")
	}
	if requestUserID == "" || sessionID == "" || roomID == "" {
		emitActionResult(socket, "roomWindow", false, "invalid_request", "Missing userId, sessionId, or roomId")
		return
	}
	if !cs.isSessionAuthorizedForUser(sessionID, requestUserID) {
		code, message := cs.getSessionAuthFailure(sessionID, requestUserID)
		emitActionResult(socket, "roomWindow", false, code, message)
		return
	}
	if room == "" || !isRoomVisibleToUser(cs.messages, room, requestUserID) {
		emitActionResult(socket, "roomWindow", false, "unauthorized", "Unauthorized room access")
		return
	}

	limit := defaultMessageWindowSize
	if rawLimit, ok := payload["limit"].(float64); ok {
		limit = int(rawLimit)
	}
	beforeTimestamp := int64(0)
	if rawTimestamp, ok := payload["beforeTimestamp"].(float64); ok {
		beforeTimestamp = int64(rawTimestamp)
	}
	beforeMessageID := parseStringField(payload, "beforeMessageId")

	cs.mu.RLock()
	window, hasMore := paginateMessagesBefore(cs.messages[room], requestUserID, cs.userJoinedAt[requestUserID], limit, beforeTimestamp, beforeMessageID)
	cs.mu.RUnlock()
	response := map[string]interface{}{
		"messages":               Messages{room: window},
		"roomId":                 roomID,
		"hasMore":                hasMore,
		"messageWindowDirection": "older",
	}
	cs.attachIdentityDirectories(response)
	cs.emitSocketSigned(socket, EventServerMessage, response)
	emitActionResult(socket, "roomWindow", true, "ok", "Room window sent")

}

func (cs *ChatServer) handleLeaveRoom(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	log.Printf("[%s] ===== CLIENT_LEAVE_ROOM EVENT ======", socketIDStr)
	// Room leaving is handled client-side, server just logs it

}

func (cs *ChatServer) handleRejoinRoom(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {
	socketIDStr := string(socket.ID())
	log.Printf("[%s] ===== CLIENT_REJOIN_ROOM EVENT ======", socketIDStr)
	// Room rejoining is handled client-side, server just logs it

}
