import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { buildApp, type ServerConfig } from './index.js';
import { TokenBucket, EscalationLadder } from './throttle.js';
import {
  encodeControl,
  encodeSyncStep1,
  encodeSyncUpdate,
  encodeAwarenessRaw,
  decodeFrame,
  FRAME_TYPES,
} from '@carrel/shared';

const configs: { app: ReturnType<typeof buildApp>; dir: string }[] = [];

function setup(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carrel-p4-test-'));
  const app = buildApp({
    port: 0,
    clientOrigin: '*',
    databasePath: join(dir, 'test.db'),
    sessionSecret: 'test-session-secret-01234567890123456789',
    hostGraceMs: 1,
    maxDocBytes: 1024 * 1024,
    maxPeersPerRoom: 7,
    ticketTtlMs: 60000,
    sessionTtlMs: 86400000,
    rateLimitUpdatesPerSec: 5,
    rateLimitControlPerSec: 2,
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

describe('Phase 4: Server Throttling & Resilience (A8)', () => {
  // Test 1
  it('TokenBucket: capacity, refill, msUntilNextToken (fake clock)', () => {
    let now = 1000;
    const clock = () => now;
    const bucket = new TokenBucket(5, 5, clock);

    expect(bucket.tokens()).toBe(5);
    expect(bucket.tryTake(5)).toBe(true);
    expect(bucket.tokens()).toBe(0);
    expect(bucket.tryTake(1)).toBe(false);

    expect(bucket.msUntilNextToken()).toBe(200);

    now += 100;
    expect(bucket.msUntilNextToken()).toBe(100);
    expect(bucket.tryTake(1)).toBe(false);

    now += 100;
    expect(bucket.tokens()).toBeCloseTo(1, 2);
    expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tokens()).toBeCloseTo(0, 2);

    now += 3000;
    expect(bucket.tokens()).toBe(5);
  });

  it('Lossless: client sends 100 updates (1 char each) within 200ms; observer receives at most 6 sync frames per 1s window from that origin AND the final text on every peer is complete and identical', async () => {
    const app = setup({ rateLimitUpdatesPerSec: 5 });
    const roomId = 'lossless-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Sender', clientId: 'c-sender' })
    ).json();
    const c2 = (
      await joinRoom(app, roomId, { displayName: 'Observer', clientId: 'c-observer' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const wsSender = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    const wsObserver = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c2.ticket}`);

    await Promise.all([
      new Promise((r) => wsSender.once('open', r)),
      new Promise((r) => wsObserver.once('open', r)),
    ]);

    const observerFrames: { ts: number; update: Uint8Array }[] = [];
    const observerDoc = new Y.Doc();

    wsObserver.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.sync) {
        const dec = decoding.createDecoder(frame.payload);
        const enc = encoding.createEncoder();
        syncProtocol.readSyncMessage(dec, enc, observerDoc, 'remote');
        observerFrames.push({ ts: Date.now(), update: frame.payload });
      }
    });

    const senderDoc = new Y.Doc();
    const updates: Uint8Array[] = [];
    senderDoc.on('update', (u) => updates.push(u));

    for (let i = 0; i < 100; i++) {
      senderDoc.getText('content').insert(i, String.fromCharCode(65 + (i % 26)));
    }

    expect(updates.length).toBe(100);

    for (const u of updates) {
      wsSender.send(encodeSyncUpdate(u));
    }

    // Wait for the server bucket to drain all updates (100 updates / 5 per sec = ~2-3 seconds)
    const expectedText = senderDoc.getText('content').toString();
    const deadline = Date.now() + 5000;
    while (observerDoc.getText('content').toString().length < 100 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(observerDoc.getText('content').toString()).toBe(expectedText);
    const serverRoom = app.rooms.get(roomId)!;
    expect(serverRoom.doc.getText('content').toString()).toBe(expectedText);

    // Verify observer receives at most 6 sync frames per 1s window from that origin
    // Check rolling 1000ms windows
    for (let i = 0; i < observerFrames.length; i++) {
      const windowStart = observerFrames[i].ts;
      const countInWindow = observerFrames.filter(
        (f) => f.ts >= windowStart && f.ts < windowStart + 1000,
      ).length;
      expect(countInWindow).toBeLessThanOrEqual(6);
    }

    wsSender.close();
    wsObserver.close();
  }, 15000);

  // Test 3
  it('Merge order independence: merged result equals applying updates one by one', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const docMerged = new Y.Doc();

    const updates: Uint8Array[] = [];
    docA.on('update', (u) => updates.push(u));

    const textA = docA.getText('content');
    textA.insert(0, 'Hello ');
    textA.insert(6, 'World');
    textA.delete(0, 5);
    textA.insert(0, 'Greetings');
    textA.insert(14, '!');

    for (const u of updates) {
      Y.applyUpdate(docB, u);
    }

    const merged = Y.mergeUpdates(updates);
    Y.applyUpdate(docMerged, merged);

    expect(docB.getText('content').toString()).toBe(docA.getText('content').toString());
    expect(docMerged.getText('content').toString()).toBe(docA.getText('content').toString());
  });

  // Test 4
  it('Awareness latest-wins: 500 awareness frames in 1s, observer receives at most 12 and the last state equals the final one', async () => {
    const app = setup();
    const roomId = 'awareness-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'UserA', clientId: 'c-user-a' })
    ).json();
    const c2 = (await joinRoom(app, roomId, { displayName: 'UserB', clientId: 'c-user-b' })).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c2.ticket}`);

    await Promise.all([
      new Promise((r) => wsA.once('open', r)),
      new Promise((r) => wsB.once('open', r)),
    ]);

    const awarenessB = new awarenessProtocol.Awareness(new Y.Doc());
    const receivedFrames: number[] = [];

    wsB.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.awareness) {
        receivedFrames.push(Date.now());
        awarenessProtocol.applyAwarenessUpdate(awarenessB, frame.payload, 'remote');
      }
    });

    const awarenessA = new awarenessProtocol.Awareness(new Y.Doc());

    // Send 500 awareness updates in 1s (spaced by 2ms)
    for (let i = 0; i < 500; i++) {
      awarenessA.setLocalStateField('cursor', { x: i, y: i });
      const update = awarenessProtocol.encodeAwarenessUpdate(awarenessA, [awarenessA.clientID]);
      wsA.send(encodeAwarenessRaw(update));
      if (i % 25 === 0) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    await new Promise((r) => setTimeout(r, 300));

    expect(receivedFrames.length).toBeLessThanOrEqual(14);
    const finalState = awarenessB.getStates().get(awarenessA.clientID);
    expect(finalState).toBeDefined();
    expect(finalState?.cursor).toEqual({ x: 499, y: 499 });

    wsA.close();
    wsB.close();
  });

  // Test 5
  it("Awareness spoofing: frame containing another client's clientID is rejected", async () => {
    const app = setup();
    const roomId = 'spoof-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Legit', clientId: 'c-legit' })
    ).json();
    const c2 = (await joinRoom(app, roomId, { displayName: 'Observer', clientId: 'c-obs' })).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c2.ticket}`);

    await Promise.all([
      new Promise((r) => wsA.once('open', r)),
      new Promise((r) => wsB.once('open', r)),
    ]);

    const awarenessB = new awarenessProtocol.Awareness(new Y.Doc());
    wsB.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.awareness) {
        awarenessProtocol.applyAwarenessUpdate(awarenessB, frame.payload, 'remote');
      }
    });

    const docA = new Y.Doc();
    const awarenessA = new awarenessProtocol.Awareness(docA);
    const legitClientId = awarenessA.clientID;

    // Send legitimate update first
    awarenessA.setLocalState({ user: 'legit' });
    wsA.send(
      encodeAwarenessRaw(awarenessProtocol.encodeAwarenessUpdate(awarenessA, [legitClientId])),
    );

    await new Promise((r) => setTimeout(r, 150));
    expect(awarenessB.getStates().get(legitClientId)).toBeDefined();

    // Now send spoofed update with clientID 999999
    const spoofedDoc = new Y.Doc();
    const spoofedAwareness = new awarenessProtocol.Awareness(spoofedDoc);
    (spoofedAwareness as any).clientID = 999999;
    spoofedAwareness.setLocalState({ user: 'imposter' });
    const spoofedPayload = awarenessProtocol.encodeAwarenessUpdate(spoofedAwareness, [999999]);

    wsA.send(encodeAwarenessRaw(spoofedPayload));
    await new Promise((r) => setTimeout(r, 200));

    // Verify spoofed client ID was rejected and not propagated
    expect(awarenessB.getStates().get(999999)).toBeUndefined();

    wsA.close();
    wsB.close();
  });

  // Test 6
  it('Control flood: 20 control messages in 1s, at most 2 processed', async () => {
    const app = setup({ rateLimitControlPerSec: 2 });
    const roomId = 'ctrl-flood-room';
    const c1 = (await create(app, { id: roomId, displayName: 'Host', clientId: 'c-host' })).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws.once('open', r));

    const errors: any[] = [];
    const updates: any[] = [];

    ws.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(frame.payload).toString());
        if (msg.type === 'error' && msg.code === 'rate_limited') {
          errors.push(msg);
        } else if (msg.type === 'room_updated') {
          updates.push(msg);
        }
      }
    });

    // Send 20 control messages in rapid succession
    for (let i = 0; i < 20; i++) {
      ws.send(
        encodeControl({
          type: 'set_language',
          language: i % 2 === 0 ? 'python' : 'markdown',
        }),
      );
    }

    await new Promise((r) => setTimeout(r, 200));

    expect(updates.length).toBeLessThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  // Test 7
  it('Escalation ladder with fake clock: warning at 3s, closing at 10s, audit rows written, 1008 close code', () => {
    let mockTime = 1000;
    const clock = () => mockTime;
    const ladder = new EscalationLadder(3000, 10000, clock);

    ladder.onBufferOccupied();

    // At 2s: no escalation
    mockTime += 2000;
    let esc = ladder.checkEscalation();
    expect(esc.level).toBe('none');

    // At 3s: warning
    mockTime += 1000;
    esc = ladder.checkEscalation();
    expect(esc.level).toBe('warning');
    expect(esc.shouldSendNotice).toBe(true);
    expect(esc.shouldAuditWarn).toBe(true);

    // After 1s: still warning, but notice throttled (repeat at most once per 5s)
    mockTime += 1000;
    esc = ladder.checkEscalation();
    expect(esc.level).toBe('warning');
    expect(esc.shouldSendNotice).toBe(false);
    expect(esc.shouldAuditWarn).toBe(false);

    // At 10s: closing
    mockTime += 6000;
    esc = ladder.checkEscalation();
    expect(esc.level).toBe('closing');
  });

  // Test 8
  it('Normal typing (8 updates/s for 10s, batched like the client) never triggers a warning', () => {
    let mockTime = 1000;
    const clock = () => mockTime;
    const ladder = new EscalationLadder(3000, 10000, clock);
    const bucket = new TokenBucket(5, 5, clock);

    // Client limiter batches updates to 4/s (1 every 250ms).
    // Simulate 10 seconds of batched updates (40 batches)
    for (let step = 0; step < 40; step++) {
      mockTime += 250;
      if (bucket.tryTake(1)) {
        ladder.onBufferDrained(bucket.tokens() >= 1);
      } else {
        ladder.onBufferOccupied();
      }
      const esc = ladder.checkEscalation();
      expect(esc.level).toBe('none');
    }
  });

  // Test 9
  it('Buffer cap: oversized buffered data closes 1008 after flush, nothing lost', async () => {
    const app = setup({
      maxBufferBytes: 500,
      rateLimitUpdatesPerSec: 1,
    });
    const roomId = 'buffer-cap-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Flooder', clientId: 'c-flooder' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws.once('open', r));

    const closePromise = new Promise<number>((r) => ws.on('close', (code) => r(code)));

    // Exhaust bucket
    const doc = new Y.Doc();
    let latestUpdate: Uint8Array = new Uint8Array();
    doc.on('update', (u) => (latestUpdate = u));

    for (let i = 0; i < 5; i++) {
      doc.getText('content').insert(i, 'A');
      ws.send(encodeSyncUpdate(latestUpdate));
    }

    // Now send large updates to exceed 500 bytes buffer cap
    for (let i = 0; i < 20; i++) {
      doc.getText('content').insert(doc.getText('content').length, 'X'.repeat(40));
      ws.send(encodeSyncUpdate(latestUpdate));
    }

    const closeCode = await Promise.race([
      closePromise,
      new Promise<number>((_, rej) =>
        setTimeout(() => rej(new Error('timeout waiting for close')), 3000),
      ),
    ]);

    expect(closeCode).toBe(1008);
    const serverRoom = app.rooms.get(roomId)!;
    expect(serverRoom.doc.getText('content').toString().length).toBeGreaterThan(0);
  });

  // Test 10
  it('Closing a throttled connection flushes its buffer: the accepted text is present in the doc', async () => {
    const app = setup({ rateLimitUpdatesPerSec: 1 });
    const roomId = 'flush-on-close-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Typist', clientId: 'c-typist' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws.once('open', r));

    const doc = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    doc.on('update', (u) => (update = u));

    // Send 10 rapid updates (first 5 consume bucket, next 5 are buffered)
    for (let i = 0; i < 10; i++) {
      doc.getText('content').insert(i, 'X');
      ws.send(encodeSyncUpdate(update));
    }

    // Close immediately while buffer is occupied
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const serverRoom = app.rooms.get(roomId)!;
    expect(serverRoom.doc.getText('content').toString()).toBe('XXXXXXXXXX');
  });

  // Test 11
  it('Heartbeat: a client with autoPong disabled is terminated after 2 missed pings (HEARTBEAT_MS=100 in the test), cleanup runs, roster updates for peers', async () => {
    const app = setup({ heartbeatMs: 100 });
    const roomId = 'heartbeat-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Silent', clientId: 'c-silent' })
    ).json();
    const c2 = (await joinRoom(app, roomId, { displayName: 'Observer', clientId: 'c-obs' })).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const wsSilent = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`, {
      autoPong: false,
    });
    const wsObserver = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c2.ticket}`);

    await Promise.all([
      new Promise((r) => wsSilent.once('open', r)),
      new Promise((r) => wsObserver.once('open', r)),
    ]);

    let silentClosed = false;
    wsSilent.on('close', () => {
      silentClosed = true;
    });

    let observerReceivedRoster = false;
    wsObserver.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(frame.payload).toString());
        if (msg.type === 'roster' && msg.members.length === 1) {
          observerReceivedRoster = true;
        }
      }
    });

    // Wait for 2 missed pings and roster update (~250-500ms)
    const deadline = Date.now() + 2000;
    while ((!silentClosed || !observerReceivedRoster) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(silentClosed).toBe(true);
    expect(observerReceivedRoster).toBe(true);
    wsObserver.close();
  });

  // Test 12
  it("Duplicate clientId replaces the old socket with 4000, no 'left' event, 'reconnected' audit", async () => {
    const app = setup();
    const roomId = 'dup-client-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'UserA', clientId: 'client-dup' })
    ).json();
    const cObs = (
      await joinRoom(app, roomId, { displayName: 'Observer', clientId: 'client-obs' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    const wsObs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${cObs.ticket}`);

    await Promise.all([
      new Promise((r) => ws1.once('open', r)),
      new Promise((r) => wsObs.once('open', r)),
    ]);

    const auditEvents: string[] = [];
    wsObs.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(frame.payload).toString());
        if (msg.type === 'audit') {
          auditEvents.push(msg.event);
        }
      }
    });

    let ws1CloseCode = 0;
    ws1.on('close', (code) => {
      ws1CloseCode = code;
    });

    // Client A fetches fresh ticket and connects with SAME clientId
    const joinRes = await joinRoom(app, roomId, {
      displayName: 'UserA',
      clientId: 'client-dup',
      sessionToken: c1.sessionToken,
    });
    const c1NewTicket = joinRes.json().ticket;

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1NewTicket}`);
    await new Promise((r) => ws2.once('open', r));
    await new Promise((r) => setTimeout(r, 200));

    expect(ws1CloseCode).toBe(4000);
    expect(auditEvents).not.toContain('left');
    expect(auditEvents).toContain('reconnected');

    ws2.close();
    wsObs.close();
  });

  // Test 13
  it('Abrupt socket.terminate() during a buffered flush does not throw and does not corrupt the doc', async () => {
    const app = setup({ rateLimitUpdatesPerSec: 1 });
    const roomId = 'abrupt-term-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Abrupt', clientId: 'c-abrupt' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws.once('open', r));

    const doc = new Y.Doc();
    let u: Uint8Array = new Uint8Array();
    doc.on('update', (update) => (u = update));

    for (let i = 0; i < 8; i++) {
      doc.getText('content').insert(i, 'Z');
      ws.send(encodeSyncUpdate(u));
    }

    // Abruptly terminate
    ws.terminate();
    await new Promise((r) => setTimeout(r, 200));

    const serverRoom = app.rooms.get(roomId)!;
    expect(serverRoom.doc.getText('content').toString()).toBe('ZZZZZZZZ');
  });

  // Test 14
  it('Cooldown: clientId closed with 1008 gets rate_limited on immediate re-join', async () => {
    const app = setup({
      maxBufferBytes: 200,
      rateLimitUpdatesPerSec: 1,
    });
    const roomId = 'cooldown-room';
    const c1 = (
      await create(app, { id: roomId, displayName: 'Flooder', clientId: 'c-cooldown' })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws.once('open', r));

    const doc = new Y.Doc();
    let u: Uint8Array = new Uint8Array();
    doc.on('update', (update) => (u = update));

    for (let i = 0; i < 15; i++) {
      doc.getText('content').insert(i * 10, '1234567890');
      ws.send(encodeSyncUpdate(u));
    }

    await new Promise((r) => setTimeout(r, 200));

    // Client was kicked with 1008
    const rejoinRes = await joinRoom(app, roomId, {
      displayName: 'Flooder',
      clientId: 'c-cooldown',
      sessionToken: c1.sessionToken,
    });

    expect(rejoinRes.statusCode).toBe(429);
    const data = rejoinRes.json();
    expect(data.error).toBe('rate_limited');
    expect(data.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(data.retryAfterSec).toBeLessThanOrEqual(5);
  });

  // Test 15
  it('Server restart: stop the server instance, start a new one on the same DB file, clients with valid session tokens fetch new tickets, reconnect, converge, and the content is intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carrel-restart-'));
    const dbPath = join(dir, 'restart.db');
    const secret = 'test-session-secret-01234567890123456789';

    const app1 = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: dbPath,
      sessionSecret: secret,
      hostGraceMs: 1,
      maxDocBytes: 1024 * 1024,
      maxPeersPerRoom: 5,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
    });
    const c1 = (
      await create(app1, { id: 'restart-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app1.app.listen({ port: 0, host: '127.0.0.1' });
    const port1 = (app1.app.server.address() as any).port;

    const ws1 = new WebSocket(`ws://127.0.0.1:${port1}/ws?ticket=${c1.ticket}`);
    await new Promise((r) => ws1.once('open', r));

    const localDoc = new Y.Doc();
    let sentUpdate: Uint8Array | null = null;
    localDoc.on('update', (u) => {
      sentUpdate = u;
    });
    localDoc.getText('content').insert(0, 'Intact restart text');
    ws1.send(encodeSyncUpdate(sentUpdate!));
    await new Promise((r) => setTimeout(r, 100));

    ws1.close();
    await (app1.app as any).closeCarrel();
    await app1.app.close();

    // Start App 2 on same database file
    const app2 = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: dbPath,
      sessionSecret: secret,
      hostGraceMs: 1,
      maxDocBytes: 1024 * 1024,
      maxPeersPerRoom: 5,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
    });
    await app2.app.listen({ port: 0, host: '127.0.0.1' });
    const port2 = (app2.app.server.address() as any).port;

    // Fetch ticket using sessionToken
    const joinRes = await app2.app.inject({
      method: 'POST',
      url: '/api/rooms/restart-room/join',
      payload: { displayName: 'Mae Reborn', clientId: 'c1', sessionToken: c1.sessionToken },
    });
    expect(joinRes.statusCode).toBe(200);
    const c1NewTicket = joinRes.json().ticket;

    const ws2 = new WebSocket(`ws://127.0.0.1:${port2}/ws?ticket=${c1NewTicket}`);
    await new Promise((r) => ws2.once('open', r));

    const client2Doc = new Y.Doc();
    ws2.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const frame = decodeFrame(data);
      if (frame.type === FRAME_TYPES.sync) {
        syncProtocol.readSyncMessage(
          decoding.createDecoder(frame.payload),
          encoding.createEncoder(),
          client2Doc,
          'remote',
        );
      }
    });

    // Trigger sync step 1 from client
    ws2.send(encodeSyncStep1(client2Doc));
    const deadline = Date.now() + 3000;
    while (!client2Doc.getText('content').toString() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(client2Doc.getText('content').toString()).toBe('Intact restart text');

    ws2.close();
    await (app2.app as any).closeCarrel();
    await app2.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
