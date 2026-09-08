import { describe, expect, it } from 'vitest';
import { countUnicodeCodePoints, normalizeRoomName } from './unicode';

describe('unicode utilities', () => {
  it('counts code points rather than UTF-16 code units', () => {
    expect(countUnicodeCodePoints('😀')).toBe(1);
    expect(countUnicodeCodePoints('e\u0301')).toBe(2);
  });

  it('normalizes equivalent room names for comparison and hashing', () => {
    expect(normalizeRoomName('  Caf\u00e9  ')).toBe('café');
    expect(normalizeRoomName(' cafe\u0301 ')).toBe('café');
  });
});
