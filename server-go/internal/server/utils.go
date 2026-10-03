package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/google/uuid"
	"golang.org/x/crypto/scrypt"
)

type serverOutboundAuth struct {
	Version     string `json:"version"`
	Event       string `json:"event"`
	Timestamp   int64  `json:"timestamp"`
	Nonce       string `json:"nonce"`
	PayloadHash string `json:"payloadHash"`
	Signature   string `json:"signature"`
}

func shouldSignServerEvent(event string) bool {
	switch event {
	case EventInitialData,
		EventServerMessage,
		EventServerVoteUpdate,
		EventServerNewRoom,
		EventServerUserListUpdate,
		EventServerAccessRequest,
		EventServerAccessDenied,
		EventServerJoinRequest,
		EventServerJoinApproved,
		EventServerJoinDenied,
		EventServerPublicKeyReceived,
		EventServerIdentityDirectoryRefresh:
		return true
	default:
		return false
	}
}

func buildServerSigningInput(auth serverOutboundAuth) string {
	version := strings.TrimSpace(auth.Version)
	if version == "" {
		version = "v1"
	}
	return fmt.Sprintf(
		"%s|%s|%d|%s|%s",
		version,
		auth.Event,
		auth.Timestamp,
		auth.Nonce,
		auth.PayloadHash,
	)
}

func (cs *ChatServer) roomWireID(room string) string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	if roomID, ok := cs.roomIDs[room]; ok && roomID != "" {
		return roomID
	}
	if _, ok := cs.roomsByID[room]; ok {
		return room
	}
	return room
}

func (cs *ChatServer) normalizeRoomsForWire(raw interface{}) interface{} {
	rooms, ok := raw.([]string)
	if ok {
		out := make([]string, 0, len(rooms))
		for _, room := range rooms {
			out = append(out, cs.roomWireID(room))
		}
		return out
	}
	anyRooms, ok := raw.([]interface{})
	if !ok {
		return raw
	}
	out := make([]string, 0, len(anyRooms))
	for _, v := range anyRooms {
		if room, ok := v.(string); ok {
			out = append(out, cs.roomWireID(room))
		}
	}
	return out
}

func (cs *ChatServer) normalizeMessagesForWire(raw interface{}) interface{} {
	msgs, ok := raw.(map[string][]Message)
	if ok {
		out := make(map[string][]Message, len(msgs))
		for room, list := range msgs {
			roomID := cs.roomWireID(room)
			cloned := make([]Message, len(list))
			copy(cloned, list)
			for i := range cloned {
				if cloned[i].RoomID == "" {
					cloned[i].RoomID = roomID
				}
			}
			out[roomID] = cloned
		}
		return out
	}
	anyMsgs, ok := raw.(map[string]interface{})
	if !ok {
		return raw
	}
	out := make(map[string]interface{}, len(anyMsgs))
	for room, value := range anyMsgs {
		out[cs.roomWireID(room)] = value
	}
	return out
}

func (cs *ChatServer) normalizePayloadForWire(data interface{}) interface{} {
	payload, ok := data.(map[string]interface{})
	if !ok {
		return data
	}
	if rooms, exists := payload["rooms"]; exists {
		payload["rooms"] = cs.normalizeRoomsForWire(rooms)
	}
	if messages, exists := payload["messages"]; exists {
		payload["messages"] = cs.normalizeMessagesForWire(messages)
	}
	delete(payload, "roomDirectory")
	return payload
}

func (cs *ChatServer) withServerSignature(event string, data interface{}) interface{} {
	if !shouldSignServerEvent(event) {
		return data
	}

	data = cs.normalizePayloadForWire(data)

	payload, ok := data.(map[string]interface{})
	if !ok {
		return data
	}

	delete(payload, "serverAuth")
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[withServerSignature] ✗ Failed to marshal payload for event %s: %v", event, err)
		return data
	}
	hash := sha256.Sum256(payloadJSON)
	payloadHash := hex.EncodeToString(hash[:])

	auth := serverOutboundAuth{
		Version:     "v1",
		Event:       event,
		Timestamp:   time.Now().UnixMilli(),
		Nonce:       uuid.NewString(),
		PayloadHash: payloadHash,
	}

	message := crypto.NewPlainMessageFromString(buildServerSigningInput(auth))
	signature, err := cs.serverKeyRing.SignDetached(message)
	if err != nil {
		log.Printf("[withServerSignature] ✗ Failed to sign payload for event %s: %v", event, err)
		return data
	}
	armoredSig, err := signature.GetArmored()
	if err != nil {
		log.Printf("[withServerSignature] ✗ Failed to armor signature for event %s: %v", event, err)
		return data
	}
	auth.Signature = armoredSig
	payload["serverAuth"] = auth
	return payload
}

func sanitizeMessageForWire(message Message) Message {
	if message.UserID != SystemUserID {
		message.Content = ""
	}
	return message
}

func sanitizeMessageSliceForWire(messages []Message) []Message {
	sanitized := make([]Message, len(messages))
	for index, message := range messages {
		sanitized[index] = sanitizeMessageForWire(message)
	}
	return sanitized
}

func sanitizeMessagesForWire(messages Messages) Messages {
	sanitized := make(Messages, len(messages))
	for room, roomMessages := range messages {
		sanitized[room] = sanitizeMessageSliceForWire(roomMessages)
	}
	return sanitized
}

func sanitizeServerPayloadForWire(data interface{}) interface{} {
	switch typed := data.(type) {
	case Messages:
		return sanitizeMessagesForWire(typed)
	case map[string][]Message:
		sanitized := make(map[string][]Message, len(typed))
		for room, roomMessages := range typed {
			sanitized[room] = sanitizeMessageSliceForWire(roomMessages)
		}
		return sanitized
	case map[string]interface{}:
		sanitized := make(map[string]interface{}, len(typed))
		for key, value := range typed {
			if key == "messages" {
				sanitized[key] = sanitizeServerPayloadForWire(value)
				continue
			}
			sanitized[key] = value
		}
		return sanitized
	default:
		return data
	}
}

func (cs *ChatServer) emitNamespaceSigned(defaultNsp *wsrt.Namespace, event string, data interface{}) {
	if defaultNsp == nil {
		return
	}
	defaultNsp.Emit(event, cs.withServerSignature(event, sanitizeServerPayloadForWire(data)))
}

func (cs *ChatServer) emitBroadcastSigned(operator *wsrt.BroadcastOperator, event string, data interface{}) {
	if operator == nil {
		return
	}
	operator.Emit(event, cs.withServerSignature(event, sanitizeServerPayloadForWire(data)))
}

func (cs *ChatServer) emitNamespaceRoomSigned(defaultNsp *wsrt.Namespace, room wsrt.Room, event string, data interface{}) {
	if defaultNsp == nil {
		return
	}
	defaultNsp.To(room).Emit(event, cs.withServerSignature(event, sanitizeServerPayloadForWire(data)))
}

func (cs *ChatServer) emitSocketSigned(socket wsrt.ServerSocket, event string, data interface{}) {
	socket.Emit(event, cs.withServerSignature(event, sanitizeServerPayloadForWire(data)))
}
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func formatRoomName(roomNameStr string) string {
	if strings.HasPrefix(roomNameStr, "@") {
		return roomNameStr
	}
	return "#" + roomNameStr
}

func generateSalt() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

// sessionIDPreview returns a short, log-safe fingerprint of a session ID
// (or any other secret token) so auth diagnostics can correlate values
// across log lines without leaking the full session credential.
func sessionIDPreview(id string) string {
	if id == "" {
		return "<empty>"
	}
	if len(id) <= 8 {
		return id
	}
	return id[:8] + "…"
}

func hashPassword(password, salt string) (string, error) {
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

func (cs *ChatServer) sendToUserIDs(defaultNsp *wsrt.Namespace, userIDs []string, event string, data interface{}) {
	if defaultNsp == nil {
		log.Printf("[sendToUserIDs] ✗ defaultNsp is nil, cannot send event %s", event)
		return
	}

	cs.mu.RLock()
	defer cs.mu.RUnlock()

	log.Printf("[sendToUserIDs] Attempting to send %s to user IDs: %v", event, userIDs)
	log.Printf("[sendToUserIDs] Current socket map size: %d", len(cs.userSocketsByID))

	for _, userID := range userIDs {
		if userID == "" {
			continue
		}
		socketID, exists := cs.userSocketsByID[userID]
		if !exists || socketID == "" {
			log.Printf("[sendToUserIDs] ✗ UserID %s not found in active sockets", userID)
			continue
		}
		cs.emitNamespaceRoomSigned(defaultNsp, wsrt.Room(socketID), event, data)
		log.Printf("[sendToUserIDs] ✓ Sent %s to userID %s (socketID: %s)", event, userID, socketID)
	}
}

func filterMessagesByVisibility(messages []Message, userID string) []Message {
	filtered := []Message{}
	for _, msg := range messages {
		if len(msg.VisibleTo) == 0 {
			filtered = append(filtered, msg)
			continue
		}
		for _, visibleUserID := range msg.VisibleTo {
			if visibleUserID == userID {
				filtered = append(filtered, msg)
				break
			}
		}
	}
	return filtered
}
