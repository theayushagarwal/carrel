export type Candidate = {
  id: string;
  joinedAt: number;
  connected: boolean;
  role?: 'host' | 'member';
};

export type HostPending = {
  id: string;
  deadline: number;
  timer?: unknown;
};

export type RoomHostState = {
  hostId: string | null;
  hostPending: HostPending | null;
  members: Map<string, Candidate> | Iterable<[string, Candidate]> | Candidate[];
  recentlyLeft?:
    | Map<string, { joinedAt: number; leftAt: number; [key: string]: unknown }>
    | Record<string, { joinedAt: number; leftAt: number; [key: string]: unknown }>;
  now?: number;
};

/**
 * Pure election function.
 * Only connected candidates qualify.
 * Oldest joinedAt wins; ties broken by clientId ascending (plain string comparison).
 * Empty qualified candidates returns null.
 */
export function electHost(candidates: Candidate[]): string | null {
  const eligible = candidates.filter((c) => c.connected);
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) {
      return a.joinedAt - b.joinedAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return eligible[0].id;
}

/**
 * Validates room host invariants:
 * (1) at most one host;
 * (2) if connected members exist and no grace timer is pending, exactly one host;
 * (3) the host is a connected member, or is the single pending host inside its grace window;
 * (4) joinedAt of a clientId never changes while it stays in the seniority window.
 */
export function checkInvariants(room: RoomHostState): void {
  const membersList: Candidate[] = Array.isArray(room.members)
    ? room.members
    : room.members instanceof Map
      ? Array.from(room.members.values())
      : Array.from(Object.values(room.members));

  // Invariant 1: At most one host
  const hostsInMembers = membersList.filter((m) => m.role === 'host');
  if (hostsInMembers.length > 1) {
    throw new Error(
      `Invariant violation: More than one host in members roster (${hostsInMembers.map((h) => h.id).join(', ')})`,
    );
  }

  const connectedMembers = membersList.filter((m) => m.connected);

  // Invariant 2: If connected members exist and no grace timer is pending, exactly one host
  if (connectedMembers.length > 0 && room.hostPending === null) {
    if (!room.hostId) {
      throw new Error(
        `Invariant violation: Connected members exist (${connectedMembers.length}) and no grace pending, but room.hostId is null`,
      );
    }
    if (hostsInMembers.length !== 1) {
      throw new Error(
        `Invariant violation: Connected members exist and no grace pending, but found ${hostsInMembers.length} host role members (expected 1)`,
      );
    }
    if (hostsInMembers[0].id !== room.hostId) {
      throw new Error(
        `Invariant violation: Member with host role (${hostsInMembers[0].id}) does not match room.hostId (${room.hostId})`,
      );
    }
  }

  // Invariant 3: The host is a connected member, or is the single pending host inside its grace window
  if (room.hostId) {
    const hostMember = membersList.find((m) => m.id === room.hostId);
    if (!hostMember) {
      throw new Error(
        `Invariant violation: room.hostId (${room.hostId}) is not present in members roster`,
      );
    }

    if (!hostMember.connected) {
      if (!room.hostPending) {
        throw new Error(
          `Invariant violation: Host (${room.hostId}) is disconnected but room.hostPending is null`,
        );
      }
      if (room.hostPending.id !== room.hostId) {
        throw new Error(
          `Invariant violation: Pending host (${room.hostPending.id}) does not match room.hostId (${room.hostId})`,
        );
      }
      if (room.now !== undefined && room.now > room.hostPending.deadline) {
        throw new Error(
          `Invariant violation: Host grace window expired at ${room.hostPending.deadline}, current time is ${room.now}`,
        );
      }
    }
  }

  // Invariant 4: joinedAt of a clientId never changes while it stays in the seniority window
  if (room.recentlyLeft) {
    const recentlyLeftMap =
      room.recentlyLeft instanceof Map
        ? room.recentlyLeft
        : new Map(Object.entries(room.recentlyLeft));

    for (const member of membersList) {
      const prev = recentlyLeftMap.get(member.id);
      if (prev && member.joinedAt !== prev.joinedAt) {
        throw new Error(
          `Invariant violation: Member ${member.id} joinedAt changed from ${prev.joinedAt} to ${member.joinedAt} while in seniority window`,
        );
      }
    }
  }
}
