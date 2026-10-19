import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadServerMemberships,
  mergeServerMemberships,
  removeServerMembership,
  upsertServerMembership,
} from './serverRegistry';

const membership = {
  serverId: 'tenant-id',
  alias: 'friendly-server',
  label: 'My Server',
  shorthand: 'M',
  username: 'alice',
  userId: 'account-id',
};

describe('server membership persistence', () => {
  beforeEach(() => localStorage.clear());

  it('reconciles alias-based relogins with the canonical membership', () => {
    upsertServerMembership(membership);
    const result = upsertServerMembership({
      ...membership,
      serverId: 'friendly-server',
      alias: undefined,
    });
    expect(result).toEqual([membership]);
    expect(loadServerMemberships()).toEqual([membership]);
  });

  it('reconciles legacy alias duplicates regardless of stored order', () => {
    for (const entries of [
      [
        membership,
        { ...membership, serverId: 'friendly-server', alias: undefined },
      ],
      [
        { ...membership, serverId: 'friendly-server', alias: undefined },
        membership,
      ],
    ]) {
      localStorage.setItem(
        'chat_server_memberships_v1',
        JSON.stringify(entries),
      );
      expect(loadServerMemberships()).toEqual([membership]);
    }
  });

  it('reconciles an alias membership that repeats its route value as the alias', () => {
    upsertServerMembership(membership);
    expect(
      upsertServerMembership({ ...membership, serverId: 'friendly-server' }),
    ).toEqual([membership]);
  });

  it('updates names for the same authoritative account without adding a membership', () => {
    upsertServerMembership(membership);
    expect(
      upsertServerMembership({ ...membership, username: 'renamed' }),
    ).toEqual([{ ...membership, username: 'renamed' }]);
  });

  it('keeps different tenants and different accounts separate', () => {
    const otherTenant = {
      ...membership,
      serverId: 'other-tenant',
      alias: 'other-alias',
      shorthand: 'MY',
    };
    const otherAccount = {
      ...membership,
      userId: 'other-account',
      shorthand: 'M3',
    };
    expect(
      mergeServerMemberships([membership, otherTenant, otherAccount]),
    ).toEqual([membership, otherTenant, otherAccount]);
  });

  it('does not remap a canonical tenant whose ID matches another alias', () => {
    const canonicalTenant = {
      ...membership,
      serverId: 'friendly-server',
      alias: 'another-alias',
      shorthand: 'MY',
    };
    expect(mergeServerMemberships([membership, canonicalTenant])).toEqual([
      membership,
      canonicalTenant,
    ]);
  });

  it('does not guess a tenant when an alias is ambiguous', () => {
    const otherTenant = {
      ...membership,
      serverId: 'other-tenant',
      alias: 'friendly-server',
      shorthand: 'MY',
    };
    const ambiguous = {
      ...membership,
      serverId: 'friendly-server',
      alias: undefined,
    };
    ambiguous.shorthand = 'M3';
    expect(
      mergeServerMemberships([membership, otherTenant, ambiguous]),
    ).toEqual([membership, otherTenant, ambiguous]);
  });

  it('selects shorthand candidates in the requested priority order', () => {
    const first = upsertServerMembership({
      ...membership,
      serverId: 'first',
      alias: 'first',
      label: 'Chat',
      shorthand: undefined,
    }).find((entry) => entry.serverId === 'first');
    const second = upsertServerMembership({
      ...membership,
      serverId: 'second',
      alias: 'second',
      label: 'Chat',
      shorthand: undefined,
    }).find((entry) => entry.serverId === 'second');
    const third = upsertServerMembership({
      ...membership,
      serverId: 'third',
      alias: 'third',
      label: 'Chat',
      shorthand: undefined,
    }).find((entry) => entry.serverId === 'third');

    expect([first?.shorthand, second?.shorthand, third?.shorthand]).toEqual([
      'C',
      'CH',
      'C3',
    ]);
  });

  it('uses the identical-name ordinal when the short prefixes are occupied', () => {
    mergeServerMemberships([
      {
        ...membership,
        serverId: 'garden-one',
        label: 'Garden',
        shorthand: 'G',
      },
      {
        ...membership,
        serverId: 'garden-two',
        label: 'Garden',
        shorthand: 'GA',
      },
    ]);

    const result = upsertServerMembership({
      ...membership,
      serverId: 'garden-three',
      alias: 'garden-three',
      label: 'Garden',
      shorthand: undefined,
    });

    expect(
      result.find((entry) => entry.serverId === 'garden-three')?.shorthand,
    ).toBe('G3');
  });

  it('preserves assigned shorthand when another server leaves', () => {
    upsertServerMembership({
      ...membership,
      serverId: 'conflict-one',
      alias: 'conflict-one',
      label: 'Cove',
      shorthand: 'C',
    });
    upsertServerMembership({
      ...membership,
      serverId: 'conflict-two',
      alias: 'conflict-two',
      label: 'Chime',
      shorthand: 'CH',
    });
    upsertServerMembership({
      ...membership,
      serverId: 'target',
      alias: 'target',
      label: 'Chat',
      shorthand: undefined,
    });

    const beforeLeave = loadServerMemberships().find(
      (entry) => entry.serverId === 'target',
    )?.shorthand;
    removeServerMembership('conflict-one');
    const afterLeave = loadServerMemberships().find(
      (entry) => entry.serverId === 'target',
    )?.shorthand;

    expect(beforeLeave).toBe('C1');
    expect(afterLeave).toBe(beforeLeave);
  });

  it('backfills older memberships in stored order', () => {
    const legacyEntries = [
      {
        ...membership,
        serverId: 'legacy-one',
        alias: 'legacy-one',
        label: 'Echo',
        shorthand: undefined,
      },
      {
        ...membership,
        serverId: 'legacy-two',
        alias: 'legacy-two',
        label: 'Echo',
        shorthand: undefined,
      },
    ];
    localStorage.setItem(
      'chat_server_memberships_v1',
      JSON.stringify(legacyEntries),
    );

    const loaded = loadServerMemberships();

    expect(loaded.map((entry) => entry.shorthand)).toEqual(['E', 'EC']);
    expect(
      JSON.parse(localStorage.getItem('chat_server_memberships_v1') || '[]'),
    ).toEqual(loaded);
  });

  it('uses a longer unique fallback after the listed short candidates are exhausted', () => {
    mergeServerMemberships([
      { ...membership, serverId: 'a', label: 'A', shorthand: 'A' },
      ...Array.from({ length: 9 }, (_, index) => ({
        ...membership,
        serverId: `other-${index}`,
        label: `Other ${index}`,
        shorthand: `A${index + 1}`,
      })),
    ]);

    const result = upsertServerMembership({
      ...membership,
      serverId: 'another-a',
      alias: 'another-a',
      label: 'A',
      shorthand: undefined,
    });

    expect(
      result.find((entry) => entry.serverId === 'another-a')?.shorthand,
    ).toBe('A10');
  });
});
