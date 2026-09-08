import { describe, expect, it } from 'vitest';
import { mergeMessageWindow } from './messageWindow';
import type { Message } from '../types/types';

const message = (timestamp: number, id = `message-${timestamp}`): Message => ({
  id,
  timestamp,
  userId: 'user-1',
  roomId: 'room-1',
  content: `message ${timestamp}`,
});

describe('mergeMessageWindow', () => {
  it('deduplicates and keeps the newest fixed-size window', () => {
    const result = mergeMessageWindow(
      [message(1), message(2)],
      [message(2, 'message-2'), message(3), message(4)],
      'newer',
      3,
    );
    expect(result.map((entry) => entry.timestamp)).toEqual([2, 3, 4]);
  });

  it('keeps the older side when prepending history', () => {
    const result = mergeMessageWindow(
      [message(5), message(6)],
      [message(1), message(2), message(3), message(4)],
      'older',
      3,
    );
    expect(result.map((entry) => entry.timestamp)).toEqual([1, 2, 3]);
  });
});
