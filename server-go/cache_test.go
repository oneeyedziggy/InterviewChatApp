package main

import (
	"testing"
	"time"
)

func TestCacheSetGetHasDelete(t *testing.T) {
	t.Parallel()

	c := &Cache{items: make(map[string]*CacheEntry), ttl: time.Hour}
	c.Set("alpha", "one")

	if got, ok := c.Get("alpha"); !ok || got != "one" {
		t.Fatalf("expected cached value, got %q %v", got, ok)
	}
	if !c.Has("alpha") {
		t.Fatal("expected cache entry to exist")
	}

	c.Delete("alpha")
	if _, ok := c.Get("alpha"); ok {
		t.Fatal("expected deleted key to be absent")
	}
	if c.Has("alpha") {
		t.Fatal("expected deleted key to be absent from Has")
	}
}

func TestCacheExpiredEntry(t *testing.T) {
	t.Parallel()

	c := &Cache{items: make(map[string]*CacheEntry), ttl: time.Hour}
	c.items["expired"] = &CacheEntry{
		Value:     "gone",
		ExpiresAt: time.Now().Add(-time.Second),
	}

	if _, ok := c.Get("expired"); ok {
		t.Fatal("expected expired cache entry to be unreadable")
	}
	if c.Has("expired") {
		t.Fatal("expected expired cache entry to report false from Has")
	}
}

func TestCacheCleanup(t *testing.T) {
	t.Parallel()

	c := &Cache{items: make(map[string]*CacheEntry), ttl: time.Hour}
	c.items["expired"] = &CacheEntry{Value: "gone", ExpiresAt: time.Now().Add(-time.Second)}
	c.items["live"] = &CacheEntry{Value: "keep", ExpiresAt: time.Now().Add(time.Hour)}

	c.purgeExpiredLocked()

	if _, ok := c.items["expired"]; ok {
		t.Fatal("expected cleanup to remove expired entry")
	}
	if _, ok := c.items["live"]; !ok {
		t.Fatal("expected cleanup to keep live entry")
	}
}
