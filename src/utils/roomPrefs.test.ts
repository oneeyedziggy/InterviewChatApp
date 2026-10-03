import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeStoredRoomPrefs,
  loadRoomPrefs,
  roomPrefsStorageKey,
} from './roomPrefs';

const gpgMocks = vi.hoisted(() => ({ decryptJsonForCurrentUser: vi.fn() }));
vi.mock('./gpg', () => gpgMocks);

describe('roomPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
    gpgMocks.decryptJsonForCurrentUser.mockReset();
  });

  it('decodes plaintext prefs', async () => {
    expect(await decodeStoredRoomPrefs('{"currentRoom":"general"}')).toEqual({
      currentRoom: 'general',
    });
  });

  it('decrypts enc-v1 prefs', async () => {
    gpgMocks.decryptJsonForCurrentUser.mockResolvedValue({ openRooms: ['a'] });
    expect(
      await decodeStoredRoomPrefs('{"version":"enc-v1","ciphertext":"c"}'),
    ).toEqual({ openRooms: ['a'] });
    expect(gpgMocks.decryptJsonForCurrentUser).toHaveBeenCalledWith('c');
  });

  it('throws on invalid JSON', async () => {
    await expect(decodeStoredRoomPrefs('{')).rejects.toThrow();
  });

  it('loadRoomPrefs sanitizes values and swallows errors', async () => {
    localStorage.setItem(
      roomPrefsStorageKey('bob'),
      JSON.stringify({ leftRooms: ['x', 3], currentRoom: 5, openRooms: ['y'] }),
    );
    expect(await loadRoomPrefs('bob')).toEqual({
      leftRooms: ['x'],
      currentRoom: undefined,
      openRooms: ['y'],
    });

    localStorage.setItem(roomPrefsStorageKey('bob'), '{');
    expect(await loadRoomPrefs('bob')).toEqual({});
    expect(await loadRoomPrefs('')).toEqual({});
  });
});
