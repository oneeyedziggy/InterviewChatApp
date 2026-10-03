package server

import (
	"testing"
	"time"
)

func TestTouchSlidesIdleExpiry(t *testing.T) {
	cache := NewSlidingCache(100*time.Millisecond, time.Hour)
	t.Cleanup(cache.Close)
	cache.Set("session", "user-1")

	time.Sleep(60 * time.Millisecond)
	userID, expiresAt, ok := cache.Touch("session")
	if !ok || userID != "user-1" {
		t.Fatalf("expected live session, got %q ok=%v", userID, ok)
	}
	if remaining := time.Until(expiresAt); remaining <= 60*time.Millisecond {
		t.Fatalf("expiry was not slid forward, remaining=%s", remaining)
	}

	// Past the original TTL, but still live because of the refresh above.
	time.Sleep(60 * time.Millisecond)
	if _, _, ok := cache.Touch("session"); !ok {
		t.Fatal("actively used session expired despite being refreshed")
	}
}

func TestTouchRejectsIdleExpiredSession(t *testing.T) {
	cache := NewSlidingCache(40*time.Millisecond, time.Hour)
	t.Cleanup(cache.Close)
	cache.Set("session", "user-1")

	time.Sleep(80 * time.Millisecond)
	if _, _, ok := cache.Touch("session"); ok {
		t.Fatal("idle session should have expired")
	}
}

func TestTouchHonorsAbsoluteLifetime(t *testing.T) {
	cache := NewSlidingCache(time.Hour, 80*time.Millisecond)
	t.Cleanup(cache.Close)
	cache.Set("session", "user-1")

	_, expiresAt, ok := cache.Touch("session")
	if !ok {
		t.Fatal("expected live session")
	}
	if remaining := time.Until(expiresAt); remaining > 80*time.Millisecond {
		t.Fatalf("expiry exceeded the absolute lifetime, remaining=%s", remaining)
	}

	time.Sleep(120 * time.Millisecond)
	if _, _, ok := cache.Touch("session"); ok {
		t.Fatal("session outlived its absolute maximum lifetime")
	}
}

func TestIsSessionAuthorizedRefreshesSession(t *testing.T) {
	cs := newIntegrationTestServer(t)
	cs.sessionCache = NewSlidingCache(120*time.Millisecond, time.Hour)
	t.Cleanup(cs.sessionCache.Close)
	cs.sessionCache.Set("session-1", "user-1")

	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !cs.isSessionAuthorizedForUser("session-1", "user-1") {
			t.Fatal("session expired while it was being used continuously")
		}
		time.Sleep(40 * time.Millisecond)
	}
}
