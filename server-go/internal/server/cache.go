package server

import (
	"sync"
	"time"
)

type CacheEntry struct {
	Value     string
	ExpiresAt time.Time
	CreatedAt time.Time
}

type Cache struct {
	mu          sync.RWMutex
	items       map[string]*CacheEntry
	ttl         time.Duration
	maxLifetime time.Duration
	done        chan struct{}
	closeOnce   sync.Once
}

func NewCache(ttl time.Duration) *Cache {
	c := &Cache{
		items: make(map[string]*CacheEntry),
		ttl:   ttl,
		done:  make(chan struct{}),
	}
	go c.cleanup()
	return c
}

// NewSlidingCache builds a cache whose entries can be extended by Touch up to
// maxLifetime after creation. A zero maxLifetime allows unbounded extension.
func NewSlidingCache(idleTTL, maxLifetime time.Duration) *Cache {
	c := NewCache(idleTTL)
	c.maxLifetime = maxLifetime
	return c
}

func (c *Cache) Close() {
	c.closeOnce.Do(func() {
		if c.done != nil {
			close(c.done)
		}
	})
}

func (c *Cache) Set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.items[key] = &CacheEntry{
		Value:     value,
		ExpiresAt: c.boundedExpiry(now.Add(c.ttl), now),
		CreatedAt: now,
	}
}

// boundedExpiry clamps a candidate expiry to createdAt+maxLifetime.
func (c *Cache) boundedExpiry(candidate, createdAt time.Time) time.Time {
	if c.maxLifetime <= 0 {
		return candidate
	}
	if hardDeadline := createdAt.Add(c.maxLifetime); candidate.After(hardDeadline) {
		return hardDeadline
	}
	return candidate
}

// Touch reads a live entry and slides its expiry forward by the cache TTL,
// never past the absolute maximum lifetime. It returns the remaining validity
// so callers can tell clients when to revalidate.
func (c *Cache) Touch(key string) (value string, expiresAt time.Time, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, exists := c.items[key]
	if !exists {
		return "", time.Time{}, false
	}
	now := time.Now()
	entry.ExpiresAt = c.boundedExpiry(entry.ExpiresAt, entry.CreatedAt)
	if now.After(entry.ExpiresAt) {
		return "", time.Time{}, false
	}

	if extended := c.boundedExpiry(now.Add(c.ttl), entry.CreatedAt); extended.After(entry.ExpiresAt) {
		entry.ExpiresAt = extended
	}
	return entry.Value, entry.ExpiresAt, true
}

func (c *Cache) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, exists := c.items[key]
	if !exists {
		return "", false
	}
	if time.Now().After(entry.ExpiresAt) {
		return "", false
	}
	return entry.Value, true
}

func (c *Cache) Has(key string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, exists := c.items[key]
	if !exists {
		return false
	}
	return time.Now().Before(entry.ExpiresAt)
}

func (c *Cache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, key)
}

// Len returns the current number of (possibly expired, not-yet-swept) entries.
// Intended for diagnostic logging only.
func (c *Cache) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.items)
}

func (c *Cache) cleanup() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	if c.done == nil {
		for range ticker.C {
			c.purgeExpiredLocked()
		}
		return
	}
	for {
		select {
		case <-ticker.C:
			c.purgeExpiredLocked()
		case <-c.done:
			return
		}
	}
}

func (c *Cache) purgeExpiredLocked() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for key, entry := range c.items {
		if now.After(entry.ExpiresAt) {
			delete(c.items, key)
		}
	}
}
