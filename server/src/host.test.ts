import { describe, expect, it } from 'vitest';
import { electHost, checkInvariants, type Candidate, type RoomHostState } from './host.js';

describe('A1: Pure Election Module (host.ts)', () => {
  it('electHost: oldest joinedAt wins', () => {
    const candidates: Candidate[] = [
      { id: 'charlie', joinedAt: 3000, connected: true },
      { id: 'alice', joinedAt: 1000, connected: true },
      { id: 'bob', joinedAt: 2000, connected: true },
    ];
    expect(electHost(candidates)).toBe('alice');
  });

  it('electHost: ties broken by clientId ascending', () => {
    const candidates: Candidate[] = [
      { id: 'user-z', joinedAt: 1000, connected: true },
      { id: 'user-a', joinedAt: 1000, connected: true },
      { id: 'user-m', joinedAt: 1000, connected: true },
    ];
    expect(electHost(candidates)).toBe('user-a');
  });

  it('electHost: excludes disconnected candidates', () => {
    const candidates: Candidate[] = [
      { id: 'alice', joinedAt: 1000, connected: false },
      { id: 'bob', joinedAt: 2000, connected: true },
      { id: 'charlie', joinedAt: 3000, connected: false },
    ];
    expect(electHost(candidates)).toBe('bob');
  });

  it('electHost: returns null when empty or all disconnected', () => {
    expect(electHost([])).toBeNull();
    expect(
      electHost([
        { id: 'alice', joinedAt: 1000, connected: false },
        { id: 'bob', joinedAt: 2000, connected: false },
      ]),
    ).toBeNull();
  });

  describe('checkInvariants', () => {
    it('passes for valid states (single connected host, or empty dormant)', () => {
      // Empty room
      const emptyRoom: RoomHostState = {
        hostId: null,
        hostPending: null,
        members: new Map(),
      };
      expect(() => checkInvariants(emptyRoom)).not.toThrow();

      // Normal room with 1 host and 1 member
      const normalRoom: RoomHostState = {
        hostId: 'alice',
        hostPending: null,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 1000, connected: true, role: 'host' }],
          ['bob', { id: 'bob', joinedAt: 2000, connected: true, role: 'member' }],
        ]),
      };
      expect(() => checkInvariants(normalRoom)).not.toThrow();

      // Host in grace window
      const graceRoom: RoomHostState = {
        hostId: 'alice',
        hostPending: { id: 'alice', deadline: 6000 },
        now: 3000,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 1000, connected: false, role: 'host' }],
          ['bob', { id: 'bob', joinedAt: 2000, connected: true, role: 'member' }],
        ]),
      };
      expect(() => checkInvariants(graceRoom)).not.toThrow();
    });

    it('throws when more than one host exists (Invariant 1)', () => {
      const invalidRoom: RoomHostState = {
        hostId: 'alice',
        hostPending: null,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 1000, connected: true, role: 'host' }],
          ['bob', { id: 'bob', joinedAt: 2000, connected: true, role: 'host' }],
        ]),
      };
      expect(() => checkInvariants(invalidRoom)).toThrow(/More than one host/);
    });

    it('throws when connected members exist without grace, but no host (Invariant 2)', () => {
      const headlessRoom: RoomHostState = {
        hostId: null,
        hostPending: null,
        members: new Map<string, Candidate>([
          ['bob', { id: 'bob', joinedAt: 2000, connected: true, role: 'member' }],
        ]),
      };
      expect(() => checkInvariants(headlessRoom)).toThrow(
        /Connected members exist .* but room\.hostId is null/,
      );
    });

    it('throws when host is disconnected and grace is null or expired (Invariant 3)', () => {
      const disconnectedNoGrace: RoomHostState = {
        hostId: 'alice',
        hostPending: null,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 1000, connected: false, role: 'host' }],
        ]),
      };
      expect(() => checkInvariants(disconnectedNoGrace)).toThrow(
        /Host .* is disconnected but room\.hostPending is null/,
      );

      const expiredGrace: RoomHostState = {
        hostId: 'alice',
        hostPending: { id: 'alice', deadline: 4000 },
        now: 5000,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 1000, connected: false, role: 'host' }],
        ]),
      };
      expect(() => checkInvariants(expiredGrace)).toThrow(/Host grace window expired/);
    });

    it('throws when joinedAt changes within seniority window (Invariant 4)', () => {
      const seniorityTamperedRoom: RoomHostState = {
        hostId: 'alice',
        hostPending: null,
        members: new Map<string, Candidate>([
          ['alice', { id: 'alice', joinedAt: 5000, connected: true, role: 'host' }],
        ]),
        recentlyLeft: new Map([['alice', { joinedAt: 1000, leftAt: 4000 }]]),
      };
      expect(() => checkInvariants(seniorityTamperedRoom)).toThrow(
        /joinedAt changed from 1000 to 5000/,
      );
    });
  });
});
