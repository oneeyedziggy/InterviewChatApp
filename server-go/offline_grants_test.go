package main

import (
	"path/filepath"
	"testing"
)

func TestSQLiteStoreOfflineAccessGrantLifecycle(t *testing.T) {
	store, err := NewSQLiteStore(filepath.Join(t.TempDir(), "chat-state.sqlite3"))
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if err := store.QueueAccessGrantRequest("requester", "author", "room-1", 42, 100); err != nil {
		t.Fatalf("QueueAccessGrantRequest: %v", err)
	}
	if err := store.QueueAccessGrantRequest("requester", "author", "room-1", 42, 101); err != nil {
		t.Fatalf("duplicate QueueAccessGrantRequest: %v", err)
	}

	pending, err := store.PendingAccessGrantRequestsForUser("author")
	if err != nil {
		t.Fatalf("PendingAccessGrantRequestsForUser: %v", err)
	}
	if len(pending) != 1 || pending[0].OriginalRoomID != "room-1" {
		t.Fatalf("expected one opaque pending request, got %+v", pending)
	}
	if err := store.CompleteAccessGrantRequest(pending[0].RequestID); err != nil {
		t.Fatalf("CompleteAccessGrantRequest: %v", err)
	}
	pending, err = store.PendingAccessGrantRequestsForUser("author")
	if err != nil {
		t.Fatalf("pending after complete: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("expected completed request to disappear, got %+v", pending)
	}
}
