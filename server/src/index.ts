import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { z } from 'zod';
import {
  CLOSE_CODES,
  MESSAGE_TYPES,
  createRoomSchema,
  joinRoomSchema,
  roomIdSchema,
  type CreateRoom,
  type JoinRoom,
  ALLOWED_LANGUAGES,
  controlMessageSchema,
} from '@carrel/shared';

export type ServerConfig = {
  port: number;
  clientOrigin: string;
  databasePath: string;
  sessionSecret: string;
  hostGraceMs: number;
  maxDocBytes: number;
  maxPeersPerRoom: number;
  ticketTtlMs: number;
  sessionTtlMs: number;
};
const DEFAULTS = {
  port: 3001,
  clientOrigin: 'http://localhost:4173',
  databasePath: './data/carrel.db',
  hostGraceMs: 5000,
  maxDocBytes: 1048576,
  maxPeersPerRoom: 7,
  ticketTtlMs: 60000,
  sessionTtlMs: 86400000,
};
const adjectives = [
  'amber',
  'quiet',
  'patient',
  'copper',
  'brisk',
  'clever',
  'calm',
  'bright',
  'steady',
  'sincere',
  'mellow',
  'small',
  'kind',
  'plain',
  'lucid',
  'focused',
  'gentle',
  'tidy',
  'warm',
  'useful',
  'curious',
  'still',
  'early',
  'honest',
  'deep',
  'soft',
  'clear',
  'neat',
  'open',
  'swift',
  'thoughtful',
  'tactile',
  'serious',
  'simple',
  'seasonal',
  'wooden',
  'paper',
  'brass',
  'inked',
  'nightly',
  'scholarly',
  'restful',
  'methodical',
  'private',
  'shared',
  'local',
  'ready',
  'awake',
  'silent',
];
const nouns = [
  'heron',
  'carrel',
  'atlas',
  'notebook',
  'lantern',
  'dijkstra',
  'quill',
  'shelf',
  'ledger',
  'map',
  'compass',
  'robin',
  'badger',
  'rook',
  'willow',
  'cabin',
  'margin',
  'folio',
  'orbit',
  'beacon',
  'bridge',
  'archive',
  'method',
  'theorem',
  'garden',
  'window',
  'desk',
  'chapter',
  'signal',
  'index',
  'kernel',
  'vector',
  'graph',
  'proof',
  'study',
  'lamp',
  'paper',
  'stone',
  'oak',
  'river',
  'room',
  'library',
  'cursor',
  'thread',
  'draft',
  'module',
  'syntax',
  'vertex',
];
const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = {
    ...DEFAULTS,
    port: Number(env('PORT', String(DEFAULTS.port))),
    clientOrigin: env('CLIENT_ORIGIN', DEFAULTS.clientOrigin)!,
    databasePath: env('DATABASE_PATH', DEFAULTS.databasePath)!,
    hostGraceMs: Number(env('HOST_GRACE_MS', String(DEFAULTS.hostGraceMs))),
    maxDocBytes: Number(env('MAX_DOC_BYTES', String(DEFAULTS.maxDocBytes))),
    maxPeersPerRoom: Number(env('MAX_PEERS_PER_ROOM', String(DEFAULTS.maxPeersPerRoom))),
    ticketTtlMs: Number(env('TICKET_TTL_MS', String(DEFAULTS.ticketTtlMs))),
    sessionTtlMs: Number(env('SESSION_TTL_MS', String(DEFAULTS.sessionTtlMs))),
    sessionSecret: env('SESSION_SECRET', '')!,
  };
  if (base.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET is required and must be at least 32 characters');
  return { ...base, ...overrides };
}
type RoomRow = {
  id: string;
  passcode_hash: Buffer | null;
  salt: Buffer | null;
  creator_key_hash: Buffer;
  language: string;
  locked: number;
  readonly: number;
  created_at: number;
  updated_at: number;
};
type Member = {
  socket: WebSocket;
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  role: 'host' | 'member';
  lastSeen: number;
};
type Room = {
  row: RoomRow;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  members: Map<string, Member>;
  saveTimer?: NodeJS.Timeout;
  updateCount: number;
};
const colors = [
  '#E4572E',
  '#4FA39A',
  '#D9A441',
  '#8FB339',
  '#4A7FD6',
  '#C46BA0',
  '#9A7BD1',
  '#E08E79',
];
const dummySalt = Buffer.alloc(16, 7);
const genericError = { error: 'invalid_credentials' };
const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');
const unb64 = (x: string) => Buffer.from(x, 'base64url');
const now = () => Date.now();
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const sha = (x: string) => createHash('sha256').update(x).digest();
const hashPasscode = (x: string, salt: Buffer) =>
  scryptSync(x, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
function token(secret: string, payload: Record<string, unknown>) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
}
function verifyToken(secret: string, raw: string) {
  try {
    const [body, sig] = raw.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', secret).update(body).digest();
    if (!safeEqual(expected, unb64(sig))) return null;
    return JSON.parse(unb64(body).toString('utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}
function json(ws: WebSocket, message: unknown) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(
      Buffer.concat([Buffer.from([MESSAGE_TYPES.control]), Buffer.from(JSON.stringify(message))]),
    );
}
function control(ws: WebSocket, type: string, payload: Record<string, unknown> = {}) {
  json(ws, { type, ...payload });
}
function binary(type: number, payload: Uint8Array) {
  return Buffer.concat([Buffer.from([type]), Buffer.from(payload)]);
}
function syncUpdateFrame(update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
  syncProtocol.writeUpdate(encoder, update);
  return binary(MESSAGE_TYPES.sync, encoding.toUint8Array(encoder));
}
function generatedRoomId(db: any) {
  for (let i = 0; i < 1000; i++) {
    const id = `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${Math.floor(Math.random() * 90) + 10}`;
    if (!db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id)) return id;
  }
  throw new Error('could not generate unique room id');
}

export function buildApp(config: ServerConfig = loadConfig()) {
  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
  const db = new DatabaseSync(resolve(config.databasePath));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, passcode_hash BLOB NULL, salt BLOB NULL, creator_key_hash BLOB NOT NULL, language TEXT DEFAULT "plaintext", locked INTEGER DEFAULT 0, readonly INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER); CREATE TABLE IF NOT EXISTS snapshots (room_id TEXT PRIMARY KEY, ydoc_state BLOB NOT NULL, updated_at INTEGER); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, ts INTEGER, type TEXT, actor_id TEXT, payload TEXT); CREATE INDEX IF NOT EXISTS audit_room_ts ON audit(room_id, ts);',
  );
  const app = Fastify({
    logger: {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.body.ticket',
        'res.body.sessionToken',
        'res.body.creatorKey',
      ],
    },
  });
  const rooms = new Map<string, Room>();
  const consumed = new Map<string, number>();
  const failed = new Map<string, { count: number; lockedUntil: number; last: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const cleanup = setInterval(() => {
    const t = now();
    for (const [k, v] of consumed) if (v < t) consumed.delete(k);
    for (const [k, v] of failed) if (v.last + 600000 < t && v.lockedUntil < t) failed.delete(k);
  }, 60000);
  cleanup.unref();
  const schedule = (r: Room) => {
    if (r.saveTimer) clearTimeout(r.saveTimer);
    r.saveTimer = setTimeout(() => save(r), 2000);
  };
  const save = (r: Room) => {
    try {
      const update = Y.encodeStateAsUpdate(r.doc);
      db.prepare(
        'INSERT INTO snapshots(room_id,ydoc_state,updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET ydoc_state=excluded.ydoc_state,updated_at=excluded.updated_at',
      ).run(r.row.id, Buffer.from(update), now());
    } catch {
      // Snapshot timers can fire as the process is shutting down.
    }
  };
  const getRoom = (row: RoomRow): Room => {
    const existing = rooms.get(row.id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const saved = db.prepare('SELECT ydoc_state FROM snapshots WHERE room_id=?').get(row.id) as
      { ydoc_state?: Buffer } | undefined;
    if (saved?.ydoc_state) Y.applyUpdate(doc, saved.ydoc_state);
    const r: Room = { row, doc, awareness, members: new Map(), updateCount: 0 };
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin instanceof WebSocket)
        for (const m of r.members.values())
          if (m.socket !== origin && m.socket.readyState === WebSocket.OPEN)
            m.socket.send(syncUpdateFrame(update));
      schedule(r);
    });
    rooms.set(row.id, r);
    return r;
  };
  const roster = (r: Room) =>
    Array.from(r.members.values()).map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  const broadcastRoster = (r: Room) => {
    for (const m of r.members.values()) control(m.socket, 'roster', { members: roster(r) });
  };
  const audit = (r: Room, type: string, actorId: string, payload: Record<string, unknown> = {}) => {
    try {
      db.prepare('INSERT INTO audit(room_id,ts,type,actor_id,payload) VALUES(?,?,?,?,?)').run(
        r.row.id,
        now(),
        type,
        actorId,
        JSON.stringify(payload),
      );
      db.prepare(
        'DELETE FROM audit WHERE room_id=? AND id NOT IN (SELECT id FROM audit WHERE room_id=? ORDER BY ts DESC,id DESC LIMIT 500)',
      ).run(r.row.id, r.row.id);
    } catch {
      // Socket close can race graceful database teardown.
    }
    for (const m of r.members.values())
      control(m.socket, 'audit', { event: type, actorId, ...payload });
  };
  const issueTicket = (roomId: string, clientId: string, displayName: string, role: string) => {
    const iat = now();
    return token(config.sessionSecret, {
      roomId,
      clientId,
      displayName,
      role,
      iat,
      exp: iat + config.ticketTtlMs,
      nonce: b64(randomBytes(18)),
    });
  };
  const issueSession = (roomId: string, clientId: string) => {
    const iat = now();
    return token(config.sessionSecret, {
      roomId,
      clientId,
      iat,
      exp: iat + config.sessionTtlMs,
      kind: 'session',
    });
  };
  const validSession = (raw: string | undefined, id: string, clientId: string) => {
    const p = raw ? verifyToken(config.sessionSecret, raw) : null;
    return (
      !!p && p.kind === 'session' && p.roomId === id && p.clientId === clientId && p.exp > now()
    );
  };
  const validCreator = (raw: string | undefined, row: RoomRow) =>
    !!raw && safeEqual(sha(raw), row.creator_key_hash);
  const ip = (req: any) =>
    String(req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown').split(',')[0];
  const rateKey = (req: any, id: string) => `${ip(req)}:${id}`;
  const rate = (k: string) => {
    const v = failed.get(k);
    return v && v.lockedUntil > now() ? Math.ceil((v.lockedUntil - now()) / 1000) : 0;
  };
  const fail = (k: string) => {
    const v = failed.get(k) ?? { count: 0, lockedUntil: 0, last: now() };
    v.count++;
    v.last = now();
    if (v.count >= 5) v.lockedUntil = Math.min(now() + 60000 * 2 ** (v.count - 5), now() + 3600000);
    failed.set(k, v);
    return Math.max(1, Math.ceil((v.lockedUntil - now()) / 1000));
  };
  app.register(cors, { origin: config.clientOrigin });
  app.get('/api/health', async () => ({ ok: true, service: 'carrel-server' }));
  app.get('/health', async () => ({ ok: true, service: 'carrel-server' }));
  app.get('/api/rooms/check', async (req, reply) => {
    const parsed = z.object({ id: roomIdSchema }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_room_id' });
    return { available: !db.prepare('SELECT 1 FROM rooms WHERE id=?').get(parsed.data.id) };
  });
  app.post('/api/rooms', async (req, reply) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data as CreateRoom;
    const id = body.id ?? generatedRoomId(db);
    if (db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id))
      return reply.code(409).send({ error: 'room_unavailable' });
    const creatorKey = b64(randomBytes(32));
    const salt = body.passcode ? randomBytes(16) : null;
    const passHash = body.passcode && salt ? hashPasscode(body.passcode, salt) : null;
    const t = now();
    db.prepare(
      'INSERT INTO rooms(id,passcode_hash,salt,creator_key_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run(id, passHash, salt, sha(creatorKey), t, t);
    return reply.code(201).send({
      roomId: id,
      id,
      creatorKey,
      ticket: issueTicket(id, body.clientId, body.displayName, 'host'),
      sessionToken: issueSession(id, body.clientId),
      hasPasscode: !!body.passcode,
    });
  });
  app.post('/api/rooms/:id/join', async (req, reply) => {
    const id = String((req.params as any).id);
    const parsed = joinRoomSchema.safeParse(req.body);
    if (!parsed.success || !roomIdSchema.safeParse(id).success)
      return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data as JoinRoom;
    const k = rateKey(req, id);
    const retry = rate(k);
    if (retry) return reply.code(429).send({ error: 'rate_limited', retryAfterSec: retry });
    const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as RoomRow | undefined;
    let credentials = false;
    if (row) {
      const sessionOk = validSession(body.sessionToken, id, body.clientId);
      const passOk =
        row.passcode_hash && row.salt && body.passcode
          ? safeEqual(row.passcode_hash, hashPasscode(body.passcode, row.salt))
          : !row.passcode_hash;
      credentials = !!(sessionOk || passOk);
    } else hashPasscode(body.passcode ?? 'dummy', dummySalt);
    if (!credentials) {
      const after = fail(k);
      return reply
        .code((failed.get(k)?.count ?? 0) >= 5 ? 429 : 401)
        .send(
          (failed.get(k)?.count ?? 0) >= 5
            ? { error: 'rate_limited', retryAfterSec: after }
            : genericError,
        );
    }
    if (!row) return reply.code(401).send(genericError);
    const session = validSession(body.sessionToken, id, body.clientId);
    const creator = validCreator(body.creatorKey, row);
    if (row.locked && !session && !creator) return reply.code(423).send({ error: 'room_locked' });
    const r = getRoom(row);
    if (r.members.size >= config.maxPeersPerRoom && !r.members.has(body.clientId))
      return reply.code(409).send({ error: 'room_full' });
    const role = creator || r.members.size === 0 ? 'host' : 'member';
    return {
      roomId: id,
      ticket: issueTicket(id, body.clientId, body.displayName, role),
      sessionToken: issueSession(id, body.clientId),
      hasPasscode: !!row.passcode_hash,
    };
  });
  const remove = (r: Room, id: string, ws: WebSocket) => {
    if ('isOpen' in db && !db.isOpen) return;
    const member = r.members.get(id);
    if (!member || member.socket !== ws) return;
    r.members.delete(id);
    r.awareness.setLocalState(null);
    audit(r, 'left', id);
    broadcastRoster(r);
    if (r.members.size === 0) save(r);
  };
  const connect = (ws: WebSocket, payload: any) => {
    const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(payload.roomId) as
      RoomRow | undefined;
    if (!row) return ws.close(CLOSE_CODES.badTicket, 'bad ticket');
    const r = getRoom(row);
    if (row.locked && payload.role !== 'host')
      return ws.close(CLOSE_CODES.roomLocked, 'room locked');
    if (r.members.size >= config.maxPeersPerRoom && !r.members.has(payload.clientId))
      return ws.close(CLOSE_CODES.roomFull, 'room full');
    const color =
      colors.find((c) => !Array.from(r.members.values()).some((m) => m.color === c)) ??
      colors[r.members.size % colors.length];
    const member: Member = {
      socket: ws,
      id: payload.clientId,
      name: payload.displayName,
      color,
      joinedAt: now(),
      role: payload.role === 'host' ? 'host' : 'member',
      lastSeen: now(),
    };
    r.members.set(member.id, member);
    control(ws, 'roster', { members: roster(r) });
    control(ws, 'room_updated', {
      language: r.row.language || 'plaintext',
      readonly: !!r.row.readonly,
    });
    broadcastRoster(r);
    audit(r, 'joined', member.id, { name: member.name });
    ws.on('message', (raw: RawData) => {
      let frameType = -1;
      try {
        const data = Buffer.from(raw as Buffer);
        if (!data.length) return;
        const type = data[0];
        frameType = type;
        member.lastSeen = now();
        if (type === MESSAGE_TYPES.sync) {
          if (r.row.readonly && member.role !== 'host') return;
          const dec = decoding.createDecoder(data.subarray(1));
          const enc = encoding.createEncoder();
          syncProtocol.readSyncMessage(dec, enc, r.doc, ws);
          const response = encoding.toUint8Array(enc);
          if (response.length) ws.send(binary(MESSAGE_TYPES.sync, response));
        } else if (type === MESSAGE_TYPES.awareness) {
          if (data.length <= 1) return;
          awarenessProtocol.applyAwarenessUpdate(r.awareness, data.subarray(1), ws);
          for (const other of r.members.values())
            if (other.socket !== ws && other.socket.readyState === WebSocket.OPEN)
              other.socket.send(data);
        } else if (type === MESSAGE_TYPES.control) {
          const parsed = controlMessageSchema.safeParse(
            JSON.parse(data.subarray(1).toString('utf8')),
          );
          if (!parsed.success) {
            control(ws, 'error', { code: 'invalid_control' });
            return;
          }
          const msg = parsed.data;
          if (msg.type === 'ping') control(ws, 'pong');
          else if (
            msg.type === 'set_language' ||
            msg.type === 'set_readonly' ||
            msg.type === 'make_host' ||
            msg.type === 'kick'
          ) {
            if (member.role !== 'host') {
              control(ws, 'error', { code: 'forbidden' });
              return;
            }
            if (msg.type === 'set_language') {
              if (!(ALLOWED_LANGUAGES as readonly string[]).includes(msg.language)) {
                control(ws, 'error', { code: 'invalid_language' });
                return;
              }
              r.row.language = msg.language;
              db.prepare('UPDATE rooms SET language=?,updated_at=? WHERE id=?').run(
                msg.language,
                now(),
                r.row.id,
              );
              audit(r, 'language_changed', member.id, { language: msg.language });
              for (const peer of r.members.values())
                control(peer.socket, 'room_updated', {
                  language: msg.language,
                  readonly: !!r.row.readonly,
                });
            } else if (msg.type === 'set_readonly') {
              r.row.readonly = msg.value ? 1 : 0;
              db.prepare('UPDATE rooms SET readonly=?,updated_at=? WHERE id=?').run(
                r.row.readonly,
                now(),
                r.row.id,
              );
              audit(r, 'readonly_changed', member.id, { readonly: !!r.row.readonly });
              for (const peer of r.members.values())
                control(peer.socket, 'room_updated', {
                  language: r.row.language || 'plaintext',
                  readonly: !!r.row.readonly,
                });
            } else if (msg.type === 'kick') {
              const target = r.members.get(msg.clientId);
              if (target && target !== member) {
                audit(r, 'kicked', member.id, { targetId: msg.clientId });
                target.socket.close(CLOSE_CODES.kicked, 'kicked by host');
              }
            } else if (msg.type === 'make_host') {
              const target = r.members.get(msg.clientId);
              if (target && target !== member) {
                member.role = 'member';
                target.role = 'host';
                audit(r, 'host_changed', member.id, { targetId: msg.clientId });
                broadcastRoster(r);
                for (const peer of r.members.values())
                  control(peer.socket, 'role_changed', { clientId: target.id, role: 'host' });
              }
            }
          }
        } else control(ws, 'error', { code: 'malformed_frame' });
      } catch {
        if (frameType === MESSAGE_TYPES.sync) return;
        control(ws, 'error', { code: 'malformed_frame' });
      }
    });
    ws.on('close', () => remove(r, member.id, ws));
    ws.on('error', () => remove(r, member.id, ws));
  };
  app.server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname !== '/ws') return;
      const raw = url.searchParams.get('ticket');
      const payload = raw ? verifyToken(config.sessionSecret, raw) : null;
      const nonce = payload?.nonce;
      if (!payload || payload.exp <= now() || !nonce || consumed.has(nonce)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      consumed.set(nonce, payload.exp);
      wss.handleUpgrade(request, socket, head, (ws) => connect(ws, payload));
    } catch {
      socket.destroy();
    }
  });
  (app as any).closeCarrel = async () => {
    for (const r of rooms.values()) {
      save(r);
      for (const m of r.members.values()) m.socket.close(1001, 'server shutdown');
    }
    clearInterval(cleanup);
    db.close();
  };
  return { app, db, rooms, config };
}
export async function startServer(config = loadConfig()) {
  const built = buildApp(config);
  await built.app.listen({ port: config.port, host: '0.0.0.0' });
  return built;
}
if (process.env.NODE_ENV !== 'test') {
  try {
    const server = await startServer();
    const stop = async () => {
      await (server.app as any).closeCarrel();
      await server.app.close();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
