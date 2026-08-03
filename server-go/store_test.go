package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFileStoreLoadMissingFile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.json")
	store := NewFileStore(path)

	messages, rooms, users, userPubKeys, userPubKeysUpdatedAt, userIDs, roomIDs, roomNameHashes, roomNameCiphertexts, usernameCiphertexts, userDirectoryUpdatedAt, roomDirectoryUpdatedAt, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(messages) != 0 || len(rooms) != 0 || len(users) != 0 || len(userPubKeys) != 0 || len(userPubKeysUpdatedAt) != 0 || len(userIDs) != 0 || len(roomIDs) != 0 || len(roomNameHashes) != 0 || len(roomNameCiphertexts) != 0 || len(usernameCiphertexts) != 0 || len(userDirectoryUpdatedAt) != 0 || len(roomDirectoryUpdatedAt) != 0 {
		t.Fatal("expected empty state when file is missing")
	}
}

func TestFileStoreSaveAndLoadRoundTrip(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.json")
	store := NewFileStore(path)

	messages := Messages{
		"general": {{ID: "msg-1", Timestamp: 1, UserID: "user-1", RoomID: "room-1", Content: "hello"}},
	}
	rooms := []string{"general"}
	users := map[string]string{"user-1": "alice"}
	userPubKeys := map[string]string{"user-1": "pubkey"}
	userPubKeysUpdatedAt := map[string]int64{"user-1": 123}
	userIDs := map[string]string{"alice": "user-1"}
	roomIDs := map[string]string{"general": "room-1"}
	roomNameHashes := map[string]string{"hash": "room-1"}
	roomNameCiphertexts := map[string]string{"room-1": "cipher"}
	usernameCiphertexts := map[string]string{"user-1": "cipher-user"}
	userDirectoryUpdatedAt := map[string]int64{"user-1": 456}
	roomDirectoryUpdatedAt := map[string]int64{"room-1": 789}

	if err := store.SaveWithIdentity(messages, rooms, users, userPubKeys, userPubKeysUpdatedAt, userIDs, roomIDs, roomNameHashes, roomNameCiphertexts, usernameCiphertexts, userDirectoryUpdatedAt, roomDirectoryUpdatedAt); err != nil {
		t.Fatalf("SaveWithIdentity failed: %v", err)
	}

	loadedMessages, loadedRooms, loadedUsers, loadedUserPubKeys, loadedUserPubKeysUpdatedAt, loadedUserIDs, loadedRoomIDs, loadedRoomNameHashes, loadedRoomNameCiphertexts, loadedUsernameCiphertexts, loadedUserDirectoryUpdatedAt, loadedRoomDirectoryUpdatedAt, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loadedMessages["general"][0].Content != "hello" || loadedMessages["general"][0].RoomID != "room-1" {
		t.Fatalf("unexpected loaded messages: %+v", loadedMessages)
	}
	if len(loadedRooms) != 1 || loadedRooms[0] != "general" {
		t.Fatalf("unexpected loaded rooms: %+v", loadedRooms)
	}
	if loadedUsers["user-1"] != "alice" || loadedUserPubKeys["user-1"] != "pubkey" {
		t.Fatalf("unexpected loaded users/pubkeys: %+v %+v", loadedUsers, loadedUserPubKeys)
	}
	if loadedUserPubKeysUpdatedAt["user-1"] != 123 || loadedUserIDs["alice"] != "user-1" {
		t.Fatalf("unexpected loaded timestamps/user IDs: %+v %+v", loadedUserPubKeysUpdatedAt, loadedUserIDs)
	}
	if loadedRoomIDs["general"] != "room-1" || loadedRoomNameHashes[roomNameHashForMigration("general")] != "room-1" {
		t.Fatalf("unexpected loaded room identity maps: %+v %+v", loadedRoomIDs, loadedRoomNameHashes)
	}
	if loadedRoomNameCiphertexts["room-1"] != "cipher" || loadedUsernameCiphertexts["user-1"] != "cipher-user" {
		t.Fatalf("unexpected loaded ciphertext maps: %+v %+v", loadedRoomNameCiphertexts, loadedUsernameCiphertexts)
	}
	if loadedUserDirectoryUpdatedAt["user-1"] != 456 || loadedRoomDirectoryUpdatedAt["room-1"] != 789 {
		t.Fatalf("unexpected loaded directory timestamps: %+v %+v", loadedUserDirectoryUpdatedAt, loadedRoomDirectoryUpdatedAt)
	}
}

func TestFileStoreLoadMigratesLegacyRooms(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.json")
	store := NewFileStore(path)

	legacyState := PersistedState{
		Messages: Messages{
			"#general": {{ID: "legacy-msg", Timestamp: 1, Username: "system", Content: "legacy"}},
			"#cats":    {{ID: "cats-msg", Timestamp: 2, Username: "system", Content: "cats"}},
		},
		Rooms: []string{"#general", "#cats"},
		RoomIDs: map[string]string{
			"#general": "room-general",
			"#cats":    "room-cats",
		},
		RoomNameHashes: map[string]string{
			"old-hash": "room-general",
		},
	}

	raw, err := json.MarshalIndent(legacyState, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal legacy state: %v", err)
	}
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatalf("failed to write legacy state: %v", err)
	}

	messages, rooms, _, _, _, _, roomIDs, roomNameHashes, _, _, _, _, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if len(rooms) != 1 || rooms[0] != "general" {
		t.Fatalf("expected legacy rooms to migrate to general only, got %+v", rooms)
	}
	if _, ok := messages["#general"]; ok {
		t.Fatal("expected #general messages to be migrated off legacy key")
	}
	if got := messages["general"]; len(got) != 1 || got[0].Content != "legacy" {
		t.Fatalf("expected migrated general messages, got %+v", got)
	}
	if roomIDs["general"] != "room-general" {
		t.Fatalf("expected general room ID to migrate, got %+v", roomIDs)
	}
	if roomNameHashes[roomNameHashForMigration("general")] != "room-general" {
		t.Fatalf("expected migrated room name hash, got %+v", roomNameHashes)
	}
	if _, ok := messages["#cats"]; ok {
		t.Fatal("expected #cats to be removed")
	}
}
