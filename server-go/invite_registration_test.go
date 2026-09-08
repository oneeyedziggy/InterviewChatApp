package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteStoreRoomCreatedAtPersistsAcrossSaves(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	roomIDs := map[string]string{"general": "room-1"}
	if err := store.SaveWithIdentity(Messages{}, []string{"general"}, nil, nil, nil, nil, roomIDs, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("first SaveWithIdentity: %v", err)
	}

	createdAt, err := store.RoomCreatedAt()
	if err != nil {
		t.Fatalf("RoomCreatedAt: %v", err)
	}
	firstCreatedAt, ok := createdAt["room-1"]
	if !ok || firstCreatedAt <= 0 {
		t.Fatalf("expected a positive created_at for room-1, got %v (ok=%v)", firstCreatedAt, ok)
	}

	time.Sleep(1100 * time.Millisecond)

	// Re-saving the same room (e.g. after an unrelated mutation) must not
	// bump its created_at — only the first insert should set it.
	if err := store.SaveWithIdentity(Messages{}, []string{"general"}, nil, nil, nil, nil, roomIDs, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("second SaveWithIdentity: %v", err)
	}
	createdAtAfter, err := store.RoomCreatedAt()
	if err != nil {
		t.Fatalf("RoomCreatedAt after resave: %v", err)
	}
	if createdAtAfter["room-1"] != firstCreatedAt {
		t.Fatalf("expected created_at to remain %d, got %d", firstCreatedAt, createdAtAfter["room-1"])
	}
}

func TestSQLiteStoreSetInvitedByAndHasAnyUsers(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	hasUsers, err := store.HasAnyUsers()
	if err != nil {
		t.Fatalf("HasAnyUsers (empty): %v", err)
	}
	if hasUsers {
		t.Fatalf("expected HasAnyUsers=false on empty store")
	}

	users := map[string]string{"user-1": "alice"}
	if err := store.SaveWithIdentity(Messages{}, nil, users, nil, nil, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("SaveWithIdentity: %v", err)
	}

	hasUsers, err = store.HasAnyUsers()
	if err != nil {
		t.Fatalf("HasAnyUsers (populated): %v", err)
	}
	if !hasUsers {
		t.Fatalf("expected HasAnyUsers=true after saving a user")
	}

	if err := store.SetInvitedBy("user-1", "user-0"); err != nil {
		t.Fatalf("SetInvitedBy: %v", err)
	}
}

func TestSQLiteStoreInviteLifecycle(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "chat-state.sqlite3")
	store, err := NewSQLiteStore(path)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	now := time.Now().Unix()
	codeHash := hashInviteCode("test-code")
	if err := store.CreateInvite(codeHash, "user-1", now, now+3600); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Wrong code must fail without revealing anything.
	if _, ok, err := store.ConsumeInvite(hashInviteCode("wrong-code"), now); err != nil || ok {
		t.Fatalf("expected wrong code to fail, ok=%v err=%v", ok, err)
	}

	// Expired invite must fail even with the right hash.
	expiredHash := hashInviteCode("expired-code")
	if err := store.CreateInvite(expiredHash, "user-1", now-7200, now-3600); err != nil {
		t.Fatalf("CreateInvite (expired): %v", err)
	}
	if _, ok, err := store.ConsumeInvite(expiredHash, now); err != nil || ok {
		t.Fatalf("expected expired invite to fail, ok=%v err=%v", ok, err)
	}

	// Valid invite succeeds once...
	createdBy, ok, err := store.ConsumeInvite(codeHash, now)
	if err != nil {
		t.Fatalf("ConsumeInvite: %v", err)
	}
	if !ok || createdBy != "user-1" {
		t.Fatalf("expected valid single-use invite to succeed with creator user-1, got ok=%v createdBy=%q", ok, createdBy)
	}

	// ...and is rejected on reuse (single-use).
	if _, ok, err := store.ConsumeInvite(codeHash, now); err != nil || ok {
		t.Fatalf("expected reused invite to fail, ok=%v err=%v", ok, err)
	}
}
