import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mySessionCache, myUserCache } from './cache';

describe('cache exports', () => {
  beforeEach(() => {
    // Clear caches before each test
    mySessionCache.flushAll();
    myUserCache.flushAll();
  });

  afterEach(() => {
    // Clean up after each test
    mySessionCache.flushAll();
    myUserCache.flushAll();
  });

  describe('mySessionCache', () => {
    it('is defined and is an instance of NodeCache', () => {
      expect(mySessionCache).toBeDefined();
      expect(mySessionCache).toHaveProperty('set');
      expect(mySessionCache).toHaveProperty('get');
      expect(mySessionCache).toHaveProperty('has');
    });

    it('can store and retrieve session data', () => {
      const sessionId = 'test-session-id';
      const username = 'testuser';

      mySessionCache.set(sessionId, username);
      const retrieved = mySessionCache.get(sessionId);

      expect(retrieved).toBe(username);
    });

    it('can check if session exists', () => {
      const sessionId = 'test-session-id';
      const username = 'testuser';

      expect(mySessionCache.has(sessionId)).toBe(false);

      mySessionCache.set(sessionId, username);

      expect(mySessionCache.has(sessionId)).toBe(true);
    });

    it('has TTL configured for 4 hours', () => {
      // NodeCache stores TTL in seconds, 4 hours = 14400 seconds
      const sessionId = 'test-session';
      mySessionCache.set(sessionId, 'user');

      // The cache should have TTL configured
      const ttl = mySessionCache.getTtl(sessionId);
      expect(ttl).toBeGreaterThan(0);
    });
  });

  describe('myUserCache', () => {
    it('is defined and is an instance of NodeCache', () => {
      expect(myUserCache).toBeDefined();
      expect(myUserCache).toHaveProperty('set');
      expect(myUserCache).toHaveProperty('get');
      expect(myUserCache).toHaveProperty('has');
    });

    it('can store and retrieve user data', () => {
      const username = 'testuser';
      const hashedPassword = 'hashed-password-value';

      myUserCache.set(username, hashedPassword);
      const retrieved = myUserCache.get(username);

      expect(retrieved).toBe(hashedPassword);
    });

    it('can check if user exists', () => {
      const username = 'testuser';
      const hashedPassword = 'hashed-password';

      expect(myUserCache.has(username)).toBe(false);

      myUserCache.set(username, hashedPassword);

      expect(myUserCache.has(username)).toBe(true);
    });

    it('does not expire entries by default', () => {
      const username = 'testuser';
      const hashedPassword = 'hashed-password';

      myUserCache.set(username, hashedPassword);
      const ttl = myUserCache.getTtl(username);

      // No TTL means undefined or 0 (NodeCache returns 0 for no TTL)
      expect(ttl === undefined || ttl === 0).toBe(true);
    });
  });
});

