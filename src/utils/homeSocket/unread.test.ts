import { describe, expect, it, vi } from 'vitest';
import { type Message } from '../../types/types';
import {
  applyUnreadIncrements,
  computeUnreadIncrements,
  deleteFromSet,
  deleteKeys,
  selectDmRoomsToUnhide,
} from './unread';

vi.mock('../identityMap', () => ({
  getUsernameByUserId: () => undefined,
  getRoomNameByRoomId: () => undefined,
  getUserIdByUsername: (name: string) => (name === 'me' ? 'u-me' : undefined),
  requireUserIdByUsername: (name: string) => `id-${name}`,
}));

vi.mock('../gpg', () => ({ decryptMessageForUser: vi.fn() }));

const msg = (id: string): Message =>
  ({ id, timestamp: 1, userId: 'x', username: 'x', content: 'c' }) as Message;

describe('computeUnreadIncrements', () => {
  it('counts only unseen messages and zeroes a new current room', () => {
    const increments = computeUnreadIncrements(
      { known: [msg('a'), msg('b')], fresh: [msg('c')], current: [msg('d')] },
      { known: [msg('a')] },
      'current',
      new Set(),
    );
    expect(increments).toEqual({ known: 1, fresh: 1, current: 0 });
  });
});

describe('applyUnreadIncrements', () => {
  it('adds increments and resets the current room', () => {
    expect(
      applyUnreadIncrements({ a: 2, cur: 5 }, { a: 1, b: 3, cur: 4 }, 'cur'),
    ).toEqual({ a: 3, b: 3, cur: 0 });
  });
});

describe('selectDmRoomsToUnhide', () => {
  it('only resurfaces hidden DMs whose unread exceeds the baseline', () => {
    const dm1 = '@dmid:u-me|u-other';
    const dm2 = '@dmid:u-me|u-third';
    const rooms = selectDmRoomsToUnhide({
      increments: { [dm1]: 1, [dm2]: 1, general: 4 },
      nextNotifications: { [dm1]: 3, [dm2]: 2, general: 4 },
      hiddenRooms: new Set([dm1, dm2, 'general']),
      hiddenDmUnreadBaseline: { [dm1]: 2, [dm2]: 2 },
      username: 'me',
    });
    expect(rooms).toEqual([dm1]);
  });
});

describe('deleteFromSet / deleteKeys', () => {
  it('returns the same reference when nothing changes', () => {
    const set = new Set(['a']);
    const record = { a: 1 };
    expect(deleteFromSet(set, ['z'])).toBe(set);
    expect(deleteKeys(record, ['z'])).toBe(record);
  });

  it('removes present entries without mutating input', () => {
    const set = new Set(['a', 'b']);
    const record = { a: 1, b: 2 };
    expect([...deleteFromSet(set, ['a'])]).toEqual(['b']);
    expect(deleteKeys(record, ['a'])).toEqual({ b: 2 });
    expect(set.size).toBe(2);
    expect(record).toEqual({ a: 1, b: 2 });
  });
});
