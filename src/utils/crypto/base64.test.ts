import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

describe('base64 byte conversions', () => {
  it('round trips arbitrary bytes', () => {
    const input = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

    expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
  });

  it('round trips empty input', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array()))).toEqual(
      new Uint8Array(),
    );
  });
});
