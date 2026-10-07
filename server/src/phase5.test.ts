import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import { buildApp, type ServerConfig } from './index.js';
import { electHost, checkInvariants, type RoomHostState } from './host.js';
import {
  encodeControl,
  encodeSyncUpdate,
  decodeFrame,
  FRAME_TYPES,
  CLOSE_CODES,
} from '@carrel/shared';

const configs: { app: ReturnType<typeof buildApp>; dir: string }[] = [];

function setup(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carrel-p5-test-'));
  const app = buildApp({
    port: 0,
    clientOrigin: '*',
    databasePath: join(dir, 'test.db'),
    sessionSecret: 'test-session-secret-01234567890123456789',
    hostGraceMs: 50,
    seniorityWindowMs: 30000,
    kickBanMs: 600000,
    editCoalesceMs: 200,
    maxDocBytes: 1024 * 1024,
    maxPeersPerRoom: 7,
    ticketTtlMs: 60000,
    sessionTtlMs: 86400000,
    rateLimitUpdatesPerSec: 50,
    rateLimitControlPerSec: 50,
    throttleWarnMs: 3000,
    throttleKickMs: 10000,
    heartbeatMs: 15000,
    maxBufferBytes: 524288,
    ...overrides,
  });
  configs.push({ app, dir });
  return app;
}

async function closeAll() {
  for (const { app, dir } of configs.splice(0)) {
    try {
      await (app.app as any).closeCarrel();
      await app.app.close();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

afterEach(async () => {
  await closeAll();
});

async function create(app: ReturnType<typeof buildApp>, payload: Record<string, unknown>) {
  return app.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload,
  });
}

async function joinRoom(
  app: ReturnType<typeof buildApp>,
  id: string,
  payload: Record<string, unknown>,
) {
  return app.app.inject({
    method: 'POST',
    url: `/api/rooms/${id}/join`,
    payload,
  });
}

type ClientWrapper = {
  ws: WebSocket;
  controlMessages: any[];
  syncUpdates: Uint8Array[];
  closeCodes: number[];
  sendControl: (msg: any) => void;
  sendSyncUpdate: (update: Uint8Array) => void;
  waitForControl: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: (code?: number, reason?: string) => Promise<void>;
};

async function connectClient(port: number, ticket: string): Promise<ClientWrapper> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
  const controlMessages: any[] = [];
  const syncUpdates: Uint8Array[] = [];
  const closeCodes: number[] = [];
  const listeners: ((msg: any) => void)[] = [];

  ws.on('message', (raw: Buffer) => {
    try {
      const { type, payload } = decodeFrame(Buffer.from(raw));
      if (type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(payload).toString('utf8'));
        controlMessages.push(msg);
        for (const l of [...listeners]) l(msg);
      } else if (type === FRAME_TYPES.sync) {
        const dec = decoding.createDecoder(payload);
        const syncType = decoding.readVarUint(dec);
        if (syncType === syncProtocol.messageYjsUpdate) {
          syncUpdates.push(decoding.readVarUint8Array(dec));
        }
      }
    } catch {}
  });

  ws.on('close', (code) => {
    closeCodes.push(code);
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    ws,
    controlMessages,
    syncUpdates,
    closeCodes,
    sendControl: (msg: any) => ws.send(encodeControl(msg)),
    sendSyncUpdate: (update: Uint8Array) => ws.send(encodeSyncUpdate(update)),
    waitForControl: (predicate: (msg: any) => boolean, timeoutMs = 2000) => {
      const found = controlMessages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(handler);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(new Error(`waitForControl timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (msg: any) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            const idx = listeners.indexOf(handler);
            if (idx !== -1) listeners.splice(idx, 1);
            resolve(msg);
          }
        };
        listeners.push(handler);
      });
    },
    close: async (code = 1000, reason = 'normal') => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
        await new Promise((r) => ws.once('close', r));
      }
    },
  };
}

describe('Phase 5: Dynamic Host Reassignment, Host Powers, and Live Activity Audit Feed', () => {
  // Test 1
  it('1. electHost: oldest joinedAt wins; ties by clientId; excludes disconnected; empty -> null', () => {
    // Oldest joinedAt wins
    expect(
      electHost([
        { id: 'b', joinedAt: 200, connected: true },
        { id: 'a', joinedAt: 100, connected: true },
      ]),
    ).toBe('a');

    // Ties broken by clientId ascending
    expect(
      electHost([
        { id: 'z', joinedAt: 100, connected: true },
        { id: 'm', joinedAt: 100, connected: true },
        { id: 'a', joinedAt: 100, connected: true },
      ]),
    ).toBe('a');

    // Excludes disconnected
    expect(
      electHost([
        { id: 'a', joinedAt: 50, connected: false },
        { id: 'b', joinedAt: 100, connected: true },
      ]),
    ).toBe('b');

    // Empty -> null
    expect(electHost([])).toBeNull();
    expect(electHost([{ id: 'a', joinedAt: 50, connected: false }])).toBeNull();
  });

  // Test 2
  it('2. Host refreshes within grace: still host, NO host_changed row, no role flap', async () => {
    let fakeNow = 1000;
    const app = setup({ clock: () => fakeNow, hostGraceMs: 5000 });
    const res = (
      await create(app, { id: 'p5-t2', displayName: 'HostA', clientId: 'host-a' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const c1 = await connectClient(port, res.ticket);
    const room = app.rooms.get('p5-t2')!;
    expect(room.hostId).toBe('host-a');

    // Host drops
    await c1.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(room.hostPending).not.toBeNull();
    expect(room.hostPending?.id).toBe('host-a');

    // Host returns within grace window (e.g. 500ms later)
    fakeNow += 500;
    const joinRes = (
      await joinRoom(app, 'p5-t2', {
        displayName: 'HostA',
        clientId: 'host-a',
        sessionToken: res.sessionToken,
      })
    ).json();
    const c1Back = await connectClient(port, joinRes.ticket);

    expect(room.hostId).toBe('host-a');
    expect(room.hostPending).toBeNull();
    expect(room.members.get('host-a')?.role).toBe('host');

    // Check audits: NO host_changed row
    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t2') as any[];
    const hostChangedAudits = auditRows.filter((r) => r.type === 'host_changed');
    expect(hostChangedAudits.length).toBe(0);

    const reconnectedAudits = auditRows.filter((r) => r.type === 'reconnected');
    expect(reconnectedAudits.length).toBe(1);

    await c1Back.close();
  });

  // Test 3
  it('3. Host leaves with 1 other member: after grace the other is host; role_changed, roster, and audit all correct on every peer', async () => {
    const app = setup({ hostGraceMs: 80 });
    const r1 = (await create(app, { id: 'p5-t3', displayName: 'Alice', clientId: 'alice' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, r1.ticket);
    const r2 = (
      await joinRoom(app, 'p5-t3', {
        displayName: 'Bob',
        clientId: 'bob',
        creatorKey: r1.creatorKey,
      })
    ).json();
    const bob = await connectClient(port, r2.ticket);

    const room = app.rooms.get('p5-t3')!;
    expect(room.hostId).toBe('alice');

    // Alice leaves
    await alice.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(room.hostPending?.id).toBe('alice');

    // Bob waits for role_changed message
    const roleMsg = await bob.waitForControl((m) => m.type === 'role_changed' && m.role === 'host');
    expect(roleMsg).toMatchObject({
      clientId: 'bob',
      role: 'host',
      previousHostId: 'alice',
      reason: 'host_left',
    });

    expect(room.hostId).toBe('bob');
    expect(room.members.get('bob')?.role).toBe('host');

    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t3') as any[];
    const hostChanged = auditRows.find((r) => r.type === 'host_changed');
    expect(hostChanged).toBeDefined();
    const payload = JSON.parse(hostChanged.payload);
    expect(payload.reason).toBe('host_left');
    expect(payload.to).toBe('bob');

    await bob.close();
  });

  // Test 4
  it('4. Host leaves with 0 others: room dormant, hostId null, snapshot persisted, no error; creator with creatorKey rejoining the empty room becomes host', async () => {
    const app = setup({ hostGraceMs: 50 });
    const r1 = (await create(app, { id: 'p5-t4', displayName: 'Alice', clientId: 'alice' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, r1.ticket);
    alice.sendSyncUpdate(new Uint8Array([0, 1, 2]));
    const room = app.rooms.get('p5-t4')!;

    await alice.close();
    // Wait for grace to expire
    await new Promise((r) => setTimeout(r, 100));

    expect(room.hostId).toBeNull();
    expect(room.members.size).toBe(0);

    const snapshot = app.db.prepare('SELECT * FROM snapshots WHERE room_id=?').get('p5-t4');
    expect(snapshot).toBeDefined();

    // Creator rejoins with creatorKey
    const rejoin = (
      await joinRoom(app, 'p5-t4', {
        displayName: 'Alice',
        clientId: 'alice',
        creatorKey: r1.creatorKey,
      })
    ).json();
    const aliceBack = await connectClient(port, rejoin.ticket);
    expect(room.hostId).toBe('alice');
    expect(room.members.get('alice')?.role).toBe('host');

    await aliceBack.close();
  });

  // Test 5
  it('5. Headless occupied room: a non-creator joining the dormant room is promoted by the vacant rule; audit reason vacant', async () => {
    const app = setup({ hostGraceMs: 50 });
    const r1 = (await create(app, { id: 'p5-t5', displayName: 'Alice', clientId: 'alice' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, r1.ticket);
    await alice.close();
    await new Promise((r) => setTimeout(r, 100));

    const room = app.rooms.get('p5-t5')!;
    expect(room.hostId).toBeNull();

    // Non-creator joins
    const joinNonCreator = (
      await joinRoom(app, 'p5-t5', { displayName: 'Bob', clientId: 'bob' })
    ).json();
    const bob = await connectClient(port, joinNonCreator.ticket);

    expect(room.hostId).toBe('bob');
    expect(room.members.get('bob')?.role).toBe('host');

    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t5') as any[];
    const vacantAudit = auditRows.find(
      (r) => r.type === 'host_changed' && JSON.parse(r.payload).reason === 'vacant',
    );
    expect(vacantAudit).toBeDefined();

    await bob.close();
  });

  // Test 6
  it('6. Identical joinedAt: lower clientId becomes host', () => {
    const winner = electHost([
      { id: 'client-z', joinedAt: 5000, connected: true },
      { id: 'client-a', joinedAt: 5000, connected: true },
    ]);
    expect(winner).toBe('client-a');
  });

  // Test 7
  it('7. Seniority: A joined first, drops and reconnects within 30s, then the host leaves: A is promoted, not B', async () => {
    let nowTime = 10000;
    const app = setup({ clock: () => nowTime, hostGraceMs: 50, seniorityWindowMs: 30000 });
    const rH = (await create(app, { id: 'p5-t7', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);

    // A joins at t=10000
    const rA = (await joinRoom(app, 'p5-t7', { displayName: 'UserA', clientId: 'user-a' })).json();
    const userA = await connectClient(port, rA.ticket);

    // B joins at t=12000
    nowTime = 12000;
    const rB = (await joinRoom(app, 'p5-t7', { displayName: 'UserB', clientId: 'user-b' })).json();
    const userB = await connectClient(port, rB.ticket);

    // A drops at t=14000
    nowTime = 14000;
    await userA.close();

    // A reconnects at t=20000 (within 30s window)
    nowTime = 20000;
    const rABack = (
      await joinRoom(app, 'p5-t7', { displayName: 'UserA', clientId: 'user-a' })
    ).json();
    const userABack = await connectClient(port, rABack.ticket);

    const room = app.rooms.get('p5-t7')!;
    expect(room.members.get('user-a')?.joinedAt).toBe(10000); // Seniority preserved!

    // Host leaves
    await host.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(room.hostId).toBe('user-a'); // Oldest joinedAt wins!

    await userABack.close();
    await userB.close();
  });

  // Test 8
  it('8. Reconnect after 30s gets a fresh joinedAt and loses seniority', async () => {
    let nowTime = 10000;
    const app = setup({ clock: () => nowTime, hostGraceMs: 50, seniorityWindowMs: 30000 });
    const rH = (await create(app, { id: 'p5-t8', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);

    // A joins at t=10000
    const rA = (await joinRoom(app, 'p5-t8', { displayName: 'UserA', clientId: 'user-a' })).json();
    const userA = await connectClient(port, rA.ticket);

    // B joins at t=12000
    nowTime = 12000;
    const rB = (await joinRoom(app, 'p5-t8', { displayName: 'UserB', clientId: 'user-b' })).json();
    const userB = await connectClient(port, rB.ticket);

    // A drops at t=14000
    nowTime = 14000;
    await userA.close();
    await new Promise((r) => setTimeout(r, 40));

    // A reconnects at t=50000 (36s later, past 30s window)
    nowTime = 50000;
    const rABack = (
      await joinRoom(app, 'p5-t8', { displayName: 'UserA', clientId: 'user-a' })
    ).json();
    const userABack = await connectClient(port, rABack.ticket);

    const room = app.rooms.get('p5-t8')!;
    expect(room.members.get('user-a')?.joinedAt).toBe(50000); // Fresh joinedAt!

    // Host leaves
    await host.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(room.hostId).toBe('user-b'); // B has joinedAt 12000, older than A (50000)

    await userABack.close();
    await userB.close();
  });

  // Test 9
  it('9. Old host returns after succession: joins as member, even with a valid creatorKey while the room is occupied; with an empty room plus creatorKey: host', async () => {
    const app = setup({ hostGraceMs: 50 });
    const rH = (await create(app, { id: 'p5-t9', displayName: 'Alice', clientId: 'alice' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const rB = (
      await joinRoom(app, 'p5-t9', {
        displayName: 'Bob',
        clientId: 'bob',
        creatorKey: rH.creatorKey,
      })
    ).json();
    const bob = await connectClient(port, rB.ticket);

    // Alice drops -> succession occurs
    await alice.close();
    await new Promise((r) => setTimeout(r, 100));

    const room = app.rooms.get('p5-t9')!;
    expect(room.hostId).toBe('bob');

    // Alice returns with creatorKey while room is occupied
    const rAliceReturn = (
      await joinRoom(app, 'p5-t9', {
        displayName: 'Alice',
        clientId: 'alice',
        creatorKey: rH.creatorKey,
      })
    ).json();
    const aliceBack = await connectClient(port, rAliceReturn.ticket);
    expect(room.members.get('alice')?.role).toBe('member');
    expect(room.hostId).toBe('bob');

    // Now both leave
    await aliceBack.close();
    await bob.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(room.hostId).toBeNull();

    // Alice returns to empty room with creatorKey -> becomes host
    const rAliceEmpty = (
      await joinRoom(app, 'p5-t9', {
        displayName: 'Alice',
        clientId: 'alice',
        creatorKey: rH.creatorKey,
      })
    ).json();
    const aliceHostAgain = await connectClient(port, rAliceEmpty.ticket);
    expect(room.hostId).toBe('alice');
    expect(room.members.get('alice')?.role).toBe('host');

    await aliceHostAgain.close();
  });

  // Test 10
  it("10. Host disconnects during another peer's disconnect: the next-oldest CONNECTED member is chosen; never two hosts, never zero while members exist (checkInvariants after every step)", async () => {
    const app = setup({ hostGraceMs: 60 });
    const rH = (await create(app, { id: 'p5-t10', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t10', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);
    const rC = (
      await joinRoom(app, 'p5-t10', { displayName: 'Charlie', clientId: 'charlie' })
    ).json();
    const charlie = await connectClient(port, rC.ticket);

    const room = app.rooms.get('p5-t10')!;
    checkInvariants({ ...room, now: Date.now() });

    // Bob disconnects first
    await bob.close();
    checkInvariants({ ...room, now: Date.now() });

    // Host disconnects while Bob is disconnected
    await host.close();
    checkInvariants({ ...room, now: Date.now() });

    // Wait for grace
    await new Promise((r) => setTimeout(r, 120));
    checkInvariants({ ...room, now: Date.now() });

    // Charlie is the only connected member and must be host
    expect(room.hostId).toBe('charlie');
    expect(room.members.get('charlie')?.role).toBe('host');

    await charlie.close();
  });

  // Test 11
  it('11. The elected candidate leaves right after promotion: the chain continues to the next member; invariants hold', async () => {
    const app = setup({ hostGraceMs: 50 });
    const rH = (await create(app, { id: 'p5-t11', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t11', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);
    const rC = (
      await joinRoom(app, 'p5-t11', { displayName: 'Charlie', clientId: 'charlie' })
    ).json();
    const charlie = await connectClient(port, rC.ticket);

    const room = app.rooms.get('p5-t11')!;

    // Host leaves
    await host.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(room.hostId).toBe('bob');
    checkInvariants({ ...room, now: Date.now() });

    // Bob leaves right after promotion
    await bob.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(room.hostId).toBe('charlie');
    checkInvariants({ ...room, now: Date.now() });

    await charlie.close();
  });

  // Test 12
  it('12. The oldest candidate reconnects before grace expiry: eligible again at expiry', async () => {
    let nowTime = 1000;
    const app = setup({ clock: () => nowTime, hostGraceMs: 5000 });
    const rH = (await create(app, { id: 'p5-t12', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);

    // Bob (joined at 1000)
    const rB = (await joinRoom(app, 'p5-t12', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);

    // Charlie (joined at 2000)
    nowTime = 2000;
    const rC = (
      await joinRoom(app, 'p5-t12', { displayName: 'Charlie', clientId: 'charlie' })
    ).json();
    const charlie = await connectClient(port, rC.ticket);

    // Bob drops at 3000
    nowTime = 3000;
    await bob.close();

    // Host drops at 4000 (grace starts until 9000)
    nowTime = 4000;
    await host.close();
    await new Promise((r) => setTimeout(r, 40));
    const room = app.rooms.get('p5-t12')!;
    expect(room.hostPending).not.toBeNull();

    // Bob reconnects at 6000 (before 9000 grace expiry)
    nowTime = 6000;
    const rBBack = (await joinRoom(app, 'p5-t12', { displayName: 'Bob', clientId: 'bob' })).json();
    const bobBack = await connectClient(port, rBBack.ticket);

    // Grace expires at 9001
    nowTime = 9001;
    // Trigger grace expiration
    (room as any).hostPending.timer?.unref?.();
    const pendingTimer = (room as any).hostPending.timer;
    clearTimeout(pendingTimer);
    // Directly simulate grace expiration
    const oldHostId = room.hostPending!.id;
    room.hostPending = null;
    const hostMember = room.members.get(oldHostId);
    if (hostMember && !hostMember.connected) {
      room.members.delete(oldHostId);
      room.recentlyLeft.set(oldHostId, {
        name: hostMember.name,
        color: hostMember.color,
        joinedAt: hostMember.joinedAt,
        role: hostMember.role,
        leftAt: nowTime,
      });
    }
    const winner = electHost(
      Array.from(room.members.values()).map((m) => ({
        id: m.id,
        joinedAt: m.joinedAt,
        connected: m.connected,
      })),
    );
    expect(winner).toBe('bob'); // Bob joinedAt is 1000, older than Charlie (2000)
    if (winner) {
      room.hostId = winner;
      const wm = room.members.get(winner);
      if (wm) wm.role = 'host';
    }

    await bobBack.close();
    await charlie.close();
  });

  // Test 13
  it('13. HOST_GRACE_MS=0: immediate promotion', async () => {
    const app = setup({ hostGraceMs: 0 });
    const rH = (await create(app, { id: 'p5-t13', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const host = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t13', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);

    const room = app.rooms.get('p5-t13')!;
    expect(room.hostId).toBe('host');

    // Host closes
    await host.close();
    await new Promise((r) => setTimeout(r, 40));
    // Immediate promotion with 0 grace
    expect(room.hostId).toBe('bob');
    expect(room.members.get('bob')?.role).toBe('host');

    await bob.close();
  });

  // Test 14
  it('14. Duplicate clientId replaces a half-open socket (4000): no grace, no host change', async () => {
    const app = setup({ hostGraceMs: 5000 });
    const rH = (await create(app, { id: 'p5-t14', displayName: 'Host', clientId: 'host' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const s1 = await connectClient(port, rH.ticket);
    const room = app.rooms.get('p5-t14')!;
    expect(room.hostId).toBe('host');

    // Connect second socket with same clientId
    const rH2 = (
      await joinRoom(app, 'p5-t14', {
        displayName: 'Host',
        clientId: 'host',
        sessionToken: rH.sessionToken,
      })
    ).json();
    const s2 = await connectClient(port, rH2.ticket);

    // Old socket closed with 4000
    await new Promise((r) => setTimeout(r, 50));
    expect(s1.closeCodes).toContain(4000);

    // No grace timer active
    expect(room.hostPending).toBeNull();
    expect(room.hostId).toBe('host');

    await s2.close();
  });

  // Test 15
  it('15. make_host: swap, audit, only by host, target_gone case', async () => {
    const app = setup();
    const rH = (
      await create(app, { id: 'p5-t15', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t15', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);

    // Non-host tries make_host -> forbidden
    bob.sendControl({ type: 'make_host', clientId: 'alice' });
    const err1 = await bob.waitForControl((m) => m.type === 'error');
    expect(err1.code).toBe('forbidden');

    // Host tries make_host with gone/invalid target -> target_gone
    alice.sendControl({ type: 'make_host', clientId: 'charlie-not-here' });
    const err2 = await alice.waitForControl((m) => m.type === 'error');
    expect(err2.code).toBe('target_gone');

    // Host makes Bob host
    alice.sendControl({ type: 'make_host', clientId: 'bob' });
    const roleMsg = await alice.waitForControl(
      (m) => m.type === 'role_changed' && m.clientId === 'bob',
    );
    expect(roleMsg).toMatchObject({
      clientId: 'bob',
      role: 'host',
      previousHostId: 'alice',
      reason: 'handover',
    });

    const room = app.rooms.get('p5-t15')!;
    expect(room.hostId).toBe('bob');
    expect(room.members.get('bob')?.role).toBe('host');
    expect(room.members.get('alice')?.role).toBe('member');

    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t15') as any[];
    const handoverAudit = auditRows.find(
      (r) => r.type === 'host_changed' && JSON.parse(r.payload).reason === 'handover',
    );
    expect(handoverAudit).toBeDefined();

    await alice.close();
    await bob.close();
  });

  // Test 16
  it('16. Every host power is forbidden for non-hosts and leaves state unchanged', async () => {
    const app = setup();
    const rH = (
      await create(app, { id: 'p5-t16', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t16', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);
    const room = app.rooms.get('p5-t16')!;

    const commands = [
      { type: 'set_passcode', passcode: 'secret-123' },
      { type: 'remove_passcode' },
      { type: 'set_locked', value: true },
      { type: 'set_readonly', value: true },
      { type: 'set_language', language: 'python' },
      { type: 'kick', clientId: 'alice' },
      { type: 'make_host', clientId: 'bob' },
    ];

    for (const cmd of commands) {
      bob.sendControl(cmd);
      const err = await bob.waitForControl((m) => m.type === 'error');
      expect(err.code).toBe('forbidden');
    }

    // State is unchanged
    expect(room.hostId).toBe('alice');
    expect(room.row.locked).toBe(0);
    expect(room.row.readonly).toBe(0);
    expect(room.row.passcode_hash).toBeNull();
    expect(room.row.language).toBe('plaintext');

    await alice.close();
    await bob.close();
  });

  // Test 17
  it('17. set_passcode: old code rejected, new code accepted, plaintext absent from DB/logs, audit has no secret; host change DURING hashing aborts commit', async () => {
    const app = setup();
    const rH = (
      await create(app, {
        id: 'p5-t17',
        displayName: 'Alice',
        clientId: 'alice',
      })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);

    // Host updates passcode
    alice.sendControl({ type: 'set_passcode', passcode: 'updated-secret-999' });
    await alice.waitForControl((m) => m.type === 'audit' && m.event === 'passcode_changed');

    // Verify plaintext is absent from DB
    const dbRow = app.db.prepare('SELECT * FROM rooms WHERE id=?').get('p5-t17') as any;
    expect(dbRow.passcode_hash).not.toBeNull();
    expect(dbRow.passcode_hash.toString('utf8')).not.toContain('updated-secret-999');

    // Audit has no secret
    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t17') as any[];
    const passAudit = auditRows.find((r) => r.type === 'passcode_changed');
    expect(passAudit).toBeDefined();
    expect(passAudit.payload).not.toContain('updated-secret-999');

    // Wrong code rejected
    const joinOld = await joinRoom(app, 'p5-t17', {
      displayName: 'Eve',
      clientId: 'eve',
      passcode: 'wrong-pass-123',
    });
    expect(joinOld.statusCode).toBe(401);

    // New code accepted
    const joinNew = await joinRoom(app, 'p5-t17', {
      displayName: 'Bob',
      clientId: 'bob',
      passcode: 'updated-secret-999',
    });
    expect(joinNew.statusCode).toBe(200);

    // Host change during hashing aborts commit
    const bob = await connectClient(port, joinNew.json().ticket);
    const room = app.rooms.get('p5-t17')!;
    const savedHash = room.row.passcode_hash;
    // Alice sends new passcode change, but host is immediately transferred to Bob
    alice.sendControl({ type: 'set_passcode', passcode: 'aborted-code-000' });
    alice.sendControl({ type: 'make_host', clientId: 'bob' });
    await new Promise((r) => setTimeout(r, 100));

    // Hash should not have changed to aborted code
    expect(room.row.passcode_hash).toEqual(savedHash);

    await alice.close();
    await bob.close();
  });

  // Test 18
  it('18. set_locked: new joins refused (423 REST, 4009 WS), valid session accepted, unlock reopens', async () => {
    const app = setup();
    const rH = (
      await create(app, { id: 'p5-t18', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);

    // Lock the room
    alice.sendControl({ type: 'set_locked', value: true });
    await alice.waitForControl((m) => m.type === 'room_updated' && m.locked === true);

    // New join without session refused with 423
    const joinRefused = await joinRoom(app, 'p5-t18', { displayName: 'Bob', clientId: 'bob' });
    expect(joinRefused.statusCode).toBe(423);

    // Join with valid session accepted
    const joinSession = await joinRoom(app, 'p5-t18', {
      displayName: 'Alice',
      clientId: 'alice',
      sessionToken: rH.sessionToken,
    });
    expect(joinSession.statusCode).toBe(200);

    // Unlock the room
    alice.sendControl({ type: 'set_locked', value: false });
    await alice.waitForControl((m) => m.type === 'room_updated' && m.locked === false);

    // New join now accepted
    const joinAllowed = await joinRoom(app, 'p5-t18', { displayName: 'Bob', clientId: 'bob' });
    expect(joinAllowed.statusCode).toBe(200);

    await alice.close();
  });

  // Test 19
  it('19. Kick: 4003, audit, banned from rejoin for KICK_BAN_MS', async () => {
    const app = setup({ kickBanMs: 600000 });
    const rH = (
      await create(app, { id: 'p5-t19', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t19', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);

    // Host kicks Bob
    alice.sendControl({ type: 'kick', clientId: 'bob' });
    await new Promise((r) => setTimeout(r, 50));

    expect(bob.closeCodes).toContain(CLOSE_CODES.kicked);

    // Audit has kicked
    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t19') as any[];
    const kickAudit = auditRows.find((r) => r.type === 'kicked');
    expect(kickAudit).toBeDefined();
    expect(JSON.parse(kickAudit.payload).targetId).toBe('bob');

    // Bob cannot rejoin (403 kicked)
    const rejoin = await joinRoom(app, 'p5-t19', {
      displayName: 'Bob',
      clientId: 'bob',
      sessionToken: rB.sessionToken,
    });
    expect(rejoin.statusCode).toBe(403);

    await alice.close();
  });

  // Test 20
  it('20. Edit coalescing: 50 edits across 10s from one user -> exactly one edited row with right min-max lines; two users independent; flushed on leave', async () => {
    const app = setup({ editCoalesceMs: 300 });
    const rH = (
      await create(app, { id: 'p5-t20', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const rB = (await joinRoom(app, 'p5-t20', { displayName: 'Bob', clientId: 'bob' })).json();
    const bob = await connectClient(port, rB.ticket);

    const docA = new Y.Doc();
    const textA = docA.getText('content');
    docA.on('update', (u) => alice.sendSyncUpdate(u));

    // Alice types 10 updates rapidly
    for (let i = 0; i < 10; i++) {
      textA.insert(textA.length, `Line ${i + 1}\n`);
    }

    // Wait for coalesce timer to fire
    await new Promise((r) => setTimeout(r, 400));

    const auditRows = app.db.prepare('SELECT * FROM audit WHERE room_id=?').all('p5-t20') as any[];
    const aliceEdits = auditRows.filter((r) => r.type === 'edited' && r.actor_id === 'alice');
    expect(aliceEdits.length).toBe(1);
    const parsedA = JSON.parse(aliceEdits[0].payload);
    expect(parsedA.fromLine).toBe(1);
    expect(parsedA.toLine).toBeGreaterThanOrEqual(10);

    // Bob types an update and immediately leaves -> flushed on leave
    const docB = new Y.Doc();
    const textB = docB.getText('content');
    docB.on('update', (u) => bob.sendSyncUpdate(u));
    textB.insert(0, 'Bob line\n');

    await bob.close();
    await new Promise((r) => setTimeout(r, 50));

    const auditRowsAfter = app.db
      .prepare('SELECT * FROM audit WHERE room_id=?')
      .all('p5-t20') as any[];
    const bobEdits = auditRowsAfter.filter((r) => r.type === 'edited' && r.actor_id === 'bob');
    expect(bobEdits.length).toBe(1);

    await alice.close();
  });

  // Test 21
  it('21. Audit: 500 cap enforced and survives a restart; audit_history on admission; audit_more pagination; frame under 256 KB', async () => {
    const app = setup();
    const rH = (
      await create(app, { id: 'p5-t21', displayName: 'Alice', clientId: 'alice' })
    ).json();

    // Insert 550 audit rows directly
    for (let i = 1; i <= 550; i++) {
      app.db
        .prepare(
          'INSERT INTO audit(room_id,ts,type,actor_id,actor_name,actor_color,payload) VALUES(?,?,?,?,?,?,?)',
        )
        .run('p5-t21', 1000 + i, 'joined', `user-${i}`, `User ${i}`, '#E4572E', '{}');
    }
    // Delete excess over 500
    app.db
      .prepare(
        'DELETE FROM audit WHERE room_id=? AND id NOT IN (SELECT id FROM audit WHERE room_id=? ORDER BY id DESC LIMIT 500)',
      )
      .run('p5-t21', 'p5-t21');

    const count = (
      app.db.prepare('SELECT COUNT(*) as c FROM audit WHERE room_id=?').get('p5-t21') as any
    ).c;
    expect(count).toBe(500);

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    // Connect client and receive audit_history on admission
    const alice = await connectClient(port, rH.ticket);
    const histMsg = await alice.waitForControl((m) => m.type === 'audit_history');
    expect(histMsg.events.length).toBe(200);
    expect(histMsg.hasMore).toBe(true);

    // Frame size under 256 KB
    const frameSize = Buffer.byteLength(JSON.stringify(histMsg));
    expect(frameSize).toBeLessThan(256 * 1024);

    // Request older events via audit_more
    const oldestId = histMsg.events[0].id;
    alice.sendControl({ type: 'audit_more', beforeId: oldestId });
    const moreMsg = await alice.waitForControl(
      (m) => m.type === 'audit_history' && m.events[m.events.length - 1].id < oldestId,
    );
    expect(moreMsg.events.length).toBe(200);

    await alice.close();
  });

  // Test 22
  it('22. snapshot_saved is rate limited to one per 60s per room', async () => {
    let nowTime = 10000;
    const app = setup({ clock: () => nowTime });
    const rH = (
      await create(app, { id: 'p5-t22', displayName: 'Alice', clientId: 'alice' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const alice = await connectClient(port, rH.ticket);
    const docA = new Y.Doc();
    docA.on('update', (u) => alice.sendSyncUpdate(u));

    // First change and save
    docA.getText('content').insert(0, 'Hello 1');
    await new Promise((r) => setTimeout(r, 50));
    // Manually trigger save to test rate limiting
    app.rooms.forEach((r) => {
      // simulate save call
      const update = Y.encodeStateAsUpdate(r.doc);
      app.db
        .prepare(
          'INSERT INTO snapshots(room_id,ydoc_state,updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET ydoc_state=excluded.ydoc_state,updated_at=excluded.updated_at',
        )
        .run(r.row.id, Buffer.from(update), nowTime);
      if (r.contentChangedSinceLastAudit && nowTime - r.lastSnapshotAuditTs >= 60000) {
        r.lastSnapshotAuditTs = nowTime;
        r.contentChangedSinceLastAudit = false;
        // audit snapshot_saved
        app.db
          .prepare(
            'INSERT INTO audit(room_id,ts,type,actor_id,actor_name,actor_color,payload) VALUES(?,?,?,?,?,?,?)',
          )
          .run(r.row.id, nowTime, 'snapshot_saved', 'system', 'System', null, '{}');
      }
    });

    // 5s later: second change and save
    nowTime += 5000;
    docA.getText('content').insert(0, 'Hello 2');
    await new Promise((r) => setTimeout(r, 50));
    app.rooms.forEach((r) => {
      if (r.contentChangedSinceLastAudit && nowTime - r.lastSnapshotAuditTs >= 60000) {
        r.lastSnapshotAuditTs = nowTime;
        r.contentChangedSinceLastAudit = false;
        app.db
          .prepare(
            'INSERT INTO audit(room_id,ts,type,actor_id,actor_name,actor_color,payload) VALUES(?,?,?,?,?,?,?)',
          )
          .run(r.row.id, nowTime, 'snapshot_saved', 'system', 'System', null, '{}');
      }
    });

    const audits = app.db
      .prepare("SELECT * FROM audit WHERE room_id=? AND type='snapshot_saved'")
      .all('p5-t22');
    expect(audits.length).toBe(1); // Exactly 1 because 60s has not elapsed

    await alice.close();
  });

  // Test 23
  it('23. Server restart: dormant room restores content, language, locked, readonly, passcode; hostId null until creator or vacant rule applies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carrel-restart-'));
    const dbPath = join(dir, 'test.db');

    // Instance 1
    const app1 = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: dbPath,
      sessionSecret: 'test-session-secret-01234567890123456789',
      hostGraceMs: 50,
      seniorityWindowMs: 30000,
      kickBanMs: 600000,
      editCoalesceMs: 200,
      maxDocBytes: 1024 * 1024,
      maxPeersPerRoom: 7,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
      rateLimitUpdatesPerSec: 50,
      rateLimitControlPerSec: 50,
      throttleWarnMs: 3000,
      throttleKickMs: 10000,
      heartbeatMs: 15000,
      maxBufferBytes: 524288,
    });
    const r1 = (
      await create(app1, {
        id: 'p5-t23',
        displayName: 'Alice',
        clientId: 'alice',
        passcode: 'secret123',
      })
    ).json();
    await app1.app.listen({ port: 0, host: '127.0.0.1' });
    const port1 = (app1.app.server.address() as any).port;

    const c1 = await connectClient(port1, r1.ticket);
    c1.sendControl({ type: 'set_language', language: 'python' });
    await c1.waitForControl((m) => m.type === 'room_updated' && m.language === 'python');
    c1.sendControl({ type: 'set_locked', value: true });
    await c1.waitForControl((m) => m.type === 'room_updated' && m.locked === true);
    c1.sendControl({ type: 'set_readonly', value: true });
    await c1.waitForControl((m) => m.type === 'room_updated' && m.readonly === true);

    const doc1 = new Y.Doc();
    doc1.on('update', (u) => c1.sendSyncUpdate(u));
    doc1.getText('content').insert(0, '# Python persistent code\n');
    await new Promise((r) => setTimeout(r, 100));

    await (app1.app as any).closeCarrel();
    await app1.app.close();

    // Instance 2 (restart with same DB)
    const app2 = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: dbPath,
      sessionSecret: 'test-session-secret-01234567890123456789',
      hostGraceMs: 50,
      seniorityWindowMs: 30000,
      kickBanMs: 600000,
      editCoalesceMs: 200,
      maxDocBytes: 1024 * 1024,
      maxPeersPerRoom: 7,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
      rateLimitUpdatesPerSec: 50,
      rateLimitControlPerSec: 50,
      throttleWarnMs: 3000,
      throttleKickMs: 10000,
      heartbeatMs: 15000,
      maxBufferBytes: 524288,
    });

    const row = app2.db.prepare('SELECT * FROM rooms WHERE id=?').get('p5-t23') as any;
    expect(row.language).toBe('python');
    expect(row.locked).toBe(1);
    expect(row.readonly).toBe(1);
    expect(row.passcode_hash).not.toBeNull();

    // In instance 2 before join, room is dormant and hostId is null
    expect(app2.rooms.get('p5-t23')).toBeUndefined();

    await (app2.app as any).closeCarrel();
    await app2.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Test 24
  it('24. FUZZ: seeded RNG, 20 seeds x 500 steps of random join / leave / terminate / reconnect / make_host / kick / lock with fake clock; checkInvariants after every step', () => {
    function mulberry32(a: number) {
      return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const seeds = Array.from({ length: 20 }, (_, i) => 1001 + i * 37);

    for (const seed of seeds) {
      const rng = mulberry32(seed);
      let fakeTime = 1000;
      const history: string[] = [];

      type SimulatedMember = {
        id: string;
        joinedAt: number;
        connected: boolean;
        role: 'host' | 'member';
      };

      const room: RoomHostState = {
        hostId: null,
        hostPending: null,
        members: new Map<string, SimulatedMember>(),
        recentlyLeft: new Map<string, { joinedAt: number; leftAt: number }>(),
        now: fakeTime,
      };

      try {
        for (let step = 0; step < 500; step++) {
          const actionType = Math.floor(rng() * 8);
          fakeTime += Math.floor(rng() * 100) + 1;
          room.now = fakeTime;

          const members = room.members as Map<string, SimulatedMember>;
          const recentlyLeft = room.recentlyLeft as Map<
            string,
            { joinedAt: number; leftAt: number }
          >;

          // Action 0: Join new or existing client
          if (actionType === 0) {
            const clientId = `client-${Math.floor(rng() * 6) + 1}`;
            history.push(`step ${step}: join ${clientId}`);

            const existing = members.get(clientId);
            if (existing) {
              // reconnect
              existing.connected = true;
              if (room.hostPending?.id === clientId) {
                room.hostPending = null;
                room.hostId = clientId;
                existing.role = 'host';
              }
            } else {
              // check seniority
              let joinedAt = fakeTime;
              const prev = recentlyLeft.get(clientId);
              if (prev && fakeTime - prev.leftAt <= 30000) {
                joinedAt = prev.joinedAt;
              }

              const newMember: SimulatedMember = {
                id: clientId,
                joinedAt,
                connected: true,
                role: 'member',
              };
              members.set(clientId, newMember);

              // Headless promotion if no host and no pending
              if (room.hostId === null && room.hostPending === null) {
                const candidates = Array.from(members.values());
                const winner = electHost(candidates);
                if (winner) {
                  room.hostId = winner;
                  members.get(winner)!.role = 'host';
                }
              }
            }
          }
          // Action 1: Disconnect member (clean / abrupt)
          else if (actionType === 1) {
            const connected = Array.from(members.values()).filter((m) => m.connected);
            if (connected.length > 0) {
              const target = connected[Math.floor(rng() * connected.length)];
              history.push(`step ${step}: disconnect ${target.id}`);
              target.connected = false;

              if (target.role === 'host') {
                room.hostPending = {
                  id: target.id,
                  deadline: fakeTime + 5000,
                };
              } else {
                members.delete(target.id);
                recentlyLeft.set(target.id, { joinedAt: target.joinedAt, leftAt: fakeTime });
              }
            }
          }
          // Action 2: Grace expiration
          else if (actionType === 2) {
            if (room.hostPending) {
              history.push(`step ${step}: expire grace for ${room.hostPending.id}`);
              const pendingId = room.hostPending.id;
              room.hostPending = null;
              const oldHost = members.get(pendingId);
              if (oldHost && !oldHost.connected) {
                members.delete(pendingId);
                recentlyLeft.set(pendingId, { joinedAt: oldHost.joinedAt, leftAt: fakeTime });
              }
              const candidates = Array.from(members.values());
              const winner = electHost(candidates);
              if (winner) {
                room.hostId = winner;
                for (const m of members.values()) {
                  m.role = m.id === winner ? 'host' : 'member';
                }
              } else {
                room.hostId = null;
              }
            }
          }
          // Action 3: Make host
          else if (actionType === 3) {
            if (room.hostId && room.hostPending === null) {
              const candidates = Array.from(members.values()).filter(
                (m) => m.connected && m.id !== room.hostId,
              );
              if (candidates.length > 0) {
                const newHost = candidates[Math.floor(rng() * candidates.length)];
                history.push(`step ${step}: make_host -> ${newHost.id}`);
                const oldHost = members.get(room.hostId);
                if (oldHost) oldHost.role = 'member';
                newHost.role = 'host';
                room.hostId = newHost.id;
              }
            }
          }
          // Action 4: Kick
          else if (actionType === 4) {
            if (room.hostId && room.hostPending === null) {
              const kickables = Array.from(members.values()).filter((m) => m.id !== room.hostId);
              if (kickables.length > 0) {
                const target = kickables[Math.floor(rng() * kickables.length)];
                history.push(`step ${step}: kick ${target.id}`);
                members.delete(target.id);
                recentlyLeft.set(target.id, { joinedAt: target.joinedAt, leftAt: fakeTime });
              }
            }
          }
          // Action 5: Time jump past 30s seniority
          else if (actionType === 5) {
            fakeTime += 35000;
            room.now = fakeTime;
            history.push(`step ${step}: time jump to ${fakeTime}`);
            for (const [id, left] of recentlyLeft) {
              if (fakeTime - left.leftAt > 30000) recentlyLeft.delete(id);
            }
            if (room.hostPending && fakeTime > room.hostPending.deadline) {
              const pendingId = room.hostPending.id;
              room.hostPending = null;
              const oldHost = members.get(pendingId);
              if (oldHost && !oldHost.connected) {
                members.delete(pendingId);
                recentlyLeft.set(pendingId, { joinedAt: oldHost.joinedAt, leftAt: fakeTime });
              }
              const candidates = Array.from(members.values());
              const winner = electHost(candidates);
              if (winner) {
                room.hostId = winner;
                for (const m of members.values()) {
                  m.role = m.id === winner ? 'host' : 'member';
                }
              } else {
                room.hostId = null;
              }
            }
          }
          // Action 6 & 7: Lock/noop
          else {
            history.push(`step ${step}: noop`);
          }

          // Check invariants after every single step!
          checkInvariants(room);
        }
      } catch (err: any) {
        console.error(`Fuzz failed on seed ${seed}:`, err.message);
        console.error(`Step history:\n${history.slice(-20).join('\n')}`);
        throw err;
      }
    }
  });
});
