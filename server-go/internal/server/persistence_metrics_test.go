package server

import (
	"path/filepath"
	"testing"
)

func TestSQLitePersistenceStatsRecordSavePhases(t *testing.T) {
	store, err := NewSQLiteStore(filepath.Join(t.TempDir(), "chat-state.sqlite3"))
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	messages := Messages{"general": {{
		ID:        "message-1",
		Timestamp: 1,
		UserID:    "user-1",
		RoomID:    "room-general",
	}}}
	if err := store.SaveWithIdentity(messages, []string{"general"}, map[string]string{"user-1": "user-1"}, nil, nil, nil, map[string]string{"general": "room-general"}, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("SaveWithIdentity failed: %v", err)
	}

	stats := store.PersistenceStats()
	if stats.SaveCalls != 1 || stats.SaveFailures != 0 || stats.SavesInFlight != 0 {
		t.Fatalf("unexpected save counters: %+v", stats)
	}
	if stats.MessagesExamined != 1 || stats.SaveDurationTotalNS <= 0 || stats.TransactionTotalNS <= 0 {
		t.Fatalf("missing save phase metrics: %+v", stats)
	}
	if stats.DatabaseBytes <= 0 {
		t.Fatalf("expected database size metric: %+v", stats)
	}
}

func TestStateSnapshotMetricsRecordClonedMessages(t *testing.T) {
	chatServer := &ChatServer{
		messages:    Messages{"general": {{ID: "message-1"}, {ID: "message-2"}}},
		rooms:       []string{"general"},
		users:       map[string]string{"user-1": "socket-1"},
		userPubKeys: map[string]string{"user-1": "public-key"},
	}

	chatServer.snapshotStateForSaveLocked()
	stats := chatServer.persistenceMetrics.snapshot()
	if stats.SnapshotCalls != 1 || stats.SnapshotMessagesCloned != 2 {
		t.Fatalf("unexpected snapshot metrics: %+v", stats)
	}
}
