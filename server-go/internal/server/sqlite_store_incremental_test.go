package server

import (
	"path/filepath"
	"testing"
)

func TestSQLiteStoreSaveMessagePersistsCompleteEncryptedMessage(t *testing.T) {
	store, err := NewSQLiteStore(filepath.Join(t.TempDir(), "chat-state.sqlite3"))
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	currentVersion := 2
	replyTo := int64(41)
	voteTotal := 3
	message := Message{
		ID:                          "message-1",
		Timestamp:                   42,
		Username:                    "user-1",
		UserID:                      "user-1",
		RoomID:                      "room-1",
		EncryptedMessage:            "ciphertext",
		EncryptedFor:                map[string]string{"user-1": "wrapped-key"},
		Versions:                    []MessageVersion{{EncryptedMessage: "previous-ciphertext", Version: 1, Timestamp: 40}},
		CurrentVersion:              &currentVersion,
		VisibleTo:                   []string{"user-1"},
		ReplyTo:                     &replyTo,
		VoteTotal:                   &voteTotal,
		UserVotes:                   map[string]string{"user-1": "up"},
		Edited:                      true,
		KeyTransferEncryptedPackage: "transfer-package",
		KeyTransferFromUserID:       "user-1",
	}
	metadata := MessagePersistenceMetadata{
		RoomKey:                "general",
		RoomNameHash:           "room-hash",
		RoomNameCiphertext:     "room-ciphertext",
		RoomDirectoryUpdatedAt: 100,
		UserPublicKey:          "public-key",
		UserPublicKeyUpdatedAt: 101,
		UsernameCiphertext:     "username-ciphertext",
		UserDirectoryUpdatedAt: 102,
	}
	if err := store.SaveMessage(message, metadata); err != nil {
		t.Fatalf("SaveMessage failed: %v", err)
	}

	loadedMessages, loadedRooms, _, loadedKeys, _, _, loadedRoomIDs, _, loadedRoomCiphertexts, loadedUsernameCiphertexts, _, _, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(loadedRooms) != 1 || loadedRooms[0] != "general" || loadedRoomIDs["general"] != "room-1" {
		t.Fatalf("unexpected loaded room state: %+v %+v", loadedRooms, loadedRoomIDs)
	}
	loaded := loadedMessages["general"]
	if len(loaded) != 1 {
		t.Fatalf("expected one loaded message, got %+v", loaded)
	}
	if loaded[0].ID != message.ID || loaded[0].EncryptedMessage != message.EncryptedMessage || loaded[0].CurrentVersion == nil || *loaded[0].CurrentVersion != currentVersion || loaded[0].ReplyTo == nil || *loaded[0].ReplyTo != replyTo || loaded[0].VoteTotal == nil || *loaded[0].VoteTotal != voteTotal || !loaded[0].Edited {
		t.Fatalf("incremental message did not round-trip: %+v", loaded[0])
	}
	if loadedKeys["user-1"] != "public-key" || loadedRoomCiphertexts["room-1"] != "room-ciphertext" || loadedUsernameCiphertexts["user-1"] != "username-ciphertext" {
		t.Fatalf("incremental identity metadata did not round-trip")
	}
	stats := store.PersistenceStats()
	if stats.SaveCalls != 1 || stats.MessagesExamined != 1 || stats.SaveFailures != 0 {
		t.Fatalf("unexpected incremental metrics: %+v", stats)
	}
}
