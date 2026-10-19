package server

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

	wsrt "chat-server-go/websocket"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/google/uuid"
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
	socket wsrt.ServerSocket,
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
		log.Printf("[%s] ✗ Signed request session mismatch for %s (userId=%s, sessionId=%s): %s", socketIDStr, expectedEvent, auth.UserID, sessionIDPreview(auth.SessionID), code)
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
	started := time.Now()
	messages := cloneMessages(cs.messages)
	rooms := cloneStringSlice(cs.rooms)
	users := cloneStringMap(cs.users)
	userPublicKeys := cloneStringMap(cs.userPubKeys)
	cs.persistenceMetrics.recordSnapshot(time.Since(started), countMessages(messages))
	return messages, rooms, users, userPublicKeys
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

const defaultMessageWindowSize = 100

func paginateMessagesBefore(messages []Message, userID string, joinedAt int64, limit int, beforeTimestamp int64, beforeMessageID string) ([]Message, bool) {
	if limit <= 0 || limit > 500 {
		limit = defaultMessageWindowSize
	}
	visible := filterMessagesForJoinTime(messages, userID, joinedAt)
	filtered := make([]Message, 0, len(visible))
	for _, message := range visible {
		// When beforeMessageID is unknown, exclude the whole equal-timestamp
		// boundary to avoid re-returning the same message forever.
		if beforeTimestamp > 0 && (message.Timestamp > beforeTimestamp ||
			(message.Timestamp == beforeTimestamp && (beforeMessageID == "" || message.ID >= beforeMessageID))) {
			continue
		}
		filtered = append(filtered, message)
	}
	if len(filtered) <= limit {
		return filtered, false
	}
	return filtered[len(filtered)-limit:], true
}

func filterMessagesForJoinTime(messages []Message, userID string, joinedAt int64) []Message {
	visible := filterMessagesByVisibility(messages, userID)
	joinMessageIndex := -1
	joinMarker := fmt.Sprintf("%s %s", formatSystemUserRef(userID), UserJoined)
	for index, message := range visible {
		if message.UserID == SystemUserID && message.Content == joinMarker {
			joinMessageIndex = index
			break
		}
	}
	if joinMessageIndex < 0 && joinedAt <= 0 {
		return []Message{}
	}
	filtered := make([]Message, 0, len(visible))
	for index, message := range visible {
		if joinMessageIndex >= 0 {
			if index <= joinMessageIndex {
				filtered = append(filtered, message)
			}
			continue
		}
		if message.Timestamp >= joinedAt {
			filtered = append(filtered, message)
		}
	}
	return filtered
}

func isRoomVisibleToUser(all Messages, room, userID string) bool {
	if userID == "" {
		return false
	}
	if strings.HasPrefix(room, "@dmid:") {
		first, second, valid := parseDMParticipants(room)
		return valid && (userID == first || userID == second)
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

	// Touch keeps an actively used session alive without any dedicated refresh call.
	storedUserID, _, exists := cs.sessionCache.Touch(sessionID)
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
		log.Printf("[auth] ✗ Missing session auth fields: sessionId=%s userId=%q", sessionIDPreview(sessionID), userID)
		return "invalid_request", "Missing authentication fields"
	}

	storedUserID, exists := cs.sessionCache.Get(sessionID)
	if !exists || storedUserID == "" {
		log.Printf("[auth] ✗ Unknown/expired session: sessionId=%s claimedUserId=%q (session cache size=%d)", sessionIDPreview(sessionID), userID, cs.sessionCache.Len())
		return "session_expired", "Session expired"
	}

	if storedUserID != userID {
		log.Printf("[auth] ✗ Session/user mismatch: sessionId=%s belongsToUserId=%q claimedUserId=%q — the client is presenting a sessionId that was issued for a different account (stale/cross-account localStorage?)", sessionIDPreview(sessionID), storedUserID, userID)
		return "unauthorized", "Unauthorized"
	}

	return "", ""
}

func emitActionResult(
	socket wsrt.ServerSocket,
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

func (cs *ChatServer) SetupSocketHandlers(sio *wsrt.Server) {
	log.Println("===== SETTING UP SOCKET HANDLERS =====")

	// Get the default namespace
	defaultNsp := sio.Of("/")

	cs.mu.Lock()
	cs.defaultNsp = defaultNsp
	cs.mu.Unlock()

	// Duplicate namespace-scoped handlers were removed.
	// The websocket transport used by this server requires per-socket registrations,
	// which are defined below in OnConnection and are the canonical handlers.

	// Register per-socket connection handler
	defaultNsp.OnConnection(func(socket wsrt.ServerSocket) {
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
		socket.Join(wsrt.Room(socketIDStr))
		log.Printf("[%s] ✓ Joined personal delivery room", socketIDStr)

		// Register disconnect handler for this socket
		socket.OnDisconnect(func(reason wsrt.Reason) {
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
		socket.OnEvent(EventClientMessage, func(data interface{}) { cs.handleClientMessage(socket, data, defaultNsp) })

		// Register CLIENT_NEW_ROOM handler
		socket.OnEvent(EventClientNewRoom, func(roomName interface{}) { cs.handleNewRoom(socket, roomName, defaultNsp) })

		socket.OnEvent(EventClientSendPublicKey, func(data interface{}) { cs.handleSendPublicKey(socket, data, defaultNsp) })

		socket.OnEvent(EventClientIdentityDirectoryRefresh, func(data interface{}) { cs.handleIdentityDirectoryRefresh(socket, data, defaultNsp) })

		socket.OnEvent(EventClientUnblockUserDelta, func(data interface{}) { cs.handleUnblockUserDelta(socket, data, defaultNsp) })

		socket.OnEvent(EventClientRequestInitialData, func(data interface{}) { cs.handleRequestInitialData(socket, data, defaultNsp) })

		socket.OnEvent(EventClientRequestRoomData, func(data interface{}) { cs.handleRequestRoomData(socket, data, defaultNsp) })

		socket.OnEvent(EventClientRequestRoomWindow, func(data interface{}) { cs.handleRequestRoomWindow(socket, data, defaultNsp) })

		// Register CLIENT_DISCONNECTING handler
		// Register CLIENT_REQUEST_ACCESS handler
		socket.OnEvent(EventClientRequestAccess, func(msg interface{}) { cs.handleRequestAccess(socket, msg, defaultNsp) })

		// Register CLIENT_GRANT_ACCESS handler
		socket.OnEvent(EventClientGrantAccess, func(grantData interface{}) { cs.handleGrantAccess(socket, grantData, defaultNsp) })

		// Register CLIENT_DENY_ACCESS handler
		socket.OnEvent(EventClientDenyAccess, func(denyData interface{}) { cs.handleDenyAccess(socket, denyData, defaultNsp) })

		// Register CLIENT_LEAVE_ROOM handler (client-side only, just acknowledge)
		socket.OnEvent(EventClientLeaveRoom, func(leaveData interface{}) { cs.handleLeaveRoom(socket, leaveData, defaultNsp) })

		// Register CLIENT_REJOIN_ROOM handler (client-side only, just acknowledge)
		socket.OnEvent(EventClientRejoinRoom, func(rejoinData interface{}) { cs.handleRejoinRoom(socket, rejoinData, defaultNsp) })

		// Register CLIENT_VOTE_JOIN handler
		// Register vote message handler (per-socket)
		socket.OnEvent(EventClientVoteMessage, func(voteData interface{}) { cs.handleVoteMessage(socket, voteData, defaultNsp) })

		// Register edit message handler (per-socket)
		socket.OnEvent(EventClientEditMessage, func(editData interface{}) { cs.handleEditMessage(socket, editData, defaultNsp) })

		socket.OnEvent(EventClientDeleteMessage, func(deleteData interface{}) { cs.handleDeleteMessage(socket, deleteData, defaultNsp) })

		socket.OnEvent(EventClientVoteJoin, func(voteData interface{}) { cs.handleVoteJoin(socket, voteData, defaultNsp) })

		socket.OnEvent(EventClientDisconnecting, func(sessionID interface{}) { cs.handleDisconnecting(socket, sessionID, defaultNsp) })

		log.Printf("[%s] ✓ Per-socket event handlers registered", socketIDStr)

		// Send a lightweight status ping after connection.
		// Initial data is sent in response to EventClientRequestInitialData.
		go func() {
			time.Sleep(50 * time.Millisecond) // Small delay to ensure connection is ready

			socket.Emit(EventStatus, "Hello from WebSocket")
			log.Printf("[%s] ✓ STATUS ping sent; awaiting initial data request", socketIDStr)
		}()
	})
	// Note: Disconnect handlers are registered per-socket in OnConnection

	log.Println("===== SOCKET HANDLERS SETUP COMPLETE =====")
}
