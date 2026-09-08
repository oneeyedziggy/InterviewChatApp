package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestShouldSignServerEvent(t *testing.T) {
	t.Parallel()

	for _, event := range []string{
		EventInitialData,
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
		EventServerIdentityDirectoryRefresh,
	} {
		if !shouldSignServerEvent(event) {
			t.Fatalf("expected %q to require signing", event)
		}
	}

	if shouldSignServerEvent("unknownEvent") {
		t.Fatal("unexpected signing requirement for unknown event")
	}
}

func TestBuildServerSigningInput(t *testing.T) {
	t.Parallel()

	got := buildServerSigningInput(serverOutboundAuth{
		Event:       "serverMessage",
		Timestamp:   123,
		Nonce:       "nonce",
		PayloadHash: "hash",
	})
	if got != "v1|serverMessage|123|nonce|hash" {
		t.Fatalf("unexpected signing input: %s", got)
	}

	got = buildServerSigningInput(serverOutboundAuth{
		Version:     " v2 ",
		Event:       "serverMessage",
		Timestamp:   123,
		Nonce:       "nonce",
		PayloadHash: "hash",
	})
	if got != "v2|serverMessage|123|nonce|hash" {
		t.Fatalf("unexpected explicit version signing input: %s", got)
	}
}

func TestFormatRoomName(t *testing.T) {
	t.Parallel()

	if got := formatRoomName("general"); got != "#general" {
		t.Fatalf("expected #general, got %q", got)
	}
	if got := formatRoomName("@dmid:a|b"); got != "@dmid:a|b" {
		t.Fatalf("expected DM room to pass through unchanged, got %q", got)
	}
}

func TestGenerateSaltHashPasswordAndCompare(t *testing.T) {
	t.Parallel()

	salt := generateSalt()
	if len(salt) != 32 {
		t.Fatalf("expected 32-char salt, got %d", len(salt))
	}
	if salt == generateSalt() {
		t.Fatal("expected generated salts to differ")
	}

	hash1, err := hashPassword("password", "salt")
	if err != nil {
		t.Fatalf("hashPassword failed: %v", err)
	}
	hash2, err := hashPassword("password", "salt")
	if err != nil {
		t.Fatalf("hashPassword failed: %v", err)
	}
	hash3, err := hashPassword("password2", "salt")
	if err != nil {
		t.Fatalf("hashPassword failed: %v", err)
	}
	if hash1 != hash2 {
		t.Fatal("expected deterministic hash for same password/salt")
	}
	if hash1 == hash3 {
		t.Fatal("expected different hash for different password")
	}

	if !constantTimeCompare("abc", "abc") {
		t.Fatal("expected equal strings to compare true")
	}
	if constantTimeCompare("abc", "abcd") {
		t.Fatal("expected different lengths to compare false")
	}
	if constantTimeCompare("abc", "abd") {
		t.Fatal("expected different strings to compare false")
	}
}

func TestFilterMessagesByVisibility(t *testing.T) {
	t.Parallel()

	messages := []Message{
		{ID: "1", UserID: "user-1", Content: "public"},
		{ID: "2", UserID: "user-2", Content: "private", VisibleTo: []string{"user-a"}},
		{ID: "3", UserID: "user-3", Content: "private-b", VisibleTo: []string{"user-b"}},
	}

	filtered := filterMessagesByVisibility(messages, "user-a")
	if len(filtered) != 2 {
		t.Fatalf("expected 2 messages visible to user-a, got %d", len(filtered))
	}
	if filtered[0].ID != "1" || filtered[1].ID != "2" {
		t.Fatalf("unexpected filtered message IDs: %+v", filtered)
	}
}

func TestDMHelpers(t *testing.T) {
	t.Parallel()

	room := buildCanonicalDMRoom("user-b", "user-a")
	if room != "@dmid:user-a|user-b" {
		t.Fatalf("unexpected canonical DM room: %s", room)
	}

	left, right, ok := parseDMParticipants(room)
	if !ok || left != "user-a" || right != "user-b" {
		t.Fatalf("unexpected DM participants: %q %q %v", left, right, ok)
	}

	if _, _, ok := parseDMParticipants("general"); ok {
		t.Fatal("expected non-DM room to fail parsing")
	}

	msg, ok := buildDMIntroMessage(room, "user-a")
	if !ok {
		t.Fatal("expected DM intro message to build")
	}
	if msg.Username != "system" || msg.UserID != "" || !strings.Contains(msg.Content, "userId:user-b") {
		t.Fatalf("unexpected DM intro message: %+v", msg)
	}

	if _, ok := buildDMIntroMessage("general", "user-a"); ok {
		t.Fatal("expected invalid room to fail DM intro creation")
	}
}

func TestRoomSelectionHelpers(t *testing.T) {
	t.Parallel()

	cs := &ChatServer{
		roomIDs: map[string]string{
			"general": "room-general",
			"alpha":   "room-alpha",
			"beta":    "room-beta",
		},
		roomsByID: map[string]string{
			"room-general": "general",
			"room-alpha":   "alpha",
			"room-beta":    "beta",
		},
		roomNameCiphertexts: map[string]string{
			"room-alpha": "cipher-alpha",
		},
		roomDirectoryUpdatedAt: map[string]int64{
			"room-general": 30,
			"room-alpha":   20,
			"room-beta":    10,
		},
		rooms: []string{"general", "alpha", "beta"},
	}

	if got := cs.roomNameForIDLocked("room-alpha"); got != "alpha" {
		t.Fatalf("unexpected room name lookup: %s", got)
	}
	if got := cs.roomNameForIDLocked("missing"); got != "" {
		t.Fatalf("expected missing room ID lookup to return empty string, got %q", got)
	}

	if got := cs.oldestExtantRoomIDLocked(); got != "room-beta" {
		t.Fatalf("expected oldest room ID to be room-beta, got %s", got)
	}

	if room, id := cs.systemMessageRoomLocked("alpha"); room != "alpha" || id != "room-alpha" {
		t.Fatalf("expected preferred room to be used, got %s / %s", room, id)
	}
	if room, id := cs.systemMessageRoomLocked("missing"); room != "general" || id != "room-general" {
		t.Fatalf("expected fallback to default room, got %s / %s", room, id)
	}
	if room, id := cs.systemMessageRoomLocked(""); room != "general" || id != "room-general" {
		t.Fatalf("expected empty preferred room to fall back to default room, got %s / %s", room, id)
	}
	if got := cs.systemMessageRoomIDLocked("alpha"); got != "room-alpha" {
		t.Fatalf("unexpected system message room ID: %s", got)
	}

	if !cs.roomIsAddressableLocked("@dmid:a|b") {
		t.Fatal("expected DM rooms to be addressable")
	}
	if cs.roomIsAddressableLocked("") {
		t.Fatal("expected empty room to be non-addressable")
	}
	if !cs.roomIsAddressableLocked("alpha") {
		t.Fatal("expected named room to be addressable")
	}

	uuidRoom := "123e4567-e89b-12d3-a456-426614174000"
	cs.roomIDs[uuidRoom] = "room-beta"
	if cs.roomIsAddressableLocked(uuidRoom) {
		t.Fatal("expected UUID room without ciphertext to be non-addressable")
	}
	cs.roomNameCiphertexts["room-beta"] = "cipher-beta"
	if !cs.roomIsAddressableLocked(uuidRoom) {
		t.Fatal("expected UUID room with ciphertext to be addressable")
	}

	if got := formatSystemUserRef(" user-123 "); got != "userId:user-123" {
		t.Fatalf("unexpected system user ref: %s", got)
	}
	if got := parseSystemUserRef("userId:user-123"); got != "user-123" {
		t.Fatalf("unexpected parsed system ref: %s", got)
	}
	if got := parseSystemUserRef(" user-123 "); got != "user-123" {
		t.Fatalf("unexpected passthrough system ref: %s", got)
	}
}

func TestEnsureRoomIDLocked(t *testing.T) {
	t.Parallel()

	cs := &ChatServer{
		roomIDs:   map[string]string{"existing": "room-existing"},
		roomsByID: map[string]string{"room-existing": "existing"},
	}

	if got := cs.ensureRoomIDLocked(""); got != "" {
		t.Fatalf("expected empty room to return empty ID, got %q", got)
	}
	if got := cs.ensureRoomIDLocked("existing"); got != "room-existing" {
		t.Fatalf("expected existing room ID, got %q", got)
	}
	if got := cs.ensureRoomIDLocked("@dmid:a|b"); got != "@dmid:a|b" {
		t.Fatalf("expected DM room to self-identify, got %q", got)
	}
	if got := cs.ensureRoomIDLocked("new-room"); got == "" || cs.roomIDs["new-room"] != got || cs.roomsByID[got] != "new-room" {
		t.Fatalf("expected new room mapping to be created, got %q / %+v / %+v", got, cs.roomIDs, cs.roomsByID)
	}
}

func TestSystemMessageRoomLockedFallbackCreatesDefault(t *testing.T) {
	t.Parallel()

	cs := &ChatServer{
		roomIDs:                map[string]string{},
		roomsByID:              map[string]string{},
		roomNameCiphertexts:    map[string]string{},
		roomDirectoryUpdatedAt:  map[string]int64{},
		rooms:                  nil,
	}

	room, roomID := cs.systemMessageRoomLocked("")
	if room != DefaultRoom || roomID == "" {
		t.Fatalf("expected default room fallback, got %s / %s", room, roomID)
	}
	if cs.roomIDs[DefaultRoom] != roomID {
		t.Fatalf("expected default room ID to be created, got %+v", cs.roomIDs)
	}
}

func TestWireNormalizationAndSanitization(t *testing.T) {
	t.Parallel()

	cs := &ChatServer{
		roomIDs: map[string]string{"general": "room-general"},
		roomsByID: map[string]string{
			"room-general": "general",
		},
	}

	if got := cs.roomWireID("general"); got != "room-general" {
		t.Fatalf("unexpected wire room ID: %s", got)
	}

	normalizedRooms := cs.normalizeRoomsForWire([]string{"general", "unknown"}).([]string)
	if len(normalizedRooms) != 2 || normalizedRooms[0] != "room-general" || normalizedRooms[1] != "unknown" {
		t.Fatalf("unexpected normalized rooms: %#v", normalizedRooms)
	}
	normalizedRooms = cs.normalizeRoomsForWire([]interface{}{"general", 123, "unknown"}).([]string)
	if len(normalizedRooms) != 2 || normalizedRooms[0] != "room-general" || normalizedRooms[1] != "unknown" {
		t.Fatalf("unexpected normalized interface rooms: %#v", normalizedRooms)
	}

	messages := map[string][]Message{
		"general": {{UserID: "user-1", Content: "secret"}},
	}
	normalizedMessages := cs.normalizeMessagesForWire(messages).(map[string][]Message)
	if _, ok := normalizedMessages["room-general"]; !ok {
		t.Fatal("expected room-general key after normalization")
	}
	if normalizedMessages["room-general"][0].RoomID != "room-general" {
		t.Fatalf("expected RoomID to be populated, got %+v", normalizedMessages["room-general"][0])
	}
	if got := cs.normalizeMessagesForWire(map[string]interface{}{"general": "value"}).(map[string]interface{}); got["room-general"] != "value" {
		t.Fatalf("unexpected normalized map payload: %#v", got)
	}

	plain := sanitizeMessageForWire(Message{UserID: "user-1", Content: "visible"})
	if plain.Content != "" {
		t.Fatal("expected non-system message content to be cleared")
	}
	system := sanitizeMessageForWire(Message{UserID: SystemUserID, Content: "visible"})
	if system.Content != "visible" {
		t.Fatal("expected system message content to remain")
	}
	if got := sanitizeMessageSliceForWire([]Message{{UserID: "user-1", Content: "x"}, {UserID: SystemUserID, Content: "y"}}); got[0].Content != "" || got[1].Content != "y" {
		t.Fatalf("unexpected sanitized slice: %+v", got)
	}

	sanitized := sanitizeServerPayloadForWire(Messages{"general": {{UserID: "user-1", Content: "x"}}}).(Messages)
	if sanitized["general"][0].Content != "" {
		t.Fatal("expected Messages payload sanitization to clear content")
	}
	if got := sanitizeServerPayloadForWire(map[string]interface{}{"messages": map[string][]Message{"general": {{UserID: "user-1", Content: "x"}}}, "other": "keep"}).(map[string]interface{}); got["other"] != "keep" {
		t.Fatalf("unexpected sanitized payload: %#v", got)
	}

	payload := map[string]interface{}{
		"messages": map[string][]Message{"general": {{UserID: SystemUserID, Content: "y"}}},
		"roomDirectory": map[string]string{"general": "cipher"},
	}
	normalizedPayload := cs.normalizePayloadForWire(payload).(map[string]interface{})
	if _, ok := normalizedPayload["roomDirectory"]; ok {
		t.Fatal("expected roomDirectory to be removed from wire payload")
	}
	if _, ok := normalizedPayload["messages"].(map[string][]Message)["room-general"]; !ok {
		t.Fatal("expected messages key to be normalized in payload")
	}

	// Ensure JSON marshaling of signed payloads can operate on the normalized structure.
	if _, err := json.Marshal(normalizedPayload); err != nil {
		t.Fatalf("expected normalized payload to marshal cleanly: %v", err)
	}

	if !contains([]string{"a", "b"}, "b") || contains([]string{"a", "b"}, "c") {
		t.Fatal("contains helper returned unexpected result")
	}
	if got := formatRoomName(" room "); got != "# room " {
		t.Fatalf("unexpected room formatting: %q", got)
	}
}
