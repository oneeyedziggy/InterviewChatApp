package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/google/uuid"
	socketio "github.com/karagenc/socket.io-go"
)

const (
	maxMessageTextBytes             = 1000
	messageCiphertextExpansionRatio = 3.3
	maxMessageCiphertextBytes       = int(float64(maxMessageTextBytes) * messageCiphertextExpansionRatio)
	maxIdentityCiphertextBytes      = 16384
	signedRequestMaxSkew            = 5 * time.Minute
)

type socketMutationAuth struct {
	Version   string            `json:"version"`
	Event     string            `json:"event"`
	UserID    string            `json:"userId"`
	SessionID string            `json:"sessionId"`
	Timestamp int64             `json:"timestamp"`
	Nonce     string            `json:"nonce"`
	Claims    map[string]string `json:"claims"`
	Signature string            `json:"signature"`
}

func exceedsMessageTextLimit(value string) bool {
	return len([]byte(value)) > maxMessageTextBytes
}

func exceedsMessageCiphertextLimit(value string) bool {
	return len([]byte(value)) > maxMessageCiphertextBytes
}

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

func parseCiphertextMap(raw interface{}, maxValueBytes int) map[string]string {
	source, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}

	result := make(map[string]string, len(source))
	for key, value := range source {
		normalizedKey := strings.TrimSpace(key)
		if normalizedKey == "" {
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		normalizedValue := strings.TrimSpace(text)
		if normalizedValue == "" {
			continue
		}
		if maxValueBytes > 0 && len([]byte(normalizedValue)) > maxValueBytes {
			continue
		}
		result[normalizedKey] = normalizedValue
	}

	if len(result) == 0 {
		return nil
	}

	return result
}

func parseTimestampMap(raw interface{}) map[string]int64 {
	source, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}

	result := make(map[string]int64, len(source))
	for key, value := range source {
		normalizedKey := strings.TrimSpace(key)
		if normalizedKey == "" {
			continue
		}

		var ts int64
		switch typed := value.(type) {
		case float64:
			ts = int64(typed)
		case int64:
			ts = typed
		case int:
			ts = int64(typed)
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err != nil {
				continue
			}
			ts = parsed
		default:
			continue
		}

		if ts > 0 {
			result[normalizedKey] = ts
		}
	}

	if len(result) == 0 {
		return nil
	}

	return result
}

func parseStringField(raw map[string]interface{}, key string) string {
	value, _ := raw[key].(string)
	return strings.TrimSpace(value)
}

func normalizeClaimValue(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%v", typed)
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		bytes, _ := json.Marshal(typed)
		return string(bytes)
	}
}

func getNestedPayloadValue(raw map[string]interface{}, path string) interface{} {
	if path == "" {
		return nil
	}
	parts := strings.Split(path, ".")
	var current interface{} = raw
	for _, part := range parts {
		asMap, ok := current.(map[string]interface{})
		if !ok {
			return nil
		}
		next, exists := asMap[part]
		if !exists {
			return nil
		}
		current = next
	}
	return current
}

func canonicalClaimsString(claims map[string]string) string {
	if len(claims) == 0 {
		return ""
	}
	keys := make([]string, 0, len(claims))
	for key := range claims {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(claims[key]))
		parts = append(parts, key+"="+encoded)
	}
	return strings.Join(parts, "&")
}

func buildSignedRequestInput(auth socketMutationAuth) string {
	version := strings.TrimSpace(auth.Version)
	if version == "" {
		version = "v1"
	}
	return fmt.Sprintf(
		"%s|%s|%s|%s|%d|%s|%s",
		version,
		auth.Event,
		auth.UserID,
		auth.SessionID,
		auth.Timestamp,
		auth.Nonce,
		canonicalClaimsString(auth.Claims),
	)
}

func claimDigest(claims map[string]string) string {
	canonical := canonicalClaimsString(claims)
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:])
}

func (cs *ChatServer) markReplayLocked(replayKey string, now time.Time) bool {
	if replayKey == "" {
		return false
	}
	if _, exists := cs.authReplay[replayKey]; exists {
		return false
	}
	cs.authReplay[replayKey] = now
	cs.authReplayOrder = append(cs.authReplayOrder, replayKey)

	// Trim expired and enforce hard cap to avoid unbounded growth.
	cutoff := now.Add(-signedRequestMaxSkew)
	for len(cs.authReplayOrder) > 0 {
		oldest := cs.authReplayOrder[0]
		ts, exists := cs.authReplay[oldest]
		if exists && ts.After(cutoff) && len(cs.authReplayOrder) <= cs.authReplayLimit {
			break
		}
		delete(cs.authReplay, oldest)
		cs.authReplayOrder = cs.authReplayOrder[1:]
	}

	for len(cs.authReplayOrder) > cs.authReplayLimit {
		oldest := cs.authReplayOrder[0]
		delete(cs.authReplay, oldest)
		cs.authReplayOrder = cs.authReplayOrder[1:]
	}

	return true
}

func (cs *ChatServer) verifySignedMutation(
	socket socketio.ServerSocket,
	raw map[string]interface{},
	expectedEvent string,
	requiredClaims []string,
) (socketMutationAuth, bool) {
	socketIDStr := string(socket.ID())
	authRaw, ok := raw["auth"].(map[string]interface{})
	if !ok {
		log.Printf("[%s] ✗ Missing signed auth envelope for %s", socketIDStr, expectedEvent)
		emitActionResult(socket, expectedEvent, false, "invalid_request", "Missing signed auth envelope")
		return socketMutationAuth{}, false
	}

	auth := socketMutationAuth{
		Version:   parseStringField(authRaw, "version"),
		Event:     parseStringField(authRaw, "event"),
		UserID:    parseStringField(authRaw, "userId"),
		SessionID: parseStringField(authRaw, "sessionId"),
		Nonce:     parseStringField(authRaw, "nonce"),
		Signature: parseStringField(authRaw, "signature"),
		Claims:    make(map[string]string),
	}

	if rawTS, exists := authRaw["timestamp"]; exists {
		switch typed := rawTS.(type) {
		case float64:
			auth.Timestamp = int64(typed)
		case int64:
			auth.Timestamp = typed
		case int:
			auth.Timestamp = int64(typed)
		}
	}

	if claimsRaw, ok := authRaw["claims"].(map[string]interface{}); ok {
		for key, value := range claimsRaw {
			auth.Claims[key] = normalizeClaimValue(value)
		}
	}

	if auth.Version == "" {
		auth.Version = "v1"
	}

	if auth.Event != expectedEvent || auth.UserID == "" || auth.SessionID == "" || auth.Timestamp == 0 || auth.Nonce == "" || auth.Signature == "" {
		log.Printf("[%s] ✗ Invalid signed auth fields for %s", socketIDStr, expectedEvent)
		emitActionResult(socket, expectedEvent, false, "invalid_request", "Invalid signed auth fields")
		return socketMutationAuth{}, false
	}

	now := time.Now()
	if time.UnixMilli(auth.Timestamp).Before(now.Add(-signedRequestMaxSkew)) || time.UnixMilli(auth.Timestamp).After(now.Add(signedRequestMaxSkew)) {
		log.Printf("[%s] ✗ Signed request timestamp skew exceeded for %s", socketIDStr, expectedEvent)
		emitActionResult(socket, expectedEvent, false, "invalid_request", "Signed request expired")
		return socketMutationAuth{}, false
	}

	if !cs.isSessionAuthorizedForUser(auth.SessionID, auth.UserID) {
		code, message := cs.getSessionAuthFailure(auth.SessionID, auth.UserID)
		log.Printf("[%s] ✗ Signed request session mismatch for %s (%s)", socketIDStr, expectedEvent, code)
		emitActionResult(socket, expectedEvent, false, code, message)
		return socketMutationAuth{}, false
	}

	for _, key := range requiredClaims {
		expected := normalizeClaimValue(getNestedPayloadValue(raw, key))
		actual := auth.Claims[key]
		if strings.TrimSpace(actual) == "" {
			log.Printf("[%s] ✗ Signed claim missing for %s key=%s", socketIDStr, expectedEvent, key)
			emitActionResult(socket, expectedEvent, false, "unauthorized", "Signed claim mismatch")
			return socketMutationAuth{}, false
		}
		if expected != actual && strings.TrimSpace(expected) != strings.TrimSpace(actual) {
			log.Printf("[%s] ✗ Signed claim mismatch for %s key=%s", socketIDStr, expectedEvent, key)
			emitActionResult(socket, expectedEvent, false, "unauthorized", "Signed claim mismatch")
			return socketMutationAuth{}, false
		}
	}

	cs.mu.RLock()
	userPubKey := cs.userPubKeys[auth.UserID]
	cs.mu.RUnlock()
	if strings.TrimSpace(userPubKey) == "" {
		log.Printf("[%s] ✗ Missing signer identity for %s", socketIDStr, expectedEvent)
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Signer identity unavailable")
		return socketMutationAuth{}, false
	}

	signingInput := buildSignedRequestInput(auth)
	message := crypto.NewPlainMessageFromString(signingInput)
	publicKey, err := crypto.NewKeyFromArmored(userPubKey)
	if err != nil {
		log.Printf("[%s] ✗ Invalid signer public key for %s: %v", socketIDStr, expectedEvent, err)
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Invalid signer key")
		return socketMutationAuth{}, false
	}
	verifyKeyRing, err := crypto.NewKeyRing(publicKey)
	if err != nil {
		log.Printf("[%s] ✗ Failed to build verify key ring for %s: %v", socketIDStr, expectedEvent, err)
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Invalid signer key")
		return socketMutationAuth{}, false
	}
	signature, err := crypto.NewPGPSignatureFromArmored(auth.Signature)
	if err != nil {
		log.Printf("[%s] ✗ Invalid detached signature encoding for %s: %v", socketIDStr, expectedEvent, err)
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Invalid request signature")
		return socketMutationAuth{}, false
	}
	if err := verifyKeyRing.VerifyDetached(message, signature, now.Unix()); err != nil {
		log.Printf("[%s] ✗ Invalid request signature for %s: %v (claimsDigest=%s)", socketIDStr, expectedEvent, err, claimDigest(auth.Claims))
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Invalid request signature")
		return socketMutationAuth{}, false
	}

	replayKey := fmt.Sprintf("%s:%s:%s", auth.UserID, auth.Event, auth.Nonce)
	cs.mu.Lock()
	allowed := cs.markReplayLocked(replayKey, now)
	cs.mu.Unlock()
	if !allowed {
		log.Printf("[%s] ✗ Replay detected for %s", socketIDStr, expectedEvent)
		emitActionResult(socket, expectedEvent, false, "unauthorized", "Replay detected")
		return socketMutationAuth{}, false
	}

	return auth, true
}

func (cs *ChatServer) resolveUsernameFromPayload(raw map[string]interface{}, userIDKey string) string {
	userID := parseStringField(raw, userIDKey)
	return userID
}

func (cs *ChatServer) resolveRoomFromPayload(raw map[string]interface{}, roomIDKey string) string {
	roomID := parseStringField(raw, roomIDKey)
	if roomID == "" {
		return ""
	}
	cs.mu.RLock()
	roomName := cs.roomsByID[roomID]
	cs.mu.RUnlock()
	if roomName != "" {
		return roomName
	}
	return ""
}

func (cs *ChatServer) roomPayloadConsistent(resolvedRoom, rawRoomID string) bool {
	if resolvedRoom == "" || rawRoomID == "" {
		return false
	}

	cs.mu.RLock()
	mappedRoomID := cs.roomIDs[resolvedRoom]
	cs.mu.RUnlock()

	if mappedRoomID == "" {
		return false
	}

	return rawRoomID == mappedRoomID
}

func (cs *ChatServer) roomExists(resolvedRoom string) bool {
	if resolvedRoom == "" {
		return false
	}

	cs.mu.RLock()
	_, exists := cs.messages[resolvedRoom]
	cs.mu.RUnlock()
	return exists
}

func (cs *ChatServer) attachIdentityDirectories(payload map[string]interface{}) {
	cs.mu.RLock()
	userCiphertexts := make(map[string]string, len(cs.usernameCiphertexts))
	userDirectoryUpdatedAt := make(map[string]int64, len(cs.userDirectoryUpdatedAt))
	for userID, ciphertext := range cs.usernameCiphertexts {
		if userID != "" && ciphertext != "" {
			userCiphertexts[userID] = ciphertext
			if updatedAt := cs.userDirectoryUpdatedAt[userID]; updatedAt > 0 {
				userDirectoryUpdatedAt[userID] = updatedAt
			}
		}
	}
	cs.mu.RUnlock()
	payload["userDirectoryCiphertexts"] = userCiphertexts
	payload["userDirectoryUpdatedAt"] = userDirectoryUpdatedAt
}

func (cs *ChatServer) roomNameCiphertextsForRooms(rooms []string) map[string]string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	result := make(map[string]string)
	for _, room := range rooms {
		roomID := cs.roomIDs[room]
		if roomID == "" {
			roomID = room
		}
		if cipher := cs.roomNameCiphertexts[roomID]; cipher != "" {
			result[roomID] = cipher
		}
	}
	return result
}

func (cs *ChatServer) roomDirectoryUpdatedAtForRooms(rooms []string) map[string]int64 {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	result := make(map[string]int64)
	for _, room := range rooms {
		roomID := cs.roomIDs[room]
		if roomID == "" {
			roomID = room
		}
		if updatedAt := cs.roomDirectoryUpdatedAt[roomID]; updatedAt > 0 {
			result[roomID] = updatedAt
		}
	}
	return result
}

func cloneMessages(src Messages) Messages {
	copyMessages := make(Messages)
	for room, messages := range src {
		copyMessages[room] = make([]Message, len(messages))
		copy(copyMessages[room], messages)
	}
	return copyMessages
}

func cloneStringSlice(src []string) []string {
	copySlice := make([]string, len(src))
	copy(copySlice, src)
	return copySlice
}

func cloneStringMap(src map[string]string) map[string]string {
	copyMap := make(map[string]string, len(src))
	for k, v := range src {
		copyMap[k] = v
	}
	return copyMap
}

func cloneInt64Map(src map[string]int64) map[string]int64 {
	copyMap := make(map[string]int64, len(src))
	for k, v := range src {
		copyMap[k] = v
	}
	return copyMap
}

// sortedConnectedUsersLocked returns active usernames excluding blank/undefined.
func (cs *ChatServer) sortedConnectedUsersLocked() []string {
	users := make([]string, 0, len(cs.users))
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

// snapshotMessageContextLocked captures common response data while cs.mu is held.
func (cs *ChatServer) snapshotMessageContextLocked() (Messages, []string, []string, map[string]string) {
	return cloneMessages(cs.messages), cloneStringSlice(cs.rooms), cs.sortedConnectedUsersLocked(), cloneStringMap(cs.userPubKeys)
}

// snapshotStateForSaveLocked captures maps/slices while cs.mu is already held.
func (cs *ChatServer) snapshotStateForSaveLocked() (Messages, []string, map[string]string, map[string]string) {
	return cloneMessages(cs.messages), cloneStringSlice(cs.rooms), cloneStringMap(cs.users), cloneStringMap(cs.userPubKeys)
}

func buildScopedMessagesForUser(all Messages, userID, defaultRoom, currentRoom string, openRooms []string) Messages {
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
		if !isRoomVisibleToUser(all, room, userID) {
			continue
		}
		messages, exists := all[room]
		if !exists {
			continue
		}
		visible := filterMessagesByVisibility(messages, userID)
		if len(visible) > 0 {
			result[room] = visible
		}
	}

	return result
}

func isRoomVisibleToUser(all Messages, room, userID string) bool {
	if userID == "" {
		return false
	}
	messages, exists := all[room]
	if !exists || len(messages) == 0 {
		return true
	}
	for _, msg := range messages {
		if len(msg.VisibleTo) == 0 {
			continue
		}
		for _, visibleUserID := range msg.VisibleTo {
			if visibleUserID == userID {
				return true
			}
		}
	}
	return true
}

func filterRoomsForUser(rooms []string, messages Messages, userID string) []string {
	filtered := make([]string, 0, len(rooms))
	for _, room := range rooms {
		if isRoomVisibleToUser(messages, room, userID) {
			filtered = append(filtered, room)
		}
	}
	return filtered
}

func parseDMParticipants(room string) (string, string, bool) {
	if !strings.HasPrefix(room, "@dmid:") {
		return "", "", false
	}

	rest := strings.TrimPrefix(room, "@dmid:")
	if strings.TrimSpace(rest) == "" {
		return "", "", false
	}

	parts := strings.SplitN(rest, "|", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	first := strings.TrimSpace(parts[0])
	second := strings.TrimSpace(parts[1])
	if first == "" || second == "" {
		return "", "", false
	}
	return first, second, true
}

func buildDMIntroMessage(room, requestingUser string) (Message, bool) {
	userAID, userBID, ok := parseDMParticipants(room)
	if !ok {
		return Message{}, false
	}

	requestingUserID := requestingUser
	if !strings.Contains(requestingUserID, "-") {
		requestingUserID = ""
	}
	if requestingUserID == "" {
		if userID := strings.TrimSpace(requestingUser); userID != "" {
			requestingUserID = userID
		}
	}

	otherUserID := userAID
	switch requestingUserID {
	case userAID:
		otherUserID = userBID
	case userBID:
		otherUserID = userAID
	}
	otherUserDisplay := formatSystemUserRef(otherUserID)

	return Message{
		ID:        uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Username:  "system",
		Content:   fmt.Sprintf("You are at the beginning of an awesome conversation with %s", otherUserDisplay),
		Edited:    false,
	}, true
}

func buildCanonicalDMRoom(userAID, userBID string) string {
	first := strings.TrimSpace(userAID)
	second := strings.TrimSpace(userBID)
	if strings.ToLower(first) > strings.ToLower(second) {
		first, second = second, first
	}
	return formatRoomName(fmt.Sprintf("@dmid:%s|%s", first, second))
}

func (cs *ChatServer) ensureCanonicalDMRoomLocked(room, requestingUserID string) (string, string, bool) {
	userAID, userBID, ok := parseDMParticipants(room)
	if !ok {
		return "", "", false
	}
	if requestingUserID != userAID && requestingUserID != userBID {
		return "", "", false
	}

	dmRoom := buildCanonicalDMRoom(userAID, userBID)
	roomID := cs.ensureRoomIDLocked(dmRoom)
	created := false

	if _, exists := cs.messages[dmRoom]; !exists {
		created = true
		cs.messages[dmRoom] = []Message{}
		if introMessage, ok := buildDMIntroMessage(dmRoom, requestingUserID); ok {
			introMessage.UserID = SystemUserID
			introMessage.RoomID = roomID
			cs.messages[dmRoom] = append([]Message{introMessage}, cs.messages[dmRoom]...)
		}
	}

	if !contains(cs.rooms, dmRoom) {
		cs.rooms = append(cs.rooms, dmRoom)
	}
	if cs.roomMembers[roomID] == nil {
		cs.roomMembers[roomID] = make(map[string]bool)
	}
	cs.roomMembers[roomID][userAID] = true
	cs.roomMembers[roomID][userBID] = true

	return dmRoom, roomID, created
}

func (cs *ChatServer) isSessionAuthorizedForUser(sessionID, userID string) bool {
	if sessionID == "" || userID == "" {
		return false
	}

	storedUserID, exists := cs.sessionCache.Get(sessionID)
	if !exists || storedUserID == "" {
		return false
	}

	return storedUserID == userID
}

func (cs *ChatServer) emitDebouncedLeave(userID string, deadlineUnixNano int64) {
	if userID == "" {
		return
	}

	time.Sleep(PresenceMsgDebounce)

	cs.mu.Lock()
	pendingDeadline, pending := cs.pendingLeaveByUser[userID]
	if !pending || pendingDeadline != deadlineUnixNano {
		cs.mu.Unlock()
		return
	}

	if sessionID := cs.users[userID]; sessionID != "" {
		delete(cs.pendingLeaveByUser, userID)
		cs.mu.Unlock()
		log.Printf("[presence] Skipped leave message for %s due to quick reconnect", userID)
		return
	}

	delete(cs.pendingLeaveByUser, userID)
	delete(cs.hasSentJoinMsg, userID)
	delete(cs.joinScheduled, userID)

	targetRoomID := cs.oldestExtantRoomIDLocked()
	targetRoom := cs.roomNameForIDLocked(targetRoomID)
	if targetRoom == "" || targetRoomID == "" {
		targetRoom, targetRoomID = cs.systemMessageRoomLocked(DefaultRoom)
	}
	if cs.messages[targetRoom] == nil {
		cs.messages[targetRoom] = []Message{}
	}
	msg := Message{
		ID:        uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Username:  "system",
		UserID:    SystemUserID,
		RoomID:    targetRoomID,
		Content:   fmt.Sprintf("%s %s", formatSystemUserRef(userID), UserLeft),
		Edited:    false,
	}
	cs.messages[targetRoom] = append([]Message{msg}, cs.messages[targetRoom]...)
	if cs.roomMembers[targetRoomID] != nil {
		delete(cs.roomMembers[targetRoomID], userID)
	}
	cs.mu.Unlock()

	if cs.defaultNsp != nil {
		response := map[string]interface{}{
			"messages": map[string][]Message{targetRoom: {msg}},
		}
		cs.emitNamespaceSigned(cs.defaultNsp, EventServerMessage, response)
	}
	cs.broadcastUserListUpdate()
	log.Printf("[presence] ✓ Emitted debounced leave message for %s", userID)
}

func (cs *ChatServer) getSessionAuthFailure(sessionID, userID string) (string, string) {
	if sessionID == "" || userID == "" {
		return "invalid_request", "Missing authentication fields"
	}

	storedUserID, exists := cs.sessionCache.Get(sessionID)
	if !exists || storedUserID == "" {
		return "session_expired", "Session expired"
	}

	if storedUserID != userID {
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

	// Duplicate namespace-scoped handlers were removed.
	// The socket.io library path used by this server requires per-socket registrations,
	// which are defined below in OnConnection and are the canonical handlers.

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

			// Remove user from active users list and schedule a debounced leave message.
			// Quick reconnects (e.g. page refresh) cancel this pending leave.
			cs.mu.Lock()
			var disconnectedUserID string
			var leaveDeadline int64
			for userID, sessionID := range cs.users {
				if sessionID == socketIDStr {
					disconnectedUserID = userID
					delete(cs.userSocketsByID, userID)
					delete(cs.users, userID)
					leaveDeadline = time.Now().Add(PresenceMsgDebounce).UnixNano()
					cs.pendingLeaveByUser[userID] = leaveDeadline
					log.Printf("[%s] ✓ Removed user %s from active users", socketIDStr, userID)

					break
				}
			}

			cs.mu.Unlock()

			if disconnectedUserID != "" && leaveDeadline > 0 {
				go cs.emitDebouncedLeave(disconnectedUserID, leaveDeadline)
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

			msgMap, ok := msg.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid message format received, type: %T", socketIDStr, msg)
				return
			}
			if rawContent, hasContent := msgMap["content"].(string); hasContent && strings.TrimSpace(rawContent) != "" {
				log.Printf("[%s] ✗ Rejected plaintext content in CLIENT_MESSAGE", socketIDStr)
				emitActionResult(socket, "send", false, "invalid_request", "Plaintext content is not allowed")
				return
			}
			auth, verified := cs.verifySignedMutation(socket, msgMap, EventClientMessage, []string{"roomId"})
			if !verified {
				return
			}
			msgMap["userId"] = auth.UserID

			room := cs.resolveRoomFromPayload(msgMap, "roomId")
			roomID := parseStringField(msgMap, "roomId")
			requestedRoomHint := parseStringField(msgMap, "room")
			username := cs.resolveUsernameFromPayload(msgMap, "userId")
			actorUserID := parseStringField(msgMap, "userId")
			content, _ := msgMap["content"].(string)
			replyToRaw, hasReplyTo := msgMap["replyTo"]
			encryptedMessage, _ := msgMap["encryptedMessage"].(string)

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

			messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave := cs.snapshotStateForSaveLocked()
			cs.mu.Unlock()

			// Save to disk
			if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave); err != nil {
				log.Printf("[%s] ✗ Failed to save state: %v", socketIDStr, err)
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
				cs.emitNamespaceSigned(defaultNsp, EventServerMessage, response)
				log.Printf("[%s] ✓ Broadcasted to all other clients", socketIDStr)

				// Also emit directly to sender so they see their own messages
				cs.emitSocketSigned(socket, EventServerMessage, response)
			}
			log.Printf("[%s] ✓ Emitted message update, CLIENT_MESSAGE handler complete", socketIDStr)
		})

		// Register CLIENT_NEW_ROOM handler
		socket.OnEvent(EventClientNewRoom, func(roomName interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_NEW_ROOM EVENT (per-socket) ======", socketIDStr)
			log.Printf("[%s] Received room name: %+v (type: %T)", socketIDStr, roomName, roomName)

			payload, ok := roomName.(map[string]interface{})
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
		})

		socket.OnEvent(EventClientSendPublicKey, func(data interface{}) {
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
					cs.sendToUsers(defaultNsp, activeUsers, EventServerPublicKeyReceived, payload)
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
		})

		socket.OnEvent(EventClientIdentityDirectoryRefresh, func(data interface{}) {
			socketIDStr := string(socket.ID())
			payload, ok := data.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid identity refresh payload", socketIDStr)
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
				existingUpdatedAt := cs.userDirectoryUpdatedAt[userID]
				if existingUpdatedAt > 0 && incomingUpdatedAt < existingUpdatedAt {
					continue
				}
				cs.usernameCiphertexts[userID] = cipher
				cs.userDirectoryUpdatedAt[userID] = incomingUpdatedAt
				acceptedUserCiphertexts[userID] = cipher
				acceptedUserUpdatedAt[userID] = incomingUpdatedAt
			}
			cs.mu.Unlock()

			if len(acceptedRoomCiphertexts) == 0 && len(acceptedUserCiphertexts) == 0 {
				emitActionResult(socket, "identityRefresh", false, "invalid_request", "No valid directory updates accepted")
				return
			}

			cs.mu.RLock()
			messagesCopyForSave := cloneMessages(cs.messages)
			roomsCopyForSave := cloneStringSlice(cs.rooms)
			usersCopyForSave := cloneStringMap(cs.users)
			userPubKeysCopyForSave := cloneStringMap(cs.userPubKeys)
			cs.mu.RUnlock()
			if err := cs.saveState(messagesCopyForSave, roomsCopyForSave, usersCopyForSave, userPubKeysCopyForSave); err != nil {
				log.Printf("[%s] ✗ Failed to save identity refresh state: %v", socketIDStr, err)
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
			log.Printf("[%s] ✓ Identity directory refresh accepted from %s (rooms=%d users=%d)", socketIDStr, actorUserID, len(acceptedRoomCiphertexts), len(acceptedUserCiphertexts))
		})

		socket.OnEvent(EventClientUnblockUserDelta, func(data interface{}) {
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
		})

		socket.OnEvent(EventClientRequestInitialData, func(data interface{}) {
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
				log.Printf("[%s] ✗ Rejected initial data request by %s (%s)", socketIDStr, username, code)
				emitActionResult(socket, "initialData", false, code, message)
				return
			}

			// Keep presence mapping accurate for online users even if they haven't sent chat messages yet.
			cs.registerUserFromAuth(requestUserID, socketIDStr)

			cs.mu.RLock()
			messagesCopy := buildScopedMessagesForUser(cs.messages, requestUserID, defaultRoom, currentRoom, openRooms)
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
			}
			cs.attachIdentityDirectories(initialData)
			cs.emitSocketSigned(socket, EventInitialData, initialData)
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
			visible := filterMessagesByVisibility(roomMessages, requestUserID)
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
			auth, verified := cs.verifySignedMutation(socket, msgMap, EventClientRequestAccess, []string{"userId", "requestAccess.originalSenderId", "requestAccess.originalRoomId", "requestAccess.messageTimestamp"})
			if !verified {
				return
			}
			msgMap["userId"] = auth.UserID

			// Forward the access request to the original poster
			// Note: The room name in the message is a hint, but we'll use @originalSender for the DM room
			requestingUser := cs.resolveUsernameFromPayload(msgMap, "userId")
			requestingUserID := parseStringField(msgMap, "userId")
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

			originalSenderID := parseStringField(requestAccess, "originalSenderId")
			originalSender := cs.resolveUsernameFromPayload(requestAccess, "originalSenderId")
			if requestingUserID == "" || requestingUser == "" || originalSenderID == "" || originalSender == "" {
				log.Printf("[%s] ✗ Missing originalSender identity in requestAccess", socketIDStr)
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
				originalRoomID := parseStringField(requestAccess, "originalRoomId")
				if originalRoomID == "" {
					log.Printf("[%s] ✗ Missing originalRoomId in requestAccess", socketIDStr)
					return
				}
				cs.mu.RLock()
				originalRoom := cs.roomsByID[originalRoomID]
				cs.mu.RUnlock()
				if strings.TrimSpace(originalRoom) == "" {
					log.Printf("[%s] ✗ Unknown originalRoomId in requestAccess", socketIDStr)
					return
				}
				var messageTimestamp int64
				if ts, ok := requestAccess["messageTimestamp"].(float64); ok {
					messageTimestamp = int64(ts)
				} else if ts, ok := requestAccess["messageTimestamp"].(int64); ok {
					messageTimestamp = ts
				} else if ts, ok := requestAccess["messageTimestamp"].(int); ok {
					messageTimestamp = int64(ts)
				}

				cs.mu.Lock()
				// Find the original message content and fail closed if target message doesn't exist.
				originalMessageContent := ""
				foundOriginalMessage := false
				if originalRoomMessages, exists := cs.messages[originalRoom]; exists {
					for _, msg := range originalRoomMessages {
						if msg.Timestamp == messageTimestamp && msg.UserID == originalSenderID {
							foundOriginalMessage = true
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
			_, verified := cs.verifySignedMutation(socket, grantMap, EventClientGrantAccess, []string{"requestingUserId", "originalRoomId", "messageTimestamp", "encryptedMessage"})
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
					if messages[i].Timestamp == messageTimestamp {
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
					if msg.Timestamp == messageTimestamp {
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
		})

		socket.OnEvent(EventClientDeleteMessage, func(deleteData interface{}) {
			socketIDStr := string(socket.ID())
			log.Printf("[%s] ===== CLIENT_DELETE_MESSAGE EVENT (per-socket) ======", socketIDStr)

			deleteMap, ok := deleteData.(map[string]interface{})
			if !ok {
				log.Printf("[%s] ✗ Invalid delete data format, type: %T", socketIDStr, deleteData)
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
