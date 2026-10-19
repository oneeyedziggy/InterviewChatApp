package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newInviteTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	store, err := NewSQLiteStore(filepath.Join(t.TempDir(), "chat-state.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestCreateInviteReturnsStoredIDAndHash(t *testing.T) {
	store := newInviteTestStore(t)
	code := "private-invite-code"
	codeHash := hashInviteCode(code)
	inviteID, err := store.CreateInvite(codeHash, "creator", 100, 200)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(inviteID); err != nil {
		t.Fatalf("expected generated UUID, got %q: %v", inviteID, err)
	}
	invites, err := store.ListInvites()
	if err != nil {
		t.Fatal(err)
	}
	if len(invites) != 1 || invites[0].InviteID != inviteID || invites[0].CreatedAt != 100 || invites[0].ExpiresAt != 200 || invites[0].Status != "active" || invites[0].UsedCount != 0 || invites[0].MaxUses == nil || *invites[0].MaxUses != 1 {
		t.Fatalf("unexpected invite listing: %+v", invites)
	}
	var storedHash string
	if err := store.db.QueryRow(`SELECT code_hash FROM invites WHERE invite_id = ?`, inviteID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != codeHash || storedHash == code {
		t.Fatal("database must retain the code hash, not the raw code")
	}
	if failedID, err := store.CreateInvite(codeHash, "creator", 100, 200); err == nil || failedID != "" {
		t.Fatalf("failed insert returned ID=%q err=%v", failedID, err)
	}
}

func TestCreateInviteResponseMatchesListWithoutExposingCode(t *testing.T) {
	store := newInviteTestStore(t)
	cache := NewSlidingCache(time.Hour, time.Hour)
	t.Cleanup(cache.Close)
	cache.Set("session", "creator")
	server := &ChatServer{store: store, sessionCache: cache}
	response := httptest.NewRecorder()
	before := time.Now().Unix()
	server.handleCreateInvite(response, httptest.NewRequest(http.MethodPost, "/api/invites", strings.NewReader(`{"userId":"creator","sessionId":"session"}`)))
	var created CreateInviteResponse
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || created.Error != "" || created.InviteID == "" || created.Code == "" {
		t.Fatalf("unexpected create response: %+v status=%d", created, response.Code)
	}
	if created.ExpiresAt < before+int64(InviteTTL/time.Second) || created.ExpiresAt > time.Now().Unix()+int64(InviteTTL/time.Second) {
		t.Fatalf("unexpected invite TTL: %d", created.ExpiresAt)
	}
	var legacyResponse struct {
		Code string `json:"code"`
		ExpiresAt int64 `json:"expiresAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &legacyResponse); err != nil || legacyResponse.Code != created.Code || legacyResponse.ExpiresAt != created.ExpiresAt {
		t.Fatalf("legacy response consumer failed: %v", err)
	}
	listResponse := httptest.NewRecorder()
	server.handleListInvites(listResponse, httptest.NewRequest(http.MethodGet, "/api/invites", nil))
	var summaries []map[string]json.RawMessage
	if err := json.Unmarshal(listResponse.Body.Bytes(), &summaries); err != nil {
		t.Fatal(err)
	}
	if listResponse.Code != http.StatusOK || len(summaries) != 1 || string(summaries[0]["inviteId"]) != fmt.Sprintf("%q", created.InviteID) {
		t.Fatalf("create ID does not match GET listing: %s", listResponse.Body.String())
	}
	for _, field := range []string{"code", "codeHash", "code_hash"} {
		if _, exists := summaries[0][field]; exists {
			t.Fatalf("GET listing exposes %s", field)
		}
	}
	if strings.Contains(listResponse.Body.String(), created.Code) {
		t.Fatal("GET listing exposes raw invite code")
	}
	var storedHash string
	if err := store.db.QueryRow(`SELECT code_hash FROM invites WHERE invite_id = ?`, created.InviteID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != hashInviteCode(created.Code) || storedHash == created.Code {
		t.Fatal("API create persisted raw code instead of its hash")
	}
}

func TestInviteConsumeRevokeExpiryAndLimitPreserved(t *testing.T) {
	store := newInviteTestStore(t)
	for _, scenario := range []string{"consume", "revoke", "expire"} {
		t.Run(scenario, func(t *testing.T) {
			codeHash := hashInviteCode(scenario)
			inviteID, err := store.CreateInvite(codeHash, scenario, 100, 200)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "revoke" {
				if err := store.RevokeInvite(inviteID); err != nil {
					t.Fatal(err)
				}
			}
			now := int64(150)
			if scenario == "expire" {
				now = 200
			}
			creator, ok, err := store.ConsumeInvite(codeHash, now)
			if err != nil || ok != (scenario == "consume") || (ok && creator != scenario) {
				t.Fatalf("unexpected consume result: creator=%q ok=%v err=%v", creator, ok, err)
			}
			if _, ok, err := store.ConsumeInvite(codeHash, now); err != nil || ok {
				t.Fatalf("used/revoked/expired invite accepted: ok=%v err=%v", ok, err)
			}
		})
	}
	for index := 0; index < 20; index++ {
		if _, err := store.CreateInvite(hashInviteCode(fmt.Sprintf("limit-%d", index)), "limited-creator", 100, 200); err != nil {
			t.Fatal(err)
		}
	}
	if inviteID, err := store.CreateInvite(hashInviteCode("over-limit"), "limited-creator", 100, 200); err == nil || inviteID != "" {
		t.Fatalf("limit failure returned ID=%q err=%v", inviteID, err)
	}
	if count, err := store.ActiveInvitesByUser("limited-creator"); err != nil || count != 20 {
		t.Fatalf("unexpected active invite count: %d err=%v", count, err)
	}
}