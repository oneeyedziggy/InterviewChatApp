import { describe, expect, it } from 'vitest';
import { asRecord, parsePositiveTimestamp } from './payloadGuards';

describe('payloadGuards', () => {
  it('asRecord accepts only plain objects', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
  });

  it('parsePositiveTimestamp handles numbers and numeric strings', () => {
    expect(parsePositiveTimestamp(12.9)).toBe(12);
    expect(parsePositiveTimestamp('34')).toBe(34);
    expect(parsePositiveTimestamp(0)).toBeUndefined();
    expect(parsePositiveTimestamp('nope')).toBeUndefined();
    expect(parsePositiveTimestamp(undefined)).toBeUndefined();
  });
});
