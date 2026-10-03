import signedAuth from 'k6/x/signedauth';

const expected =
  'v1|clientMessage|user-a|session-a|1234567890|nonce-id|a=NDI&b=dHJ1ZQ&c=eyJuZXN0ZWQiOiJ2YWx1ZSJ9';

export default function () {
  const actual = signedAuth.canonicalInput(
    'clientMessage',
    'user-a',
    'session-a',
    1234567890,
    'nonce-id',
    { b: true, a: 42, c: { nested: 'value' } },
  );
  if (actual !== expected) {
    throw new Error(`canonical input mismatch: ${actual}`);
  }
}