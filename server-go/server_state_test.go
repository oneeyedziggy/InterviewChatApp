package main

import (
	"path/filepath"
	"testing"
)

func TestGetIdentityMapsForSaveAndSaveState(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "chat-state.json")
	server := &ChatServer{
		store: NewFileStore(storePath),
		roomIDs: map[string]string{
			"general": "room-general",
			"alpha":   "room-alpha",
		},
		userPubKeysUpdatedAt: map[string]int64{
			"user-1": 123,
		},
		userDirectoryUpdatedAt: map[string]int64{
			"user-1": 456,
		},
		roomDirectoryUpdatedAt: map[string]int64{
			"room-general": 789,
		},
		roomNameHashes: map[string]string{
			"hash": "room-general",
		},
		roomNameCiphertexts: map[string]string{
			"room-general": "cipher-room",
		},
		usernameCiphertexts: map[string]string{
			"user-1": "cipher-user",
		},
	}

	identityMaps := server.getIdentityMapsForSave()
	if identityMaps["general"] != "room-general" || identityMaps["alpha"] != "room-alpha" {
		t.Fatalf("unexpected identity maps: %+v", identityMaps)
	}

	messages := Messages{"general": {{ID: "m1", Timestamp: 1, UserID: "user-1", RoomID: "room-general", Content: "hello"}}}
	rooms := []string{"general", "alpha"}
	users := map[string]string{"user-1": "alice"}
	userPubKeys := map[string]string{"user-1": "pubkey"}

	if err := server.saveState(messages, rooms, users, userPubKeys); err != nil {
		t.Fatalf("saveState failed: %v", err)
	}

	loadedMessages, loadedRooms, loadedUsers, loadedUserPubKeys, loadedUserPubKeysUpdatedAt, loadedUserIDs, loadedRoomIDs, loadedRoomNameHashes, loadedRoomNameCiphertexts, loadedUsernameCiphertexts, loadedUserDirectoryUpdatedAt, loadedRoomDirectoryUpdatedAt, err := server.store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(loadedMessages["general"]) != 1 || loadedMessages["general"][0].Content != "hello" {
		t.Fatalf("unexpected loaded messages: %+v", loadedMessages)
	}
	if len(loadedRooms) != 2 || loadedRooms[0] != "general" || loadedRooms[1] != "alpha" {
		t.Fatalf("unexpected loaded rooms: %+v", loadedRooms)
	}
	if loadedUsers["user-1"] != "alice" || loadedUserPubKeys["user-1"] != "pubkey" {
		t.Fatalf("unexpected loaded users: %+v %+v", loadedUsers, loadedUserPubKeys)
	}
	if loadedUserPubKeysUpdatedAt["user-1"] != 123 || loadedUserIDs["user-1"] != "" {
		t.Fatalf("unexpected loaded pubkey timestamps or user IDs: %+v %+v", loadedUserPubKeysUpdatedAt, loadedUserIDs)
	}
	if loadedRoomIDs["general"] != "room-general" || loadedRoomNameHashes[roomNameHashForMigration("general")] != "room-general" {
		t.Fatalf("unexpected loaded room identity maps: %+v %+v", loadedRoomIDs, loadedRoomNameHashes)
	}
	if loadedRoomNameCiphertexts["room-general"] != "cipher-room" || loadedUsernameCiphertexts["user-1"] != "cipher-user" {
		t.Fatalf("unexpected loaded ciphertext maps: %+v %+v", loadedRoomNameCiphertexts, loadedUsernameCiphertexts)
	}
	if loadedUserDirectoryUpdatedAt["user-1"] != 456 || loadedRoomDirectoryUpdatedAt["room-general"] != 789 {
		t.Fatalf("unexpected loaded directory timestamps: %+v %+v", loadedUserDirectoryUpdatedAt, loadedRoomDirectoryUpdatedAt)
	}
}
