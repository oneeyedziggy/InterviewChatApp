package server

import (
	"path/filepath"
	"testing"

	wsrt "chat-server-go/websocket"
)

func TestServerManagerDefaultTenantUsesConfiguredDataDirectory(t *testing.T) {
	dataDir := t.TempDir()
	manager, err := NewServerManager(dataDir)
	if err != nil {
		t.Fatalf("NewServerManager failed: %v", err)
	}

	entry, exists := manager.entries[DefaultServerID]
	if !exists {
		t.Fatal("expected default tenant registry entry")
	}
	want := filepath.Join(dataDir, "chat-state.sqlite3")
	if entry.DBPath != want {
		t.Fatalf("default tenant store path = %q, want %q", entry.DBPath, want)
	}
	if DefaultStorePath(dataDir) != want {
		t.Fatalf("DefaultStorePath = %q, want %q", DefaultStorePath(dataDir), want)
	}
}

func TestServerManagerCloseClosesLoadedStore(t *testing.T) {
	store, err := NewSQLiteStore(filepath.Join(t.TempDir(), "chat-state.sqlite3"))
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	transport := wsrt.NewServer(nil)
	manager := &ServerManager{tenants: map[string]*Tenant{
		DefaultServerID: {
			ID:         DefaultServerID,
			ChatServer: &ChatServer{store: store},
			WS:         transport,
		},
	}}

	if err := manager.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if err := store.db.Ping(); err == nil {
		t.Fatal("expected SQLite connection to be closed")
	}
}
