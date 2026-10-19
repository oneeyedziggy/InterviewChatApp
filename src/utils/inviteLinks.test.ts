import { describe, expect, it } from 'vitest';
import { buildInviteUrl, parseInviteUrl } from './inviteLinks';

describe('invite links', () => {
  it('keeps the friendly label in the fragment, not the request query', () => {
    const inviteUrl = buildInviteUrl({
      origin: 'https://chat.example',
      inviteCode: 'code/with+symbols',
      serverId: 'tenant-42',
      serverLabel: 'Glink & Friends',
    });
    const url = new URL(inviteUrl);

    expect(url.searchParams.get('invite')).toBe('code/with+symbols');
    expect(url.searchParams.get('server')).toBe('tenant-42');
    expect(url.search).not.toContain('Glink');
    expect(url.hash).toContain('Glink');
    expect(parseInviteUrl(inviteUrl, 'https://chat.example')).toEqual({
      serverId: 'tenant-42',
      inviteCode: 'code/with+symbols',
      serverLabel: 'Glink & Friends',
    });
  });

  it('rejects links without both required query parameters', () => {
    expect(() =>
      parseInviteUrl(
        'https://chat.example/login?invite=code',
        'https://chat.example',
      ),
    ).toThrow(/missing its server or invite code/i);
    expect(() =>
      parseInviteUrl(
        'https://chat.example/login?server=tenant',
        'https://chat.example',
      ),
    ).toThrow(/missing its server or invite code/i);
  });

  it('rejects links to another origin or route', () => {
    expect(() =>
      parseInviteUrl(
        'https://attacker.example/login?invite=x&server=y',
        'https://chat.example',
      ),
    ).toThrow(/must come from this chat server/i);
    expect(() =>
      parseInviteUrl(
        'https://chat.example/?invite=x&server=y',
        'https://chat.example',
      ),
    ).toThrow(/not a chat server invite/i);
  });
});
