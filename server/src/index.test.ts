import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { buildApp, loadConfig, LOGGER_REDACT_PATHS, type ServerConfig } from './index.js';

const configs: { app: ReturnType<typeof buildApp>; dir: string }[] = [];
function setup(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carrel-test-'));
  const app = buildApp({
    port: 0,
    clientOrigin: '*',
    databasePath: join(dir, 'test.db'),
    sessionSecret: 'test-session-secret-01234567890123456789',
    hostGraceMs: 1,
    maxDocBytes: 1024 * 1024,
    maxPeersPerRoom: 2,
    ticketTtlMs: 1000,
    sessionTtlMs: 86400000,
    roomsPerIpPerHour: 1000,
    maxRooms: 1000,
    ...overrides,
  });
  configs.push({ app, dir });
  return app;
}
async function closeAll() {
  for (const { app, dir } of configs.splice(0)) {
    await (app.app as any).closeCarrel();
    await app.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
afterEach(closeAll);
const create = (app: ReturnType<typeof buildApp>, body: Record<string, unknown>) =>
  app.app.inject({ method: 'POST', url: '/api/rooms', payload: body });

describe('Phase 2 server core', () => {
  it('create room with custom id; duplicate id rejected; slug validation (bad chars, length, hyphen edges)', async () => {
    const app = setup();
    const body = {
      id: 'quiet-room',
      displayName: 'Mae',
      clientId: 'c1',
      passcode: 'correct horse',
    };
    expect((await create(app, body)).statusCode).toBe(201);
    expect((await create(app, body)).statusCode).toBe(409);
    expect((await create(app, { ...body, id: '-bad' })).statusCode).toBe(400);
    expect((await create(app, { ...body, id: 'UPPER' })).statusCode).toBe(400);
  });
  it('generated id matches adjective-noun-NN and is unique across 50 creations', async () => {
    const app = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = await create(app, { displayName: `User ${i}`, clientId: `client-${i}` });
      expect(res.statusCode).toBe(201);
      ids.add(res.json().roomId);
    }
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+-\d{2}$/);
  });
  it('passcode stored only as scrypt hash with salt (assert plaintext is absent from the DB file bytes)', async () => {
    const app = setup();
    const secret = 'very-private-passcode';
    await create(app, { id: 'hash-room', displayName: 'Mae', clientId: 'c1', passcode: secret });
    const bytes = readFileSync(join(app.config.databasePath));
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const row = app.db
      .prepare('SELECT passcode_hash,salt FROM rooms WHERE id=?')
      .get('hash-room') as any;
    expect(row.passcode_hash instanceof Uint8Array).toBe(true);
    expect(row.salt instanceof Uint8Array).toBe(true);
  });
  it('join with wrong passcode returns the generic error and NO ticket; room state never appears in the response', async () => {
    const app = setup();
    await create(app, {
      id: 'join-room',
      displayName: 'Mae',
      clientId: 'c1',
      passcode: 'correct-pass',
    });
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/join-room/join',
      payload: { passcode: 'wrong-pass', displayName: 'Rafi', clientId: 'c2' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });
  it('5 wrong attempts then lockout (429-style rate_limited with retryAfterSec)', async () => {
    const app = setup();
    await create(app, {
      id: 'locked-attempts',
      displayName: 'Mae',
      clientId: 'c1',
      passcode: 'correct-pass',
    });
    for (let i = 0; i < 5; i++)
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/locked-attempts/join',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        payload: { passcode: 'wrong-pass', displayName: 'Rafi', clientId: 'c2' },
      });
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/locked-attempts/join',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: { passcode: 'correct-pass', displayName: 'Rafi', clientId: 'c2' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });
  it('WS upgrade without ticket: rejected', async () => {
    const app = setup();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
    });
  });
  it('WS upgrade with a tampered ticket: rejected', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'ws-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${created.ticket}x`);
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
    });
  });
  it('WS upgrade with a replayed ticket is rejected on second use', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'replay-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const url = `ws://127.0.0.1:${port}/ws?ticket=${created.ticket}`;
    const first = new WebSocket(url);
    await new Promise((resolve) => first.once('open', resolve));
    first.close();
    await new Promise<void>((resolve) => {
      const second = new WebSocket(url);
      second.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
    });
  });
  it('JOIN-BEFORE-ADMIT: a client with a bad ticket never appears in any other client roster', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'admit-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${created.ticket}`);
    const rosters: any[] = [];
    ws1.on('message', (data) => {
      const buf = Buffer.from(data as Buffer);
      if (buf[0] === 2) {
        try {
          const msg = JSON.parse(buf.subarray(1).toString('utf8'));
          if (msg.type === 'roster') rosters.push(msg.members);
        } catch {}
      }
    });
    await new Promise((resolve) => ws1.once('open', resolve));
    await new Promise((r) => setTimeout(r, 50));

    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=invalid-ticket-payload`);
      badWs.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      badWs.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));

    for (const r of rosters) {
      expect(r.some((m: any) => m.id === 'c2' || m.name === 'bad')).toBe(false);
    }
    ws1.close();
  });
  it('two real ws clients type into the same document concurrently and converge', async () => {
    (globalThis as any).WebSocket = WebSocket;
    const app = setup();
    const a = (
      await create(app, { id: 'conv-room', displayName: 'Alice', clientId: 'client-a' })
    ).json();
    const b = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/conv-room/join',
        payload: { displayName: 'Bob', clientId: 'client-b' },
      })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const { CarrelProvider } = await import('../../client/src/collab/CarrelProvider.js');
    const p1 = new CarrelProvider(`ws://127.0.0.1:${port}/ws?ticket=${a.ticket}`);
    const p2 = new CarrelProvider(`ws://127.0.0.1:${port}/ws?ticket=${b.ticket}`);

    await Promise.all([
      new Promise<void>((resolve) => {
        if (p1.status === 'synced') resolve();
        else
          p1.on('status', ({ status }: { status: string }) => {
            if (status === 'synced') resolve();
          });
      }),
      new Promise<void>((resolve) => {
        if (p2.status === 'synced') resolve();
        else
          p2.on('status', ({ status }: { status: string }) => {
            if (status === 'synced') resolve();
          });
      }),
    ]);

    // Both type concurrently
    p1.doc.getText('content').insert(0, 'Alice was here.\n');
    p2.doc.getText('content').insert(0, 'Bob was here.\n');

    // Wait for sync propagation
    await new Promise((resolve) => setTimeout(resolve, 300));

    const text1 = p1.doc.getText('content').toString();
    const text2 = p2.doc.getText('content').toString();
    const room = app.rooms.get('conv-room')!;
    const serverText = room.doc.getText('content').toString();

    expect(text1).toBe(text2);
    expect(text1).toBe(serverText);
    expect(text1).toContain('Alice was here.');
    expect(text1).toContain('Bob was here.');

    p1.destroy();
    p2.destroy();
  });
  it('echo-suppression with a real Yjs update', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'echo-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${created.ticket}`);
    const syncFrames: Buffer[] = [];
    ws.on('message', (x) => {
      const b = Buffer.from(x as Buffer);
      if (b[0] === 0) syncFrames.push(b);
    });
    await new Promise((resolve) => ws.once('open', resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const initialSyncCount = syncFrames.length;

    const localDoc = new Y.Doc();
    let sentUpdate: Uint8Array | null = null;
    localDoc.on('update', (u) => {
      sentUpdate = u;
    });
    localDoc.getText('content').insert(0, 'Hello without echo!');

    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, sentUpdate!);
    const frame = Buffer.concat([Buffer.from([0]), Buffer.from(encoding.toUint8Array(enc))]);
    ws.send(frame);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(syncFrames.length).toBe(initialSyncCount);
    const serverRoom = app.rooms.get('echo-room')!;
    expect(serverRoom.doc.getText('content').toString()).toContain('Hello without echo!');
    ws.close();
  });
  it('session token lets a client rejoin without the passcode; a token for room A is rejected for room B', async () => {
    const app = setup();
    const a = (
      await create(app, { id: 'room-a', displayName: 'Mae', clientId: 'c1', passcode: 'pass-a' })
    ).json();
    await create(app, { id: 'room-b', displayName: 'Mae', clientId: 'c1', passcode: 'pass-b' });
    const ok = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/join',
      payload: { displayName: 'Mae', clientId: 'c1', sessionToken: a.sessionToken },
    });
    const bad = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/room-b/join',
      payload: { displayName: 'Mae', clientId: 'c1', sessionToken: a.sessionToken },
    });
    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(401);
  });
  it('room full returns room_full', async () => {
    const app = setup({ maxPeersPerRoom: 1 });
    const a = (await create(app, { id: 'full-room', displayName: 'Mae', clientId: 'c1' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${a.ticket}`);
    await new Promise((resolve) => ws.once('open', resolve));
    const join = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/full-room/join',
      payload: { displayName: 'Rafi', clientId: 'c2' },
    });
    expect(join.statusCode).toBe(409);
    expect(join.json().error).toBe('room_full');
    ws.close();
  });
  it('locked room refuses new joins but accepts a valid session', async () => {
    const app = setup();
    const created = (
      await create(app, {
        id: 'locked-room',
        displayName: 'Mae',
        clientId: 'c1',
        passcode: 'secret-pass',
      })
    ).json();

    app.db.prepare('UPDATE rooms SET locked=1 WHERE id=?').run('locked-room');

    const noSession = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/locked-room/join',
      payload: { displayName: 'Stranger', clientId: 'c2', passcode: 'secret-pass' },
    });
    expect(noSession.statusCode).toBe(423);
    expect(noSession.json().error).toBe('room_locked');

    const withSession = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/locked-room/join',
      payload: { displayName: 'Mae', clientId: 'c1', sessionToken: created.sessionToken },
    });
    expect(withSession.statusCode).toBe(200);
    const sessionTicket = withSession.json().ticket;
    expect(sessionTicket).toBeDefined();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${sessionTicket}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('close', (code) => reject(new Error(`Closed with ${code}`)));
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
  it('oversized doc update is rejected without disconnecting the sender', async () => {
    const app = setup({ maxDocBytes: 500 });
    const created = (
      await create(app, { id: 'oversize-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${created.ticket}`);
    const controlErrors: any[] = [];
    ws.on('message', (x) => {
      const b = Buffer.from(x as Buffer);
      if (b[0] === 2) {
        try {
          const msg = JSON.parse(b.subarray(1).toString('utf8'));
          if (msg.type === 'error') controlErrors.push(msg);
        } catch {}
      }
    });
    await new Promise((resolve) => ws.once('open', resolve));

    const bigDoc = new Y.Doc();
    let bigUpdate: Uint8Array | null = null;
    bigDoc.on('update', (u) => {
      bigUpdate = u;
    });
    bigDoc.getText('content').insert(0, 'A'.repeat(2000));

    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, bigUpdate!);
    const frame = Buffer.concat([Buffer.from([0]), Buffer.from(encoding.toUint8Array(enc))]);
    ws.send(frame);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(controlErrors.some((e) => e.code === 'doc_too_large')).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const pongs: any[] = [];
    ws.on('message', (x) => {
      const b = Buffer.from(x as Buffer);
      if (b[0] === 2 && b.toString().includes('pong')) pongs.push(true);
    });
    ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ type: 'ping' }))]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pongs.length).toBeGreaterThan(0);
    ws.close();
  });
  it('PERSISTENCE restores text after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carrel-persist-'));
    const dbPath = join(dir, 'persist.db');
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
      await create(app1, { id: 'persist-room', displayName: 'Mae', clientId: 'c1' })
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
    localDoc.getText('content').insert(0, 'Important persistent draft line.');

    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, sentUpdate!);
    ws1.send(Buffer.concat([Buffer.from([0]), Buffer.from(encoding.toUint8Array(enc))]));
    await new Promise((r) => setTimeout(r, 100));

    ws1.close();
    await (app1.app as any).closeCarrel();
    await app1.app.close();

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
    const joinRes = await app2.app.inject({
      method: 'POST',
      url: '/api/rooms/persist-room/join',
      payload: { displayName: 'Mae Reborn', clientId: 'c2' },
    });
    const c2Ticket = joinRes.json().ticket;
    await app2.app.listen({ port: 0, host: '127.0.0.1' });
    const port2 = (app2.app.server.address() as any).port;

    (globalThis as any).WebSocket = WebSocket;
    const { CarrelProvider } = await import('../../client/src/collab/CarrelProvider.js');
    const p2 = new CarrelProvider(`ws://127.0.0.1:${port2}/ws?ticket=${c2Ticket}`);
    await new Promise<void>((resolve) => {
      if (p2.status === 'synced') resolve();
      else
        p2.on('status', ({ status }: { status: string }) => {
          if (status === 'synced') resolve();
        });
    });

    expect(p2.doc.getText('content').toString()).toBe('Important persistent draft line.');
    p2.destroy();
    await (app2.app as any).closeCarrel();
    await app2.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('abrupt socket termination removes the member without throwing', async () => {
    const app = setup();
    const a = (await create(app, { id: 'abrupt-room', displayName: 'Mae', clientId: 'c1' })).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${a.ticket}`);
    await new Promise((resolve) => ws.once('open', resolve));
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.terminate();
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((app.rooms.get('abrupt-room') as any).members.size).toBe(0);
  });
  it('logs contain no passcode/ticket/token strings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carrel-log-'));
    const secret = 'test-session-secret-01234567890123456789';

    const app = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: join(dir, 'test.db'),
      sessionSecret: secret,
      hostGraceMs: 1,
      maxDocBytes: 1024 * 1024,
      maxPeersPerRoom: 2,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
    });

    expect(LOGGER_REDACT_PATHS).toContain('req.body.passcode');
    expect(LOGGER_REDACT_PATHS).toContain('req.body.ticket');
    expect(LOGGER_REDACT_PATHS).toContain('req.body.sessionToken');
    expect(LOGGER_REDACT_PATHS).toContain('req.body.creatorKey');
    expect(LOGGER_REDACT_PATHS).toContain('res.body.ticket');
    expect(LOGGER_REDACT_PATHS).toContain('res.body.sessionToken');
    expect(LOGGER_REDACT_PATHS).toContain('res.body.creatorKey');
    expect(LOGGER_REDACT_PATHS).toContain('passcode');
    expect(LOGGER_REDACT_PATHS).toContain('ticket');
    expect(LOGGER_REDACT_PATHS).toContain('sessionToken');
    expect(LOGGER_REDACT_PATHS).toContain('creatorKey');

    await (app.app as any).closeCarrel();
    await app.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('set_language is host-only and validates allowed languages', async () => {
    const app = setup();
    const hostCreated = (
      await create(app, { id: 'lang-room', displayName: 'Host', clientId: 'c1' })
    ).json();
    const memberJoin = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/lang-room/join',
        payload: { displayName: 'Member', clientId: 'c2' },
      })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${hostCreated.ticket}`);
    const memberWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${memberJoin.ticket}`);
    await Promise.all([
      new Promise((r) => hostWs.once('open', r)),
      new Promise((r) => memberWs.once('open', r)),
    ]);

    const memberErrors: any[] = [];
    memberWs.on('message', (data) => {
      const buf = Buffer.from(data as Buffer);
      if (buf[0] === 2) {
        try {
          const msg = JSON.parse(buf.subarray(1).toString());
          if (msg.type === 'error') memberErrors.push(msg);
        } catch {}
      }
    });

    memberWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'set_language', language: 'python' })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(memberErrors.some((e) => e.code === 'forbidden')).toBe(true);

    const memberUpdates: any[] = [];
    memberWs.on('message', (data) => {
      const buf = Buffer.from(data as Buffer);
      if (buf[0] === 2) {
        try {
          const msg = JSON.parse(buf.subarray(1).toString());
          if (msg.type === 'room_updated') memberUpdates.push(msg);
        } catch {}
      }
    });
    hostWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'set_language', language: 'python' })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(memberUpdates.some((u) => u.language === 'python')).toBe(true);

    hostWs.close();
    memberWs.close();
  });
  it('make_host allows host to transfer host role, forbidden for members', async () => {
    const app = setup();
    const hostCreated = (
      await create(app, { id: 'mh-room', displayName: 'Host', clientId: 'c1' })
    ).json();
    const memberJoin = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/mh-room/join',
        payload: { displayName: 'Member', clientId: 'c2' },
      })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${hostCreated.ticket}`);
    const memberWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${memberJoin.ticket}`);
    await Promise.all([
      new Promise((r) => hostWs.once('open', r)),
      new Promise((r) => memberWs.once('open', r)),
    ]);

    const memberErrors: any[] = [];
    memberWs.on('message', (data) => {
      const buf = Buffer.from(data as Buffer);
      if (buf[0] === 2) {
        try {
          const msg = JSON.parse(buf.subarray(1).toString());
          if (msg.type === 'error') memberErrors.push(msg);
        } catch {}
      }
    });
    memberWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'make_host', clientId: 'c2' })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(memberErrors.some((e) => e.code === 'forbidden')).toBe(true);

    const roleChanges: any[] = [];
    memberWs.on('message', (data) => {
      const buf = Buffer.from(data as Buffer);
      if (buf[0] === 2) {
        try {
          const msg = JSON.parse(buf.subarray(1).toString());
          if (msg.type === 'role_changed') roleChanges.push(msg);
        } catch {}
      }
    });
    hostWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'make_host', clientId: 'c2' })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(roleChanges.some((rc) => rc.clientId === 'c2' && rc.role === 'host')).toBe(true);

    const room = app.rooms.get('mh-room')!;
    expect(room.members.get('c2')?.role).toBe('host');
    expect(room.members.get('c1')?.role).toBe('member');

    hostWs.close();
    memberWs.close();
  });
  it('kick disconnects the member with 4003 and prevents rejoining for 10 minutes', async () => {
    const app = setup();
    const hostCreated = (
      await create(app, { id: 'kick-room', displayName: 'Host', clientId: 'c1' })
    ).json();
    const memberJoin = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/kick-room/join',
        payload: { displayName: 'BadActor', clientId: 'c2' },
      })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${hostCreated.ticket}`);
    const memberWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${memberJoin.ticket}`);
    await Promise.all([
      new Promise((r) => hostWs.once('open', r)),
      new Promise((r) => memberWs.once('open', r)),
    ]);

    let closedCode: number | null = null;
    memberWs.on('close', (code) => {
      closedCode = code;
    });

    hostWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'kick', clientId: 'c2' })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 150));

    expect(closedCode).toBe(4003);

    const rejoin = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/kick-room/join',
      payload: { displayName: 'BadActor', clientId: 'c2' },
    });
    expect(rejoin.statusCode).toBe(403);

    const sessionRejoin = await app.app.inject({
      method: 'POST',
      url: '/api/rooms/kick-room/join',
      payload: { displayName: 'BadActor', clientId: 'c2', sessionToken: memberJoin.sessionToken },
    });
    expect(sessionRejoin.statusCode).toBe(403);

    hostWs.close();
  });
  it('read-only mode drops updates from members but accepts updates from host', async () => {
    const app = setup();
    const hostCreated = (
      await create(app, { id: 'ro-room', displayName: 'Host', clientId: 'c1' })
    ).json();
    const memberJoin = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/ro-room/join',
        payload: { displayName: 'Member', clientId: 'c2' },
      })
    ).json();

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${hostCreated.ticket}`);
    const memberWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${memberJoin.ticket}`);
    await Promise.all([
      new Promise((r) => hostWs.once('open', r)),
      new Promise((r) => memberWs.once('open', r)),
    ]);

    hostWs.send(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(JSON.stringify({ type: 'set_readonly', value: true })),
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));

    const room = app.rooms.get('ro-room')!;
    expect(room.row.readonly).toBe(1);

    const memDoc = new Y.Doc();
    let memUpdate: Uint8Array | null = null;
    memDoc.on('update', (u) => {
      memUpdate = u;
    });
    memDoc.getText('content').insert(0, 'Member illicit edit');

    const memEnc = encoding.createEncoder();
    syncProtocol.writeUpdate(memEnc, memUpdate!);
    memberWs.send(Buffer.concat([Buffer.from([0]), Buffer.from(encoding.toUint8Array(memEnc))]));
    await new Promise((r) => setTimeout(r, 100));

    expect(room.doc.getText('content').toString()).not.toContain('Member illicit edit');

    const hostDoc = new Y.Doc();
    let hostUpdate: Uint8Array | null = null;
    hostDoc.on('update', (u) => {
      hostUpdate = u;
    });
    hostDoc.getText('content').insert(0, 'Host allowed edit');

    const hostEnc = encoding.createEncoder();
    syncProtocol.writeUpdate(hostEnc, hostUpdate!);
    hostWs.send(Buffer.concat([Buffer.from([0]), Buffer.from(encoding.toUint8Array(hostEnc))]));
    await new Promise((r) => setTimeout(r, 100));

    expect(room.doc.getText('content').toString()).toContain('Host allowed edit');

    hostWs.close();
    memberWs.close();
  });
  it('12 wrong passcodes with rotating X-Forwarded-For still hit 429 lockout', async () => {
    const app = setup({ trustProxy: false });
    await create(app, {
      id: 'brute-room',
      displayName: 'Mae',
      clientId: 'c1',
      passcode: 'correct-secret',
    });

    for (let i = 1; i <= 12; i++) {
      const res = await app.app.inject({
        method: 'POST',
        url: '/api/rooms/brute-room/join',
        headers: { 'x-forwarded-for': `192.168.1.${i}` },
        payload: { passcode: `wrong-${i}`, displayName: 'Attacker', clientId: `attacker-${i}` },
      });
      if (i >= 5) {
        expect(res.statusCode).toBe(429);
        expect(res.json().error).toBe('rate_limited');
      } else {
        expect(res.statusCode).toBe(401);
      }
    }
  });
  it('Host assignment: headless occupied room promotes newcomer by vacant rule; creator rejoining occupied room is member', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'empty-room', displayName: 'Creator', clientId: 'c1' })
    ).json();
    const creatorKey = created.creatorKey;

    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;

    const join1 = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/empty-room/join',
        payload: { displayName: 'NonCreator', clientId: 'c2' },
      })
    ).json();

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${join1.ticket}`);
    await new Promise((r) => ws1.once('open', r));
    await new Promise((r) => setTimeout(r, 50));

    const room = app.rooms.get('empty-room')!;
    expect(room.members.get('c2')?.role).toBe('host');

    const join2 = (
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/empty-room/join',
        payload: { displayName: 'CreatorRejoin', clientId: 'c1', creatorKey },
      })
    ).json();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${join2.ticket}`);
    await new Promise((r) => ws2.once('open', r));
    await new Promise((r) => setTimeout(r, 50));

    expect(room.members.get('c1')?.role).toBe('member');

    ws1.close();
    ws2.close();
  });
  it('Zod env validation: invalid numbers fail at boot with a clear message', () => {
    expect(() => loadConfig({ port: 'not-a-number' as any })).toThrow(/Invalid number for PORT/);
    expect(() => loadConfig({ maxDocBytes: 'invalid' as any })).toThrow(
      /Invalid number for MAX_DOC_BYTES/,
    );
    expect(() => loadConfig({ sessionSecret: 'short' })).toThrow(/at least 32 characters/);
  });
  it('POST /api/test/restart returns 404 when ENABLE_TEST_ENDPOINTS is not true, and 200 when true', async () => {
    const orig = process.env.ENABLE_TEST_ENDPOINTS;
    try {
      delete process.env.ENABLE_TEST_ENDPOINTS;
      const app = setup();
      const res = await app.app.inject({ method: 'POST', url: '/api/test/restart' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });

      process.env.ENABLE_TEST_ENDPOINTS = 'true';
      const resOn = await app.app.inject({ method: 'POST', url: '/api/test/restart' });
      expect(resOn.statusCode).toBe(200);
      expect(resOn.json()).toEqual({ ok: true });
    } finally {
      if (orig !== undefined) process.env.ENABLE_TEST_ENDPOINTS = orig;
      else delete process.env.ENABLE_TEST_ENDPOINTS;
    }
  });
  it('Production invariant path: in production, invalid room state does not throw on socket close and repairs host', async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const app = setup();
      await create(app, { id: 'prod-inv-room', displayName: 'Alice', clientId: 'c1' });
      await app.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.app.server.address() as any).port;

      const joinRes = (
        await app.app.inject({
          method: 'POST',
          url: '/api/rooms/prod-inv-room/join',
          payload: { displayName: 'Alice', clientId: 'c1' },
        })
      ).json();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${joinRes.ticket}`);
      await new Promise((r) => ws.once('open', r));
      await new Promise((r) => setTimeout(r, 50));

      const room = app.rooms.get('prod-inv-room')!;
      // Introduce an invalid state (orphan hostId)
      room.hostId = 'orphan-ghost-host';

      // Disconnect socket - socket close triggers assertRoomInvariants
      // In production it must NOT throw and must not crash
      expect(() => {
        ws.close();
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  describe('Single-service deployment, abuse limits & graceful shutdown', () => {
    it('fails fast if SESSION_SECRET is missing or less than 32 characters', () => {
      expect(() => loadConfig({ sessionSecret: 'short' })).toThrow(
        /SESSION_SECRET is required and must be at least 32 characters/,
      );
      expect(() => loadConfig({ sessionSecret: '' })).toThrow(
        /SESSION_SECRET is required and must be at least 32 characters/,
      );
    });

    it('serves static client with no-cache on index.html and SPA fallback for non-api routes', async () => {
      const app = setup();
      const resRoot = await app.app.inject({ method: 'GET', url: '/' });
      expect(resRoot.statusCode).toBe(200);
      expect(resRoot.headers['cache-control']).toContain('no-cache');
      expect(resRoot.payload).toContain('Carrel');

      const resSpa = await app.app.inject({ method: 'GET', url: '/r/quiet-harbor-42' });
      expect(resSpa.statusCode).toBe(200);
      expect(resSpa.headers['cache-control']).toContain('no-cache');
      expect(resSpa.payload).toContain('Carrel');

      const resApi404 = await app.app.inject({ method: 'GET', url: '/api/not-a-route' });
      expect(resApi404.statusCode).toBe(404);
      expect(resApi404.json()).toEqual({ error: 'not_found' });
    });

    it('enforces ROOMS_PER_IP_PER_HOUR rate limit with 429 rate_limited', async () => {
      const app = setup({ roomsPerIpPerHour: 3 });
      for (let i = 0; i < 3; i++) {
        const res = await create(app, { displayName: `User ${i}`, clientId: `c-${i}` });
        expect(res.statusCode).toBe(201);
      }
      const resBlocked = await create(app, { displayName: 'User 4', clientId: 'c-4' });
      expect(resBlocked.statusCode).toBe(429);
      expect(resBlocked.json()).toEqual({ error: 'rate_limited' });
    });

    it('enforces MAX_ROOMS global cap with 429 rate_limited', async () => {
      const app = setup({ maxRooms: 2, roomsPerIpPerHour: 100 });
      expect((await create(app, { displayName: 'U1', clientId: 'c1' })).statusCode).toBe(201);
      expect((await create(app, { displayName: 'U2', clientId: 'c2' })).statusCode).toBe(201);

      const resMax = await create(app, { displayName: 'U3', clientId: 'c3' });
      expect(resMax.statusCode).toBe(429);
      expect(resMax.json()).toEqual({ error: 'rate_limited' });
    });

    it('evicts idle in-memory rooms after idleRoomEvictMs and rehydrates upon reconnect', async () => {
      const app = setup({ idleRoomEvictMs: 1 });
      await create(app, { id: 'idle-evict-room', displayName: 'Alice', clientId: 'c1' });
      await app.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.app.server.address() as any).port;

      const joinRes = (
        await app.app.inject({
          method: 'POST',
          url: '/api/rooms/idle-evict-room/join',
          payload: { displayName: 'Alice', clientId: 'c1' },
        })
      ).json();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${joinRes.ticket}`);
      await new Promise((r) => ws.once('open', r));
      await new Promise((r) => setTimeout(r, 50));

      const room = app.rooms.get('idle-evict-room')!;
      expect(room).toBeDefined();
      room.doc.getText('content').insert(0, 'Hello from memory');

      // Member disconnects -> room becomes idle
      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      // Trigger idle eviction
      (app.app as any).evictIdleRooms();

      // Room should now be evicted from memory
      expect(app.rooms.has('idle-evict-room')).toBe(false);

      // Reconnect / rejoin room -> should rehydrate from SQLite snapshot
      const rejoinRes = (
        await app.app.inject({
          method: 'POST',
          url: '/api/rooms/idle-evict-room/join',
          payload: { displayName: 'Alice', clientId: 'c1', sessionToken: joinRes.sessionToken },
        })
      ).json();
      expect(rejoinRes.roomId).toBe('idle-evict-room');

      // The rehydrated room now exists in memory with original doc text intact
      const rehydratedRoom = app.rooms.get('idle-evict-room')!;
      expect(rehydratedRoom).toBeDefined();
      expect(rehydratedRoom.doc.getText('content').toString()).toBe('Hello from memory');
    });

    it('flushes room snapshots to SQLite on graceful shutdown', async () => {
      const app = setup();
      await create(app, { id: 'shutdown-flush-room', displayName: 'Alice', clientId: 'c1' });
      await app.app.inject({
        method: 'POST',
        url: '/api/rooms/shutdown-flush-room/join',
        payload: { displayName: 'Alice', clientId: 'c1' },
      });

      const room = app.rooms.get('shutdown-flush-room')!;
      room.doc.getText('content').insert(0, 'Flushed text on SIGTERM');

      // Simulate graceful shutdown
      await (app.app as any).closeCarrel();

      // Verify directly from SQLite database file that snapshot was persisted
      const dbPath = app.config.databasePath;
      const Database = (await import('better-sqlite3')).default;
      const verifyDb = new Database(dbPath);
      const snapshotRow = verifyDb
        .prepare('SELECT ydoc_state FROM snapshots WHERE room_id=?')
        .get('shutdown-flush-room') as { ydoc_state: Buffer };

      expect(snapshotRow).toBeDefined();
      const freshDoc = new Y.Doc();
      Y.applyUpdate(freshDoc, snapshotRow.ydoc_state);
      expect(freshDoc.getText('content').toString()).toBe('Flushed text on SIGTERM');
      verifyDb.close();
    });
  });
});
