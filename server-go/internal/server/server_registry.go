package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wsrt "chat-server-go/websocket"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
	"github.com/google/uuid"
)

// DefaultServerID names the backward-compatible tenant backed by the
// pre-existing root chat-state.sqlite3 file (no server query param supplied).
const DefaultServerID = "default"

// registryEntry is the only server-side record of a tenant's existence.
// It intentionally holds nothing but a random ID and a storage path — the
// server stays blind to any user-facing label, membership, or content.
type registryEntry struct {
	ID     string `json:"id"`
	DBPath string `json:"dbPath"`
	Alias  string `json:"alias"`
}

type serverRegistryFile struct {
	Servers []registryEntry `json:"servers"`
}

// Tenant bundles one independent server's chat state and websocket transport.
type Tenant struct {
	ID          string
	Alias       string
	ChatServer  *ChatServer
	WS          *wsrt.Server
	initialized bool
}

// ServerManager lazily creates and caches per-server (per-tenant) instances,
// each backed by its own SQLite file, so tenants share no in-memory state.
type ServerManager struct {
	mu           sync.Mutex
	dataDir      string
	registryPath string
	tenants      map[string]*Tenant
	entries      map[string]registryEntry
	capabilities map[string]creationCapability
	httpMetrics  httpCounters
}

const serverCreationCapabilityTTL = 10 * time.Minute

type creationCapability struct {
	PublicKey       string
	PrivateKey      string
	TenantPublicKey string
	ExpiresAt       time.Time
}

func (sm *ServerManager) registerFirstUser(tenant *Tenant, userID, usernameHash, usernameCiphertext, publicKey string) (string, error) {
	if tenant == nil || tenant.ChatServer == nil || userID == "" || usernameHash == "" || usernameCiphertext == "" || publicKey == "" {
		return "", fmt.Errorf("invalid first-user registration")
	}
	cs := tenant.ChatServer
	now := time.Now().UTC().UnixMilli()
	cs.mu.Lock()
	cs.userPubKeys[userID] = publicKey
	cs.userPubKeysUpdatedAt[userID] = now
	if cs.userJoinedAt == nil {
		cs.userJoinedAt = make(map[string]int64)
	}
	cs.userJoinedAt[userID] = now / 1000
	cs.usernameHashes[usernameHash] = userID
	cs.usernameCiphertexts[userID] = usernameCiphertext
	cs.userDirectoryUpdatedAt[userID] = now
	messages, rooms, users, keys := cs.snapshotStateForSaveLocked()
	cs.mu.Unlock()
	if err := cs.saveState(messages, rooms, users, keys); err != nil {
		return "", fmt.Errorf("persist first user: %w", err)
	}
	sessionID := generateSalt()
	cs.sessionCache.Set(sessionID, userID)
	cs.setUser(userID, sessionID)
	log.Printf("[registerFirstUser] ✓ First user registered: %s (sessionId=%s, tenant=%s)", userID, sessionIDPreview(sessionID), tenant.ID)
	return sessionID, nil
}

func NewServerManager(dataDir string) (*ServerManager, error) {
	serversDir := filepath.Join(dataDir, "servers")
	if err := os.MkdirAll(serversDir, 0o755); err != nil {
		return nil, fmt.Errorf("create servers dir: %w", err)
	}

	sm := &ServerManager{
		dataDir:      dataDir,
		registryPath: filepath.Join(dataDir, "servers_index.json"),
		tenants:      make(map[string]*Tenant),
		entries:      make(map[string]registryEntry),
		capabilities: make(map[string]creationCapability),
	}

	if err := sm.loadRegistry(); err != nil {
		return nil, err
	}

	// Keep the legacy default filename while honoring an explicit data root.
	if _, ok := sm.entries[DefaultServerID]; !ok {
		sm.entries[DefaultServerID] = registryEntry{
			ID:     DefaultServerID,
			DBPath: DefaultStorePath(dataDir),
			Alias:  DefaultServerID,
		}
		if err := sm.saveRegistryLocked(); err != nil {
			return nil, err
		}
	}

	return sm, nil
}

func hashCreationCapability(value string) string {
	digest := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func (sm *ServerManager) issueCreationCapability(publicKey string) (string, int64, string) {
	privateKey, _, tenantPublicKey, err := generateTenantKeyPair()
	if err != nil {
		return "", 0, ""
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	for id, capability := range sm.capabilities {
		if capability.ExpiresAt.Before(time.Now()) {
			delete(sm.capabilities, id)
		}
	}
	capability, _ := generateInviteCode()
	expiresAt := time.Now().Add(serverCreationCapabilityTTL)
	sm.capabilities[hashCreationCapability(capability)] = creationCapability{
		PublicKey:       publicKey,
		PrivateKey:      privateKey,
		TenantPublicKey: tenantPublicKey,
		ExpiresAt:       expiresAt,
	}
	return capability, expiresAt.Unix(), tenantPublicKey
}

func (sm *ServerManager) consumeCreationCapability(capability, publicKey string) (creationCapability, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	key := hashCreationCapability(capability)
	entry, ok := sm.capabilities[key]
	if !ok || entry.ExpiresAt.Before(time.Now()) || entry.PublicKey != publicKey {
		return creationCapability{}, false
	}
	delete(sm.capabilities, key)
	return entry, true
}

func (sm *ServerManager) createTenantWithCapability(capability creationCapability) (*Tenant, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	id := uuid.NewString()
	dbPath := filepath.Join(sm.dataDir, "servers", id+".sqlite3")
	keyPrefix := id + ".server-gpg"
	privatePath := filepath.Join(sm.dataDir, "servers", keyPrefix+"-private-key.asc")
	publicPath := filepath.Join(sm.dataDir, "servers", keyPrefix+"-key.asc")
	if err := os.WriteFile(privatePath, []byte(capability.PrivateKey), 0o600); err != nil {
		return nil, fmt.Errorf("write tenant private key: %w", err)
	}
	if err := os.WriteFile(publicPath, []byte(capability.TenantPublicKey), 0o644); err != nil {
		_ = os.Remove(privatePath)
		return nil, fmt.Errorf("write tenant public key: %w", err)
	}
	privateKey, err := crypto.NewKeyFromArmored(capability.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse tenant private key: %w", err)
	}
	unlocked, err := privateKey.Unlock([]byte(""))
	if err != nil {
		return nil, fmt.Errorf("unlock tenant private key: %w", err)
	}
	ring, err := crypto.NewKeyRing(unlocked)
	if err != nil {
		return nil, fmt.Errorf("create tenant key ring: %w", err)
	}
	entry := registryEntry{ID: id, DBPath: dbPath}
	alias, err := sm.aliasForIDLocked(id)
	if err != nil {
		return nil, err
	}
	entry.Alias = alias
	sm.entries[id] = entry
	if err := sm.saveRegistryLocked(); err != nil {
		delete(sm.entries, id)
		return nil, err
	}
	tenant := sm.buildTenantWithKeysLocked(entry, ring, capability.TenantPublicKey)
	sm.tenants[id] = tenant
	return tenant, nil
}

func generateTenantKeyPair() (string, *crypto.KeyRing, string, error) {
	privateArmored, err := helper.GenerateKey("Chat Server", "server@chat.local", []byte(""), "rsa", 2048)
	if err != nil {
		return "", nil, "", err
	}
	privateKey, err := crypto.NewKeyFromArmored(privateArmored)
	if err != nil {
		return "", nil, "", err
	}
	unlocked, err := privateKey.Unlock([]byte(""))
	if err != nil {
		return "", nil, "", err
	}
	ring, err := crypto.NewKeyRing(unlocked)
	if err != nil {
		return "", nil, "", err
	}
	publicBytes, err := unlocked.GetPublicKey()
	if err != nil {
		return "", nil, "", err
	}
	publicKey, err := crypto.NewKey(publicBytes)
	if err != nil {
		return "", nil, "", err
	}
	publicArmored, err := publicKey.Armor()
	if err != nil {
		return "", nil, "", err
	}
	return privateArmored, ring, publicArmored, nil
}

func (sm *ServerManager) loadRegistry() error {
	data, err := os.ReadFile(sm.registryPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read server registry: %w", err)
	}
	var file serverRegistryFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("parse server registry: %w", err)
	}
	for _, e := range file.Servers {
		sm.entries[e.ID] = e
	}
	return nil
}

// saveRegistryLocked persists the registry; caller must hold sm.mu.
func (sm *ServerManager) saveRegistryLocked() error {
	file := serverRegistryFile{Servers: make([]registryEntry, 0, len(sm.entries))}
	for _, e := range sm.entries {
		file.Servers = append(file.Servers, e)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal server registry: %w", err)
	}
	tmpPath := sm.registryPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return fmt.Errorf("write server registry: %w", err)
	}
	return os.Rename(tmpPath, sm.registryPath)
}

// buildTenantLocked constructs a *Tenant for a known registry entry; caller must hold sm.mu.
func (sm *ServerManager) buildTenantLocked(entry registryEntry) (*Tenant, error) {
	chatServer := NewChatServer(entry.DBPath)
	chatServer.alias = entry.Alias
	ws := wsrt.NewServer(nil)
	chatServer.SetupSocketHandlers(ws)

	tenant := &Tenant{ID: entry.ID, Alias: entry.Alias, ChatServer: chatServer, WS: ws, initialized: true}
	sm.tenants[entry.ID] = tenant
	log.Printf("[ServerManager] tenant %q ready (store=%s)", entry.ID, entry.DBPath)
	return tenant, nil
}

func (sm *ServerManager) buildTenantWithKeysLocked(entry registryEntry, keyRing *crypto.KeyRing, publicKey string) *Tenant {
	chatServer := newChatServer(entry.DBPath, keyRing, publicKey)
	chatServer.alias = entry.Alias
	ws := wsrt.NewServer(nil)
	chatServer.SetupSocketHandlers(ws)
	return &Tenant{ID: entry.ID, Alias: entry.Alias, ChatServer: chatServer, WS: ws, initialized: true}
}

func (sm *ServerManager) generateAliasLocked() (string, error) {
	return "", fmt.Errorf("server id is required to generate an alias")
}

var serverAliasWords = []string{
	"amber", "anchor", "apple", "apron", "arrow", "atlas", "badge", "barrel",
	"basket", "beacon", "berry", "birch", "blade", "bloom", "brass", "bridge",
	"cable", "cactus", "candle", "canyon", "carpet", "cedar", "chalk", "charm",
	"cherry", "cinder", "circle", "clover", "cobalt", "comet", "copper", "coral",
	"crane", "crater", "cream", "cricket", "crown", "crystal", "daisy", "delta",
	"dove", "dragon", "drift", "eagle", "earth", "echo", "ember", "falcon",
	"feather", "fern", "flame", "flint", "flower", "forest", "forge", "fossil",
	"galaxy", "garden", "glacier", "grape", "granite", "harbor", "hazel", "heather",
	"heron", "honey", "horizon", "indigo", "island", "ivory", "jasmine", "juniper",
	"kettle", "kingdom", "lilac", "linen", "lotus", "maple", "marble", "meadow",
	"meteor", "mint", "monarch", "moss", "nectar", "night", "olive", "orchid",
	"otter", "panda", "pearl", "pepper", "pine", "planet", "plum", "poppy",
	"quartz", "rain", "raven", "reed", "river", "rocket", "rose", "sable",
	"saffron", "sail", "scarlet", "shadow", "shell", "silver", "spruce", "star",
	"stone", "storm", "summit", "sunset", "thistle", "thunder", "tiger", "topaz",
	"tower", "trail", " tulip", "umber", "valley", "velvet", "violet", " willow",
}

func deterministicServerAlias(id string) string {
	digest := sha256.Sum256([]byte(id))
	words := make([]string, 4)
	for index := range words {
		words[index] = strings.TrimSpace(serverAliasWords[digest[index]%byte(len(serverAliasWords))])
	}
	return strings.Join(words, "-")
}

func (sm *ServerManager) aliasForIDLocked(id string) (string, error) {
	alias := deterministicServerAlias(id)
	for existingID, entry := range sm.entries {
		if existingID != id && entry.Alias == alias {
			return "", fmt.Errorf("server alias collision for %q", id)
		}
	}
	return alias, nil
}

// GetTenant resolves an already-known serverID (empty string means the
// default/legacy tenant). Returns an error for unknown IDs — tenants must be
// created explicitly via CreateTenant.
func (sm *ServerManager) GetTenant(serverID string) (*Tenant, error) {
	if serverID == "" {
		serverID = DefaultServerID
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	entry, ok := sm.entries[serverID]
	if !ok {
		for id, candidate := range sm.entries {
			if candidate.Alias == serverID {
				serverID = id
				entry = candidate
				ok = true
				break
			}
		}
	}
	if !ok {
		return nil, fmt.Errorf("unknown server id %q", serverID)
	}

	if tenant, ok := sm.tenants[serverID]; ok {
		return tenant, nil
	}
	return sm.buildTenantLocked(entry)
}

// CreateTenant provisions a brand-new, independent server with its own
// SQLite-backed store and returns it along with its randomly-assigned ID.
func (sm *ServerManager) CreateTenant() (*Tenant, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	id := uuid.NewString()
	dbPath := filepath.Join(sm.dataDir, "servers", id+".sqlite3")
	alias, err := sm.aliasForIDLocked(id)
	if err != nil {
		return nil, err
	}
	entry := registryEntry{ID: id, DBPath: dbPath, Alias: alias}
	sm.entries[id] = entry
	if err := sm.saveRegistryLocked(); err != nil {
		delete(sm.entries, id)
		return nil, err
	}

	tenant, err := sm.buildTenantLocked(entry)
	if err != nil {
		delete(sm.entries, id)
		_ = sm.saveRegistryLocked()
		return nil, err
	}
	return tenant, nil
}

// RegisterDefaultTenant wires in an already-constructed ChatServer/WS pair as
// the default tenant, avoiding a duplicate SQLite connection to the same file.
func (sm *ServerManager) RegisterDefaultTenant(chatServer *ChatServer, ws *wsrt.Server) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.tenants[DefaultServerID] = &Tenant{ID: DefaultServerID, ChatServer: chatServer, WS: ws, initialized: true}
}

func (sm *ServerManager) Close() error {
	sm.mu.Lock()
	tenants := make([]*Tenant, 0, len(sm.tenants))
	for _, tenant := range sm.tenants {
		tenants = append(tenants, tenant)
	}
	sm.mu.Unlock()

	var closeErrors []error
	closedTransports := make(map[*wsrt.Server]struct{})
	closedStores := make(map[StateStore]struct{})
	for _, tenant := range tenants {
		if tenant == nil {
			continue
		}
		if tenant.WS != nil {
			if _, closed := closedTransports[tenant.WS]; !closed {
				closedTransports[tenant.WS] = struct{}{}
				if err := tenant.WS.Close(); err != nil {
					closeErrors = append(closeErrors, fmt.Errorf("close tenant websocket transport: %w", err))
				}
			}
		}
		if tenant.ChatServer == nil || tenant.ChatServer.store == nil {
			continue
		}
		if _, closed := closedStores[tenant.ChatServer.store]; closed {
			continue
		}
		closedStores[tenant.ChatServer.store] = struct{}{}
		if closer, ok := tenant.ChatServer.store.(interface{ Close() error }); ok {
			if err := closer.Close(); err != nil {
				closeErrors = append(closeErrors, fmt.Errorf("close tenant store: %w", err))
			}
		}
	}
	return errors.Join(closeErrors...)
}

func (sm *ServerManager) DiagnosticsSnapshot() ManagerDiagnostics {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	snapshot := ManagerDiagnostics{
		RegisteredTenants: len(sm.entries),
		HTTP:              sm.httpMetrics.snapshot(),
	}
	for _, tenant := range sm.tenants {
		if tenant == nil || !tenant.initialized || tenant.WS == nil {
			continue
		}
		snapshot.LoadedTenants++
		snapshot.Persistence.add(tenant.ChatServer.persistenceMetrics.snapshot())
		if provider, ok := tenant.ChatServer.store.(interface{ PersistenceStats() PersistenceStats }); ok {
			snapshot.Persistence.add(provider.PersistenceStats())
		}
		stats := tenant.WS.Stats()
		snapshot.WebSocket.UpgradeAttempts += stats.UpgradeAttempts
		snapshot.WebSocket.UpgradeFailures += stats.UpgradeFailures
		snapshot.WebSocket.ActiveConnections += stats.ActiveConnections
		snapshot.WebSocket.PeakConnections += stats.PeakConnections
		snapshot.WebSocket.FramesReceived += stats.FramesReceived
		snapshot.WebSocket.FramesSent += stats.FramesSent
		snapshot.WebSocket.BytesReceived += stats.BytesReceived
		snapshot.WebSocket.BytesSent += stats.BytesSent
		snapshot.WebSocket.WriteFailures += stats.WriteFailures
	}
	snapshot.Ready = snapshot.LoadedTenants > 0
	return snapshot
}

// resolveServerIDFromRequest extracts the `server` query param used to select
// a tenant on both HTTP and WebSocket requests.
func resolveServerIDFromRequest(query map[string][]string) string {
	if values, ok := query["server"]; ok && len(values) > 0 {
		return values[0]
	}
	return ""
}

// ResolveServerDataDir returns the directory used for tenant registry and stores.
func ResolveServerDataDir() string {
	if override := os.Getenv("SERVER_DATA_DIR"); override != "" {
		return override
	}
	return filepath.Dir(resolveSQLiteStorePath())
}

func DefaultStorePath(dataDir string) string {
	return filepath.Join(dataDir, filepath.Base(resolveSQLiteStorePath()))
}
