package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestServerManagerCreatesIsolatedTenants(t *testing.T) {
	dir := t.TempDir()

	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	tenantA, err := sm.CreateTenant()
	if err != nil {
		t.Fatalf("CreateTenant A: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := tenantA.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})
	tenantB, err := sm.CreateTenant()
	if err != nil {
		t.Fatalf("CreateTenant B: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := tenantB.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})

	if tenantA.ID == tenantB.ID {
		t.Fatalf("expected distinct tenant IDs, got %q twice", tenantA.ID)
	}
	if tenantA.ChatServer == tenantB.ChatServer {
		t.Fatalf("expected distinct ChatServer instances per tenant")
	}
	if tenantA.WS == tenantB.WS {
		t.Fatalf("expected distinct websocket server instances per tenant")
	}

	// Mutating one tenant's in-memory state must never affect the other.
	tenantA.ChatServer.mu.Lock()
	tenantA.ChatServer.users["userA"] = "socketA"
	tenantA.ChatServer.mu.Unlock()

	tenantB.ChatServer.mu.RLock()
	_, leaked := tenantB.ChatServer.users["userA"]
	tenantB.ChatServer.mu.RUnlock()
	if leaked {
		t.Fatalf("tenant isolation violated: userA leaked into tenant B")
	}

	// Re-fetching by ID must return the same cached instance, not a new one.
	again, err := sm.GetTenant(tenantA.ID)
	if err != nil {
		t.Fatalf("GetTenant: %v", err)
	}
	if again.ChatServer != tenantA.ChatServer {
		t.Fatalf("expected GetTenant to return cached tenant instance")
	}

	// Registry survives reconstruction (new ServerManager instance re-reads it).
	sm2, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager reload: %v", err)
	}
	reloaded, err := sm2.GetTenant(tenantA.ID)
	if err != nil {
		t.Fatalf("GetTenant after reload: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := reloaded.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})
	if reloaded.ID != tenantA.ID {
		t.Fatalf("expected reloaded tenant id %q, got %q", tenantA.ID, reloaded.ID)
	}

	expectedPath := filepath.Join(dir, "servers", tenantA.ID+".sqlite3")
	if reloaded.ChatServer == nil {
		t.Fatalf("expected reloaded tenant to have a ChatServer")
	}
	_ = expectedPath
}

func TestServerManagerUnknownTenantErrors(t *testing.T) {
	dir := t.TempDir()
	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	if _, err := sm.GetTenant("does-not-exist"); err == nil {
		t.Fatalf("expected error for unknown tenant id")
	}
}

func TestServerManagerResolvesDeterministicAliases(t *testing.T) {
	dir := t.TempDir()
	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	first, err := sm.CreateTenant()
	if err != nil {
		t.Fatalf("CreateTenant: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := first.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})

	if first.Alias != deterministicServerAlias(first.ID) {
		t.Fatalf("expected deterministic alias %q, got %q", deterministicServerAlias(first.ID), first.Alias)
	}
	resolved, err := sm.GetTenant(first.Alias)
	if err != nil {
		t.Fatalf("GetTenant by alias: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := resolved.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})
	if resolved.ID != first.ID {
		t.Fatalf("expected alias to resolve to %q, got %q", first.ID, resolved.ID)
	}
	if resolved != first {
		t.Fatalf("expected alias lookup to return the cached tenant instance")
	}
}

func TestServerManagerUsesDifferentServerKeys(t *testing.T) {
	dir := t.TempDir()
	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	first, err := sm.CreateTenant()
	if err != nil {
		t.Fatalf("CreateTenant first: %v", err)
	}
	second, err := sm.CreateTenant()
	if err != nil {
		t.Fatalf("CreateTenant second: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := first.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
		if closer, ok := second.ChatServer.store.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	})

	if first.ChatServer.serverPublicKey == second.ChatServer.serverPublicKey {
		t.Fatalf("expected each tenant to have a distinct server public key")
	}
	if _, err := os.Stat(filepath.Join(dir, "servers", first.ID+".sqlite3")); err != nil {
		t.Fatalf("expected first tenant database: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "servers", first.ID+".server-gpg-private-key.asc")); err != nil {
		t.Fatalf("expected first tenant private key beside its database: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "servers", second.ID+".sqlite3")); err != nil {
		t.Fatalf("expected second tenant database: %v", err)
	}
}

func TestServerManagerDefaultTenantFallback(t *testing.T) {
	dir := t.TempDir()
	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	// Assert the default tenant's registry entry without opening the real
	// dev-time chat-state.sqlite3 file (unit tests must not touch it).
	sm.mu.Lock()
	entry, ok := sm.entries[DefaultServerID]
	sm.mu.Unlock()
	if !ok {
		t.Fatalf("expected default tenant entry to be registered")
	}
	if entry.DBPath != resolveSQLiteStorePath() {
		t.Fatalf("expected default tenant db path %q, got %q", resolveSQLiteStorePath(), entry.DBPath)
	}
}

func TestCreationCapabilityIsBoundAndSingleUse(t *testing.T) {
	dir := t.TempDir()
	sm, err := NewServerManager(dir)
	if err != nil {
		t.Fatalf("NewServerManager: %v", err)
	}

	capability, expiresAt, tenantPublicKey := sm.issueCreationCapability("public-key-a")
	if capability == "" || expiresAt <= 0 || tenantPublicKey == "" {
		t.Fatalf("expected capability and expiry")
	}
	if _, ok := sm.consumeCreationCapability(capability, "public-key-a"); !ok {
		t.Fatalf("expected matching capability to be consumed")
	}
	if _, ok := sm.consumeCreationCapability(capability, "public-key-a"); ok {
		t.Fatalf("expected capability to be single-use")
	}

	otherCapability, _, _ := sm.issueCreationCapability("public-key-a")
	if _, ok := sm.consumeCreationCapability(otherCapability, "public-key-b"); ok {
		t.Fatalf("expected capability to reject a different public key")
	}
}

