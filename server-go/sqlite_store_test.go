package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestSQLiteStoreSaveAndLoadRoundTrip(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	messages := Messages{
		"general": {
			{
				ID:               "msg-1",
				Timestamp:        1,
				UserID:           "user-1",
				RoomID:           "room-1",
				EncryptedMessage: "cipher-1",
				Edited:           true,
			},
		},
	}
	rooms := []string{"general"}
	users := map[string]string{"user-1": "alice"}
	userPubKeys := map[string]string{"user-1": "pubkey"}
	userPubKeysUpdatedAt := map[string]int64{"user-1": 123}
	userIDs := map[string]string{"alice": "user-1"}
	roomIDs := map[string]string{"general": "room-1"}
	roomNameHashes := map[string]string{"hash": "room-1"}
	roomNameCiphertexts := map[string]string{"room-1": "cipher-room"}
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

	if got := loadedMessages["general"]; len(got) != 1 || got[0].EncryptedMessage != "cipher-1" {
		t.Fatalf("unexpected loaded messages: %+v", loadedMessages)
	}
	if len(loadedRooms) != 1 || loadedRooms[0] != "general" {
		t.Fatalf("unexpected loaded rooms: %+v", loadedRooms)
	}
	if loadedUsers["user-1"] != "alice" {
		t.Fatalf("unexpected loaded users: %+v", loadedUsers)
	}
	if loadedUserPubKeys["user-1"] != "pubkey" {
		t.Fatalf("unexpected loaded pubkeys: %+v", loadedUserPubKeys)
	}
	if loadedUserPubKeysUpdatedAt["user-1"] != 123 || loadedUserIDs["alice"] != "user-1" {
		t.Fatalf("unexpected loaded identity maps: %+v %+v", loadedUserPubKeysUpdatedAt, loadedUserIDs)
	}
	if loadedRoomIDs["general"] != "room-1" || loadedRoomNameHashes[roomNameHashForMigration("general")] != "room-1" {
		t.Fatalf("unexpected loaded room identity maps: %+v %+v", loadedRoomIDs, loadedRoomNameHashes)
	}
	if loadedRoomNameCiphertexts["room-1"] != "cipher-room" || loadedUsernameCiphertexts["user-1"] != "cipher-user" {
		t.Fatalf("unexpected loaded ciphertext maps: %+v %+v", loadedRoomNameCiphertexts, loadedUsernameCiphertexts)
	}
	if loadedUserDirectoryUpdatedAt["user-1"] != 456 || loadedRoomDirectoryUpdatedAt["room-1"] != 789 {
		t.Fatalf("unexpected loaded directory timestamps: %+v %+v", loadedUserDirectoryUpdatedAt, loadedRoomDirectoryUpdatedAt)
	}
}

func TestSQLiteStoreHistoryTriggerHybridScope(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	baseMessages := Messages{
		"general": {
			{
				ID:               "msg-1",
				Timestamp:        100,
				UserID:           "user-1",
				RoomID:           "room-1",
				EncryptedMessage: "cipher-v1",
			},
		},
	}
	rooms := []string{"general"}
	roomIDs := map[string]string{"general": "room-1"}

	if err := store.SaveWithIdentity(baseMessages, rooms, nil, nil, nil, nil, roomIDs, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("initial SaveWithIdentity failed: %v", err)
	}

	voteOnly := Messages{
		"general": {
			{
				ID:               "msg-1",
				Timestamp:        100,
				UserID:           "user-1",
				RoomID:           "room-1",
				EncryptedMessage: "cipher-v1",
				VoteTotal:        intPtr(3),
			},
		},
	}
	if err := store.SaveWithIdentity(voteOnly, rooms, nil, nil, nil, nil, roomIDs, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("vote-only SaveWithIdentity failed: %v", err)
	}

	historyAfterVoteOnly := countMessageHistoryRows(t, store, "msg-1")
	if historyAfterVoteOnly != 0 {
		t.Fatalf("expected no history rows for vote-only update, got %d", historyAfterVoteOnly)
	}

	edited := Messages{
		"general": {
			{
				ID:               "msg-1",
				Timestamp:        100,
				UserID:           "user-1",
				RoomID:           "room-1",
				EncryptedMessage: "cipher-v2",
				Edited:           true,
			},
		},
	}
	if err := store.SaveWithIdentity(edited, rooms, nil, nil, nil, nil, roomIDs, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("edited SaveWithIdentity failed: %v", err)
	}

	historyAfterEdit := countMessageHistoryRows(t, store, "msg-1")
	if historyAfterEdit != 1 {
		t.Fatalf("expected exactly one history row after edit update, got %d", historyAfterEdit)
	}

	historyCreatedAt, historyUpdatedAt := latestHistoryTimestamps(t, store, "msg-1")
	if historyCreatedAt != 100 {
		t.Fatalf("expected history created_at to preserve original timestamp 100, got %d", historyCreatedAt)
	}
	if historyUpdatedAt <= 0 {
		t.Fatalf("expected history updated_at to be set, got %d", historyUpdatedAt)
	}
}

func TestSQLiteStoreTextPrimaryKeysAreNotNull(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	for table, column := range map[string]string{
		"users":    "user_id",
		"rooms":    "room_id",
		"messages": "message_id",
	} {
		isNotNull, err := store.columnIsNotNull(table, column)
		if err != nil {
			t.Fatalf("columnIsNotNull(%s, %s) failed: %v", table, column, err)
		}
		if !isNotNull {
			t.Fatalf("expected %s.%s to be explicitly NOT NULL", table, column)
		}
	}
}

func TestSQLiteStoreMigratesTextPrimaryKeysToNotNull(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy sqlite db failed: %v", err)
	}
	if _, err := db.Exec(legacyNullablePrimaryKeySchema); err != nil {
		_ = db.Close()
		t.Fatalf("create legacy schema failed: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO users (user_id, username, updated_at) VALUES ('user-1', 'alice', 1);
		INSERT INTO rooms (room_id, room_key, updated_at) VALUES ('room-1', 'general', 1);
		INSERT INTO messages (message_id, room_id, user_id, created_at, edited, deleted, updated_at) VALUES ('msg-1', 'room-1', 'user-1', 1, 0, 0, 1);
		INSERT INTO message_history (message_id, room_id, user_id, created_at, edited, deleted, updated_at) VALUES ('msg-1', 'room-1', 'user-1', 1, 0, 0, 1);
	`); err != nil {
		_ = db.Close()
		t.Fatalf("seed legacy schema failed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy db failed: %v", err)
	}

	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	for table, column := range map[string]string{
		"users":    "user_id",
		"rooms":    "room_id",
		"messages": "message_id",
	} {
		isNotNull, err := store.columnIsNotNull(table, column)
		if err != nil {
			t.Fatalf("columnIsNotNull(%s, %s) failed: %v", table, column, err)
		}
		if !isNotNull {
			t.Fatalf("expected migrated %s.%s to be explicitly NOT NULL", table, column)
		}
	}

	if count := countMessageHistoryRows(t, store, "msg-1"); count != 1 {
		t.Fatalf("expected migrated message history row to be preserved, got %d", count)
	}
}

const legacyNullablePrimaryKeySchema = `
CREATE TABLE users (
	user_id TEXT PRIMARY KEY,
	username TEXT NOT NULL DEFAULT '',
	public_key TEXT,
	public_key_updated_at INTEGER NOT NULL DEFAULT 0,
	username_ciphertext TEXT,
	directory_updated_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE rooms (
	room_id TEXT PRIMARY KEY,
	room_key TEXT NOT NULL UNIQUE,
	room_name_hash TEXT,
	room_name_ciphertext TEXT,
	directory_updated_at INTEGER NOT NULL DEFAULT 0,
	room_order INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
	message_id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT,
	key_transfer_encrypted_package TEXT,
	key_transfer_from_user_id TEXT,
	encrypted_message TEXT,
	encrypted_for_json TEXT,
	versions_json TEXT,
	current_version INTEGER,
	visible_to_json TEXT,
	reply_to INTEGER,
	vote_total INTEGER,
	user_votes_json TEXT,
	edited INTEGER NOT NULL DEFAULT 0,
	deleted INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
	FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE message_history (
	history_id INTEGER PRIMARY KEY AUTOINCREMENT,
	message_id TEXT NOT NULL,
	room_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT,
	key_transfer_encrypted_package TEXT,
	key_transfer_from_user_id TEXT,
	encrypted_message TEXT,
	encrypted_for_json TEXT,
	versions_json TEXT,
	current_version INTEGER,
	visible_to_json TEXT,
	reply_to INTEGER,
	vote_total INTEGER,
	user_votes_json TEXT,
	edited INTEGER NOT NULL,
	deleted INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(message_id) REFERENCES messages(message_id) ON DELETE CASCADE
);
`

func countMessageHistoryRows(t *testing.T, store *SQLiteStore, messageID string) int {
	t.Helper()

	var count int
	if err := store.db.QueryRow(`SELECT COUNT(1) FROM message_history WHERE message_id = ?`, messageID).Scan(&count); err != nil {
		t.Fatalf("countMessageHistoryRows failed: %v", err)
	}
	return count
}

func latestHistoryTimestamps(t *testing.T, store *SQLiteStore, messageID string) (int64, int64) {
	t.Helper()

	var createdAt int64
	var updatedAt int64
	if err := store.db.QueryRow(`
		SELECT created_at, updated_at
		FROM message_history
		WHERE message_id = ?
		ORDER BY history_id DESC
		LIMIT 1
	`, messageID).Scan(&createdAt, &updatedAt); err != nil {
		t.Fatalf("latestHistoryTimestamps failed: %v", err)
	}

	return createdAt, updatedAt
}

func intPtr(v int) *int {
	return &v
}
