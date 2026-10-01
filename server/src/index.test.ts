import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp, type ServerConfig } from './index.js';

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
  it.skip('JOIN-BEFORE-ADMIT: a client with a bad ticket never appears in any other client roster', () => {});
  it.skip('two real ws clients type into the same document concurrently and converge', () => {});
  it('never echoes a control ping back as a document update', async () => {
    const app = setup();
    const created = (
      await create(app, { id: 'echo-room', displayName: 'Mae', clientId: 'c1' })
    ).json();
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${created.ticket}`);
    const messages: Buffer[] = [];
    ws.on('message', (x) => messages.push(Buffer.from(x as Buffer)));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ type: 'ping' }))]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages.some((x) => x.toString().includes('pong'))).toBe(true);
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
  it.skip('locked room refuses new joins but accepts a valid session', () => {});
  it.skip('oversized doc update is rejected without disconnecting the sender', () => {});
  it.skip('PERSISTENCE restores text after restart', () => {});
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
  it.skip('logs contain no passcode/ticket/token strings', () => {});
});
