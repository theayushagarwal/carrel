import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import { createHmac, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import { z } from 'zod';
import {
  CLOSE_CODES,
  createRoomSchema,
  joinRoomSchema,
  roomIdSchema,
  type CreateRoom,
  type JoinRoom,
  ALLOWED_LANGUAGES,
  controlMessageSchema,
  FRAME_TYPES,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  encodeAwarenessRaw,
  decodeFrame,
  getAwarenessClientIDs,
} from '@carrel/shared';
import { TokenBucket, EscalationLadder } from './throttle.js';
import { electHost, checkInvariants, type Candidate } from './host.js';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

export type ServerConfig = {
  port: number;
  clientOrigin: string;
  databasePath: string;
  sessionSecret: string;
  hostGraceMs: number;
  seniorityWindowMs: number;
  kickBanMs: number;
  editCoalesceMs: number;
  maxDocBytes: number;
  maxPeersPerRoom: number;
  ticketTtlMs: number;
  sessionTtlMs: number;
  trustProxy?: boolean;
  rateLimitUpdatesPerSec: number;
  rateLimitControlPerSec: number;
  throttleWarnMs: number;
  throttleKickMs: number;
  heartbeatMs: number;
  maxBufferBytes: number;
  roomsPerIpPerHour: number;
  maxRooms: number;
  idleRoomEvictMs: number;
  clientDistPath?: string;
  clock?: () => number;
};
const DEFAULTS = {
  port: 3001,
  clientOrigin: 'http://localhost:4173',
  databasePath: './data/carrel.db',
  hostGraceMs: 5000,
  seniorityWindowMs: 30000,
  kickBanMs: 600000,
  editCoalesceMs: 10000,
  maxDocBytes: 1048576,
  maxPeersPerRoom: 7,
  ticketTtlMs: 60000,
  sessionTtlMs: 86400000,
  trustProxy: false,
  rateLimitUpdatesPerSec: 5,
  rateLimitControlPerSec: 2,
  throttleWarnMs: 3000,
  throttleKickMs: 10000,
  heartbeatMs: 15000,
  maxBufferBytes: 524288,
  roomsPerIpPerHour: 10,
  maxRooms: 500,
  idleRoomEvictMs: 600000,
};

const configNumber = (name: string, defaultVal: number, min = 1) =>
  z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return defaultVal;
    const num = Number(val);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number for ${name}: ${val}`);
    }
    return num;
  }, z.number().int().min(min));

const serverConfigSchema = z.object({
  port: configNumber('PORT', DEFAULTS.port, 0),
  clientOrigin: z.string().default(DEFAULTS.clientOrigin),
  databasePath: z.string().default(DEFAULTS.databasePath),
  hostGraceMs: configNumber('HOST_GRACE_MS', DEFAULTS.hostGraceMs, 0),
  seniorityWindowMs: configNumber('SENIORITY_WINDOW_MS', DEFAULTS.seniorityWindowMs, 0),
  kickBanMs: configNumber('KICK_BAN_MS', DEFAULTS.kickBanMs, 0),
  editCoalesceMs: configNumber('EDIT_COALESCE_MS', DEFAULTS.editCoalesceMs, 0),
  maxDocBytes: configNumber('MAX_DOC_BYTES', DEFAULTS.maxDocBytes),
  maxPeersPerRoom: configNumber('MAX_PEERS_PER_ROOM', DEFAULTS.maxPeersPerRoom),
  ticketTtlMs: configNumber('TICKET_TTL_MS', DEFAULTS.ticketTtlMs),
  sessionTtlMs: configNumber('SESSION_TTL_MS', DEFAULTS.sessionTtlMs),
  sessionSecret: z
    .string()
    .min(32, 'SESSION_SECRET is required and must be at least 32 characters'),
  trustProxy: z.boolean().default(false),
  rateLimitUpdatesPerSec: configNumber(
    'RATE_LIMIT_UPDATES_PER_SEC',
    DEFAULTS.rateLimitUpdatesPerSec,
  ),
  rateLimitControlPerSec: configNumber(
    'RATE_LIMIT_CONTROL_PER_SEC',
    DEFAULTS.rateLimitControlPerSec,
  ),
  throttleWarnMs: configNumber('THROTTLE_WARN_MS', DEFAULTS.throttleWarnMs),
  throttleKickMs: configNumber('THROTTLE_KICK_MS', DEFAULTS.throttleKickMs),
  heartbeatMs: configNumber('HEARTBEAT_MS', DEFAULTS.heartbeatMs),
  maxBufferBytes: configNumber('MAX_BUFFER_BYTES', DEFAULTS.maxBufferBytes),
  roomsPerIpPerHour: configNumber('ROOMS_PER_IP_PER_HOUR', DEFAULTS.roomsPerIpPerHour),
  maxRooms: configNumber('MAX_ROOMS', DEFAULTS.maxRooms),
  idleRoomEvictMs: configNumber('IDLE_ROOM_EVICT_MS', DEFAULTS.idleRoomEvictMs),
  clientDistPath: z.string().optional(),
  clock: z.custom<() => number>().optional(),
});

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  try {
    process.loadEnvFile?.();
  } catch {}
  const trustProxyEnv = process.env.TRUST_PROXY === 'true';
  const raw = {
    port: process.env.PORT ?? overrides.port ?? DEFAULTS.port,
    clientOrigin: process.env.CLIENT_ORIGIN ?? overrides.clientOrigin ?? DEFAULTS.clientOrigin,
    databasePath: process.env.DATABASE_PATH ?? overrides.databasePath ?? DEFAULTS.databasePath,
    hostGraceMs: process.env.HOST_GRACE_MS ?? overrides.hostGraceMs ?? DEFAULTS.hostGraceMs,
    seniorityWindowMs:
      process.env.SENIORITY_WINDOW_MS ?? overrides.seniorityWindowMs ?? DEFAULTS.seniorityWindowMs,
    kickBanMs: process.env.KICK_BAN_MS ?? overrides.kickBanMs ?? DEFAULTS.kickBanMs,
    editCoalesceMs:
      process.env.EDIT_COALESCE_MS ?? overrides.editCoalesceMs ?? DEFAULTS.editCoalesceMs,
    maxDocBytes: process.env.MAX_DOC_BYTES ?? overrides.maxDocBytes ?? DEFAULTS.maxDocBytes,
    maxPeersPerRoom:
      process.env.MAX_PEERS_PER_ROOM ?? overrides.maxPeersPerRoom ?? DEFAULTS.maxPeersPerRoom,
    ticketTtlMs: process.env.TICKET_TTL_MS ?? overrides.ticketTtlMs ?? DEFAULTS.ticketTtlMs,
    sessionTtlMs: process.env.SESSION_TTL_MS ?? overrides.sessionTtlMs ?? DEFAULTS.sessionTtlMs,
    sessionSecret: overrides.sessionSecret ?? process.env.SESSION_SECRET ?? '',
    trustProxy: overrides.trustProxy ?? trustProxyEnv,
    rateLimitUpdatesPerSec:
      process.env.RATE_LIMIT_UPDATES_PER_SEC ??
      overrides.rateLimitUpdatesPerSec ??
      DEFAULTS.rateLimitUpdatesPerSec,
    rateLimitControlPerSec:
      process.env.RATE_LIMIT_CONTROL_PER_SEC ??
      overrides.rateLimitControlPerSec ??
      DEFAULTS.rateLimitControlPerSec,
    throttleWarnMs:
      process.env.THROTTLE_WARN_MS ?? overrides.throttleWarnMs ?? DEFAULTS.throttleWarnMs,
    throttleKickMs:
      process.env.THROTTLE_KICK_MS ?? overrides.throttleKickMs ?? DEFAULTS.throttleKickMs,
    heartbeatMs: process.env.HEARTBEAT_MS ?? overrides.heartbeatMs ?? DEFAULTS.heartbeatMs,
    maxBufferBytes:
      process.env.MAX_BUFFER_BYTES ?? overrides.maxBufferBytes ?? DEFAULTS.maxBufferBytes,
    roomsPerIpPerHour:
      process.env.ROOMS_PER_IP_PER_HOUR !== undefined
        ? Number(process.env.ROOMS_PER_IP_PER_HOUR)
        : (overrides.roomsPerIpPerHour ?? DEFAULTS.roomsPerIpPerHour),
    maxRooms:
      process.env.MAX_ROOMS !== undefined
        ? Number(process.env.MAX_ROOMS)
        : (overrides.maxRooms ?? DEFAULTS.maxRooms),
    idleRoomEvictMs:
      process.env.IDLE_ROOM_EVICT_MS !== undefined
        ? Number(process.env.IDLE_ROOM_EVICT_MS)
        : (overrides.idleRoomEvictMs ?? DEFAULTS.idleRoomEvictMs),
    clientDistPath: overrides.clientDistPath ?? process.env.CLIENT_DIST_PATH,
    ...overrides,
  };
  const result = serverConfigSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join(', ');
    throw new Error(msg);
  }
  return result.data;
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
  connected: boolean;
  lastSeen: number;
  missedHeartbeats: number;
};
type Room = {
  row: RoomRow;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  members: Map<string, Member>;
  hostId: string | null;
  hostPending: { id: string; deadline: number; timer?: NodeJS.Timeout } | null;
  saveTimer?: NodeJS.Timeout;
  updateCount: number;
  recentlyLeft: Map<
    string,
    { name: string; color: string; joinedAt: number; role: 'host' | 'member'; leftAt: number }
  >;
  passcodeQueue: Promise<void>;
  pendingEdits: Map<string, { fromLine: number; toLine: number; timer: NodeJS.Timeout }>;
  lastSnapshotAuditTs: number;
  contentChangedSinceLastAudit: boolean;
  idleSince: number | null;
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
const dummySalt = Buffer.alloc(16, 7);
const genericError = { error: 'invalid_credentials' };
const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');
const unb64 = (x: string) => Buffer.from(x, 'base64url');
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const sha = (x: string) => createHash('sha256').update(x).digest();

class ConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const hashLimiter = new ConcurrencyLimiter(4);

async function hashPasscode(x: string, salt: Buffer): Promise<Buffer> {
  return hashLimiter.run(async () => {
    return (await scryptAsync(x, salt, 64, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    })) as Buffer;
  });
}
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
function safeSend(ws: WebSocket, data: Uint8Array | Buffer | string) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, () => {});
    }
  } catch {}
}
function json(ws: WebSocket, message: unknown) {
  safeSend(ws, encodeControl(message));
}
function control(ws: WebSocket, type: string, payload: Record<string, unknown> = {}) {
  json(ws, { type, ...payload });
}

function generatedRoomId(db: any) {
  for (let i = 0; i < 1000; i++) {
    const id = `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${Math.floor(Math.random() * 90) + 10}`;
    if (!db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id)) return id;
  }
  throw new Error('could not generate unique room id');
}

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.passcode',
  'req.body.ticket',
  'req.body.sessionToken',
  'req.body.creatorKey',
  'res.body.ticket',
  'res.body.sessionToken',
  'res.body.creatorKey',
  'passcode',
  'ticket',
  'sessionToken',
  'creatorKey',
];

export function buildApp(configOrOverrides: Partial<ServerConfig> = loadConfig()) {
  const config: ServerConfig =
    configOrOverrides &&
    'sessionSecret' in configOrOverrides &&
    configOrOverrides.sessionSecret &&
    'rateLimitUpdatesPerSec' in configOrOverrides
      ? (configOrOverrides as ServerConfig)
      : loadConfig(configOrOverrides);
  const now = () => (config.clock ? config.clock() : Date.now());

  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
  const db = new Database(resolve(config.databasePath));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, passcode_hash BLOB NULL, salt BLOB NULL, creator_key_hash BLOB NOT NULL, language TEXT DEFAULT "plaintext", locked INTEGER DEFAULT 0, readonly INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER); CREATE TABLE IF NOT EXISTS snapshots (room_id TEXT PRIMARY KEY, ydoc_state BLOB NOT NULL, updated_at INTEGER); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, ts INTEGER, type TEXT, actor_id TEXT, actor_name TEXT, actor_color TEXT, payload TEXT); CREATE INDEX IF NOT EXISTS audit_room_ts ON audit(room_id, ts);',
  );
  try {
    db.exec('ALTER TABLE audit ADD COLUMN actor_name TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE audit ADD COLUMN actor_color TEXT');
  } catch {}
  const app = Fastify({
    trustProxy: config.trustProxy ?? process.env.TRUST_PROXY === 'true',
    logger: {
      level: 'info',
      redact: LOGGER_REDACT_PATHS,
    },
  });
  const rooms = new Map<string, Room>();
  const consumed = new Map<string, number>();
  const failed = new Map<string, { count: number; lockedUntil: number; last: number }>();
  const kicked = new Map<string, number>();
  const rateLimitCooldowns = new Map<string, number>();
  const ipRoomCreations = new Map<string, number[]>();

  let evictIdleRooms: (t: number) => void = () => {};

  const isKicked = (roomId: string, clientId: string) => {
    const exp = kicked.get(`${roomId}:${clientId}`);
    return !!exp && exp > now();
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  const cleanup = setInterval(() => {
    const t = now();
    for (const [k, v] of consumed) if (v < t) consumed.delete(k);
    for (const [k, v] of failed) if (v.last + 600000 < t && v.lockedUntil < t) failed.delete(k);
    for (const [k, v] of kicked) if (v < t) kicked.delete(k);
    for (const [k, v] of rateLimitCooldowns) if (v < t) rateLimitCooldowns.delete(k);
    const oneHourAgo = t - 3600000;
    for (const [ipKey, history] of ipRoomCreations) {
      const recent = history.filter((ts) => ts > oneHourAgo);
      if (recent.length === 0) ipRoomCreations.delete(ipKey);
      else ipRoomCreations.set(ipKey, recent);
    }
    for (const r of rooms.values()) {
      for (const [cid, info] of r.recentlyLeft) {
        if (info.leftAt + config.seniorityWindowMs < t) r.recentlyLeft.delete(cid);
      }
    }
    evictIdleRooms(t);
  }, 60000);
  cleanup.unref();

  const heartbeatTimer = setInterval(() => {
    for (const r of rooms.values()) {
      for (const m of Array.from(r.members.values())) {
        m.missedHeartbeats++;
        if (m.missedHeartbeats >= 2) {
          try {
            m.socket.terminate();
          } catch {}
        } else {
          if (m.socket.readyState === WebSocket.OPEN) {
            try {
              m.socket.ping();
            } catch {}
          }
        }
      }
    }
  }, config.heartbeatMs);
  heartbeatTimer.unref();

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
      const nowTs = now();
      if (r.contentChangedSinceLastAudit && nowTs - r.lastSnapshotAuditTs >= 60000) {
        r.lastSnapshotAuditTs = nowTs;
        r.contentChangedSinceLastAudit = false;
        audit(r, 'snapshot_saved', 'system');
      }
    } catch {
      // Snapshot timers can fire as the process is shutting down.
    }
  };
  const roster = (r: Room) =>
    Array.from(r.members.values()).map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      role: m.role,
      joinedAt: m.joinedAt,
      connected: m.connected,
    }));
  const broadcastRoster = (r: Room) => {
    const list = roster(r);
    for (const m of r.members.values()) {
      if (m.connected && m.socket.readyState === WebSocket.OPEN) {
        control(m.socket, 'roster', { members: list });
      }
    }
  };
  const broadcastRoomUpdated = (r: Room) => {
    for (const m of r.members.values()) {
      if (m.connected && m.socket.readyState === WebSocket.OPEN) {
        control(m.socket, 'room_updated', {
          language: r.row.language || 'plaintext',
          readonly: !!r.row.readonly,
          locked: !!r.row.locked,
          hasPasscode: !!r.row.passcode_hash,
        });
      }
    }
  };
  const broadcastRoleChanged = (
    r: Room,
    payload: {
      clientId: string;
      role: 'host' | 'member';
      previousHostId?: string | null;
      reason?: string;
    },
  ) => {
    for (const m of r.members.values()) {
      if (m.connected && m.socket.readyState === WebSocket.OPEN) {
        control(m.socket, 'role_changed', payload);
      }
    }
  };
  const formatAuditRow = (row: any) => {
    let parsedPayload = {};
    try {
      parsedPayload = JSON.parse(row.payload || '{}');
    } catch {}
    return {
      id: row.id,
      ts: row.ts,
      event: row.type,
      actorId: row.actor_id,
      ...(row.actor_name ? { actorName: row.actor_name } : {}),
      ...(row.actor_color ? { actorColor: row.actor_color } : {}),
      ...parsedPayload,
    };
  };
  const sendAuditHistory = (ws: WebSocket, roomId: string, beforeId?: number) => {
    let query = 'SELECT * FROM audit WHERE room_id=?';
    const params: any[] = [roomId];
    if (beforeId !== undefined) {
      query += ' AND id < ?';
      params.push(beforeId);
    }
    query += ' ORDER BY id DESC LIMIT 201';
    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > 200;
    const pageRows = (hasMore ? rows.slice(0, 200) : rows).reverse();
    const events = pageRows.map(formatAuditRow);
    control(ws, 'audit_history', { events, hasMore });
  };
  const audit = (r: Room, type: string, actorId: string, payload: Record<string, unknown> = {}) => {
    const member = r.members.get(actorId) ?? r.recentlyLeft.get(actorId);
    const actorName =
      (payload.actorName as string) ??
      member?.name ??
      (payload.name as string) ??
      (actorId === 'system' ? 'System' : undefined);
    const actorColor = (payload.actorColor as string) ?? member?.color ?? undefined;
    let id = 0;
    const ts = now();
    try {
      const info = db
        .prepare(
          'INSERT INTO audit(room_id,ts,type,actor_id,actor_name,actor_color,payload) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          r.row.id,
          ts,
          type,
          actorId,
          actorName ?? null,
          actorColor ?? null,
          JSON.stringify(payload),
        );
      id = Number(info.lastInsertRowid);
      db.prepare(
        'DELETE FROM audit WHERE room_id=? AND id NOT IN (SELECT id FROM audit WHERE room_id=? ORDER BY id DESC LIMIT 500)',
      ).run(r.row.id, r.row.id);
    } catch {}
    const eventPayload = {
      id,
      ts,
      event: type,
      actorId,
      ...(actorName ? { actorName } : {}),
      ...(actorColor ? { actorColor } : {}),
      ...payload,
    };
    for (const m of r.members.values()) {
      if (m.connected && m.socket.readyState === WebSocket.OPEN) {
        control(m.socket, 'audit', eventPayload);
      }
    }
  };
  const flushUserEdit = (r: Room, userId: string) => {
    const pending = r.pendingEdits.get(userId);
    if (!pending) return;
    clearTimeout(pending.timer);
    r.pendingEdits.delete(userId);
    audit(r, 'edited', userId, { fromLine: pending.fromLine, toLine: pending.toLine });
  };
  evictIdleRooms = (t: number) => {
    for (const [rid, r] of rooms) {
      const hasConnected = Array.from(r.members.values()).some((m) => m.connected);
      if (!hasConnected) {
        if (r.idleSince === null) {
          r.idleSince = t;
        } else if (t - r.idleSince >= config.idleRoomEvictMs) {
          if (r.saveTimer) clearTimeout(r.saveTimer);
          if (r.hostPending?.timer) clearTimeout(r.hostPending.timer);
          for (const edit of r.pendingEdits.values()) clearTimeout(edit.timer);
          for (const userId of Array.from(r.pendingEdits.keys())) {
            flushUserEdit(r, userId);
          }
          save(r);
          try {
            r.awareness.destroy();
          } catch {}
          try {
            r.doc.destroy();
          } catch {}
          rooms.delete(rid);
        }
      }
    }
  };
  const runElection = (r: Room, reason: 'host_left' | 'vacant') => {
    const candidates: Candidate[] = Array.from(r.members.values()).map((m) => ({
      id: m.id,
      joinedAt: m.joinedAt,
      connected: m.connected,
      role: m.role,
    }));
    const winnerId = electHost(candidates);
    const previousHostId = r.hostId;
    if (winnerId) {
      for (const m of r.members.values()) {
        if (m.id === winnerId) {
          m.role = 'host';
        } else {
          m.role = 'member';
        }
      }
      r.hostId = winnerId;
      broadcastRoleChanged(r, {
        clientId: winnerId,
        role: 'host',
        previousHostId,
        reason,
      });
      broadcastRoster(r);
      audit(r, 'host_changed', winnerId, { from: previousHostId, to: winnerId, reason });
    } else {
      r.hostId = null;
      save(r);
    }
    assertRoomInvariants(r);
  };
  const assertRoomInvariants = (r: Room) => {
    try {
      checkInvariants({
        hostId: r.hostId,
        hostPending: r.hostPending,
        members: r.members,
        recentlyLeft: r.recentlyLeft,
        now: now(),
      });
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        throw err;
      }
      app.log.error(err, `Invariant violation in room ${r.row.id}`);
      try {
        const connected = Array.from(r.members.values()).filter((m) => m.connected);
        if (connected.length > 0 && !r.hostPending && (!r.hostId || !r.members.has(r.hostId))) {
          runElection(r, 'vacant');
        }
      } catch (recErr) {
        app.log.error(recErr, `Recovery failed for room ${r.row.id}`);
      }
    }
  };
  const onGraceExpired = (r: Room, pendingHostId: string) => {
    if (!r.hostPending || r.hostPending.id !== pendingHostId) return;
    r.hostPending = null;
    const hostMember = r.members.get(pendingHostId);
    if (hostMember && !hostMember.connected) {
      r.members.delete(pendingHostId);
      r.recentlyLeft.set(pendingHostId, {
        name: hostMember.name,
        color: hostMember.color,
        joinedAt: hostMember.joinedAt,
        role: hostMember.role,
        leftAt: now(),
      });
      audit(r, 'left', pendingHostId);
    }
    runElection(r, 'host_left');
  };
  const getRoom = (row: RoomRow): Room => {
    const existing = rooms.get(row.id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const saved = db.prepare('SELECT ydoc_state FROM snapshots WHERE room_id=?').get(row.id) as
      { ydoc_state?: Buffer } | undefined;
    if (saved?.ydoc_state) Y.applyUpdate(doc, saved.ydoc_state);
    const r: Room = {
      row,
      doc,
      awareness,
      members: new Map(),
      hostId: null,
      hostPending: null,
      updateCount: 0,
      recentlyLeft: new Map(),
      passcodeQueue: Promise.resolve(),
      pendingEdits: new Map(),
      lastSnapshotAuditTs: -Infinity,
      contentChangedSinceLastAudit: false,
      idleSince: null,
    };
    const ytext = doc.getText('content');
    ytext.observe((event, transaction) => {
      if (transaction.origin instanceof WebSocket) {
        const originWs = transaction.origin;
        const member = Array.from(r.members.values()).find((m) => m.socket === originWs);
        if (member) {
          let pos = 0;
          let minPos = Infinity;
          let maxPos = -Infinity;
          for (const op of event.delta) {
            if (op.retain) {
              pos += op.retain;
            }
            if (op.insert) {
              const len = typeof op.insert === 'string' ? op.insert.length : 1;
              minPos = Math.min(minPos, pos);
              maxPos = Math.max(maxPos, pos + len);
              pos += len;
            }
            if (op.delete) {
              minPos = Math.min(minPos, pos);
              maxPos = Math.max(maxPos, pos);
            }
          }
          if (minPos !== Infinity) {
            const textStr = ytext.toString();
            const getLine = (index: number) => {
              let line = 1;
              const limit = Math.min(index, textStr.length);
              for (let i = 0; i < limit; i++) {
                if (textStr[i] === '\n') line++;
              }
              return line;
            };
            const fromLine = getLine(minPos);
            const toLine = Math.max(fromLine, getLine(maxPos));
            const existingEdit = r.pendingEdits.get(member.id);
            if (existingEdit) {
              existingEdit.fromLine = Math.min(existingEdit.fromLine, fromLine);
              existingEdit.toLine = Math.max(existingEdit.toLine, toLine);
            } else {
              const timer = setTimeout(() => {
                flushUserEdit(r, member.id);
              }, config.editCoalesceMs);
              r.pendingEdits.set(member.id, { fromLine, toLine, timer });
            }
          }
        }
      }
    });
    doc.on('update', (update: Uint8Array, origin: any) => {
      r.contentChangedSinceLastAudit = true;
      if (origin instanceof WebSocket) {
        const frame = encodeSyncUpdate(update);
        for (const m of r.members.values()) {
          if (m.connected && m.socket !== origin && m.socket.readyState === WebSocket.OPEN) {
            safeSend(m.socket, frame);
          }
        }
      }
      schedule(r);
    });
    rooms.set(row.id, r);
    return r;
  };
  const issueTicket = (
    roomId: string,
    clientId: string,
    displayName: string,
    admitted: boolean,
    isCreator: boolean,
  ) => {
    const iat = now();
    return token(config.sessionSecret, {
      roomId,
      clientId,
      displayName,
      admitted,
      isCreator,
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
    if (isKicked(id, clientId)) return false;
    const p = raw ? verifyToken(config.sessionSecret, raw) : null;
    return (
      !!p && p.kind === 'session' && p.roomId === id && p.clientId === clientId && p.exp > now()
    );
  };
  const validCreator = (raw: string | undefined, row: RoomRow) =>
    !!raw && safeEqual(sha(raw), row.creator_key_hash);
  const ip = (req: any) => req.ip ?? 'unknown';
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
  app.register(compress);
  app.register(cors, { origin: config.clientOrigin });

  const possibleClientDirs = [
    config.clientDistPath,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist'),
    resolve(process.cwd(), 'client/dist'),
    resolve(process.cwd(), '../client/dist'),
    '/app/client/dist',
  ].filter(Boolean) as string[];
  const clientDist = possibleClientDirs.find((d) => existsSync(d)) ?? possibleClientDirs[0];

  if (existsSync(clientDist)) {
    app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      wildcard: false,
      setHeaders: (res, path) => {
        if (path.includes('/assets/') || path.includes('\\assets\\')) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (path.endsWith('index.html')) {
          res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url || req.url || '';
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const indexPath = resolve(clientDist, 'index.html');
    if (existsSync(indexPath) && typeof reply.sendFile === 'function') {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'carrel-server' }));
  app.get('/health', async () => ({ ok: true, service: 'carrel-server' }));
  app.post('/api/test/restart', async (req, reply) => {
    if (process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
      return reply.code(404).send({ error: 'not_found' });
    }
    for (const r of rooms.values()) {
      if (r.saveTimer) clearTimeout(r.saveTimer);
      if (r.hostPending?.timer) clearTimeout(r.hostPending.timer);
      for (const edit of r.pendingEdits.values()) clearTimeout(edit.timer);
      save(r);
      for (const m of r.members.values()) {
        try {
          m.socket.close(1001, 'server restarting');
        } catch {}
      }
      r.awareness.destroy();
      r.doc.destroy();
    }
    rooms.clear();
    ipRoomCreations.clear();
    return { ok: true };
  });
  app.get('/api/rooms/check', async (req, reply) => {
    const parsed = z.object({ id: roomIdSchema }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_room_id' });
    return { available: !db.prepare('SELECT 1 FROM rooms WHERE id=?').get(parsed.data.id) };
  });
  app.post('/api/rooms', async (req, reply) => {
    const totalRoomsRow = db.prepare('SELECT COUNT(*) as count FROM rooms').get() as {
      count: number;
    };
    if (totalRoomsRow.count >= config.maxRooms) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    const clientIp = req.ip || '127.0.0.1';
    const windowStart = now() - 3600000;
    const history = (ipRoomCreations.get(clientIp) || []).filter((ts) => ts > windowStart);
    if (history.length >= config.roomsPerIpPerHour) {
      ipRoomCreations.set(clientIp, history);
      return reply.code(429).send({ error: 'rate_limited' });
    }
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data as CreateRoom;
    const id = body.id ?? generatedRoomId(db);
    if (db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id))
      return reply.code(409).send({ error: 'room_unavailable' });
    const creatorKey = b64(randomBytes(32));
    const salt = body.passcode ? randomBytes(16) : null;
    const passHash = body.passcode && salt ? await hashPasscode(body.passcode, salt) : null;
    const t = now();
    db.prepare(
      'INSERT INTO rooms(id,passcode_hash,salt,creator_key_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run(id, passHash, salt, sha(creatorKey), t, t);
    history.push(t);
    ipRoomCreations.set(clientIp, history);
    return reply.code(201).send({
      roomId: id,
      id,
      creatorKey,
      ticket: issueTicket(id, body.clientId, body.displayName, true, true),
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
    if (isKicked(id, body.clientId)) {
      return reply.code(403).send({ error: 'kicked' });
    }
    const cooldownUntil = rateLimitCooldowns.get(`${id}:${body.clientId}`);
    if (cooldownUntil && cooldownUntil > now()) {
      const retryAfterSec = Math.max(1, Math.ceil((cooldownUntil - now()) / 1000));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSec });
    }
    const k = rateKey(req, id);
    const retry = rate(k);
    if (retry) return reply.code(429).send({ error: 'rate_limited', retryAfterSec: retry });
    const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as RoomRow | undefined;
    let credentials = false;
    if (row) {
      const sessionOk = validSession(body.sessionToken, id, body.clientId);
      const creatorOk = validCreator(body.creatorKey, row);
      const passOk =
        row.passcode_hash && row.salt && body.passcode
          ? safeEqual(row.passcode_hash, await hashPasscode(body.passcode, row.salt))
          : !row.passcode_hash;
      credentials = !!(sessionOk || creatorOk || passOk);
    } else await hashPasscode(body.passcode ?? 'dummy', dummySalt);
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
    const r = getRoom(row);
    const hasConnectedMembers = Array.from(r.members.values()).some((m) => m.connected);
    if (row.locked && !session && !(creator && !hasConnectedMembers)) {
      return reply.code(423).send({ error: 'room_locked' });
    }
    if (r.members.size >= config.maxPeersPerRoom && !r.members.has(body.clientId))
      return reply.code(409).send({ error: 'room_full' });
    return {
      roomId: id,
      ticket: issueTicket(id, body.clientId, body.displayName, true, creator),
      sessionToken: issueSession(id, body.clientId),
      hasPasscode: !!row.passcode_hash,
    };
  });
  const remove = (r: Room, id: string, ws: WebSocket) => {
    if ('open' in db && !db.open) return;
    if ((ws as any).isReplaced) return;
    const member = r.members.get(id);
    if (!member || member.socket !== ws) return;

    if (typeof (ws as any).flushPending === 'function') {
      try {
        (ws as any).flushPending();
      } catch {}
    }
    flushUserEdit(r, id);

    if (member.role === 'host') {
      if (r.hostPending) return;
      member.connected = false;
      if (config.hostGraceMs === 0) {
        r.members.delete(id);
        r.recentlyLeft.set(id, {
          name: member.name,
          color: member.color,
          joinedAt: member.joinedAt,
          role: member.role,
          leftAt: now(),
        });
        audit(r, 'left', id);
        runElection(r, 'host_left');
      } else {
        const deadline = now() + config.hostGraceMs;
        r.hostPending = {
          id,
          deadline,
          timer: setTimeout(() => onGraceExpired(r, id), config.hostGraceMs),
        };
        broadcastRoster(r);
        assertRoomInvariants(r);
      }
    } else {
      r.members.delete(id);
      r.recentlyLeft.set(id, {
        name: member.name,
        color: member.color,
        joinedAt: member.joinedAt,
        role: member.role,
        leftAt: now(),
      });
      audit(r, 'left', id);
      broadcastRoster(r);
      if (r.members.size === 0) save(r);
      assertRoomInvariants(r);
    }
    const hasConnected = Array.from(r.members.values()).some((m) => m.connected);
    if (!hasConnected && r.idleSince === null) {
      r.idleSince = now();
    }
  };
  const connect = (ws: WebSocket, payload: any) => {
    const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(payload.roomId) as
      RoomRow | undefined;
    if (!row) return ws.close(CLOSE_CODES.badTicket, 'bad ticket');
    if (isKicked(payload.roomId, payload.clientId)) {
      return ws.close(CLOSE_CODES.kicked, 'kicked');
    }
    const r = getRoom(row);
    r.idleSince = null;
    const hasOtherConnected = Array.from(r.members.values()).some(
      (m) => m.connected && m.id !== payload.clientId,
    );
    if (row.locked && !payload.admitted && !(payload.isCreator && !hasOtherConnected)) {
      return ws.close(CLOSE_CODES.roomLocked, 'room locked');
    }

    const existingMember = r.members.get(payload.clientId);
    let member: Member;

    if (existingMember) {
      const oldWs = existingMember.socket;
      (oldWs as any).isReplaced = true;
      if (typeof (oldWs as any).flushPending === 'function') {
        try {
          (oldWs as any).flushPending();
        } catch {}
      }
      try {
        oldWs.close(4000, 'replaced');
      } catch {}
      existingMember.socket = ws;
      existingMember.connected = true;
      existingMember.lastSeen = now();
      existingMember.missedHeartbeats = 0;
      if (r.hostPending?.id === existingMember.id) {
        if (r.hostPending.timer) clearTimeout(r.hostPending.timer);
        r.hostPending = null;
      }
      if (existingMember.role === 'host') {
        r.hostId = existingMember.id;
      }
      member = existingMember;
      audit(r, 'reconnected', member.id);
    } else {
      if (r.members.size >= config.maxPeersPerRoom)
        return ws.close(CLOSE_CODES.roomFull, 'room full');

      let joinedAt = now();
      let preferredColor: string | undefined;
      const pastInfo = r.recentlyLeft.get(payload.clientId);
      if (pastInfo) {
        if (now() - pastInfo.leftAt <= config.seniorityWindowMs) {
          joinedAt = pastInfo.joinedAt;
          preferredColor = pastInfo.color;
        }
        r.recentlyLeft.delete(payload.clientId);
      }

      const color =
        preferredColor && !Array.from(r.members.values()).some((m) => m.color === preferredColor)
          ? preferredColor
          : (colors.find((c) => !Array.from(r.members.values()).some((m) => m.color === c)) ??
            colors[r.members.size % colors.length]);

      let role: 'host' | 'member' = 'member';
      const hasConnectedMembers = Array.from(r.members.values()).some((m) => m.connected);
      if (!hasConnectedMembers && !r.hostPending && payload.isCreator) {
        role = 'host';
        r.hostId = payload.clientId;
      }

      member = {
        socket: ws,
        id: payload.clientId,
        name: payload.displayName,
        color,
        joinedAt,
        role,
        connected: true,
        lastSeen: now(),
        missedHeartbeats: 0,
      };
      r.members.set(member.id, member);
      audit(r, 'joined', member.id, { name: member.name });

      // Rule 6c: Headless occupied room promotion
      if (r.hostId === null && r.hostPending === null) {
        runElection(r, 'vacant');
      }
    }

    sendAuditHistory(ws, r.row.id);
    control(ws, 'roster', { members: roster(r) });
    control(ws, 'room_updated', {
      language: r.row.language || 'plaintext',
      readonly: !!r.row.readonly,
      locked: !!r.row.locked,
      hasPasscode: !!r.row.passcode_hash,
    });
    broadcastRoster(r);
    assertRoomInvariants(r);
    safeSend(ws, encodeSyncStep1(r.doc));
    const awarenessStates = Array.from(r.awareness.getStates().keys());
    if (awarenessStates.length > 0) {
      safeSend(
        ws,
        encodeAwarenessRaw(awarenessProtocol.encodeAwarenessUpdate(r.awareness, awarenessStates)),
      );
    }

    const updateBucket = new TokenBucket(5, config.rateLimitUpdatesPerSec, () => now());
    const controlBucket = new TokenBucket(
      config.rateLimitControlPerSec,
      config.rateLimitControlPerSec,
      () => now(),
    );
    const syncStep1Bucket = new TokenBucket(2, 2, () => now());
    const ladder = new EscalationLadder(config.throttleWarnMs, config.throttleKickMs, () => now());

    let pendingUpdates: Uint8Array[] = [];
    let pendingBytes = 0;
    let drainTimer: NodeJS.Timeout | null = null;
    let lastControlRateLimitSent = -Infinity;
    const allowedAwarenessIds = new Set<number>();
    let latestAwarenessPayload: Uint8Array | null = null;
    let awarenessTimer: NodeJS.Timeout | null = null;
    let lastAwarenessFlush = 0;

    let lastUpdateSend = -Infinity;

    const flushPendingUpdates = () => {
      if (pendingUpdates.length === 0) return;
      const updates = pendingUpdates;
      pendingUpdates = [];
      pendingBytes = 0;
      try {
        const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
        Y.applyUpdate(r.doc, merged, ws);
      } catch {
        for (const u of updates) {
          try {
            Y.applyUpdate(r.doc, u, ws);
          } catch {}
        }
      }
    };
    (ws as any).flushPending = flushPendingUpdates;

    const minIntervalMs = 1000 / config.rateLimitUpdatesPerSec;

    const scheduleDrain = () => {
      if (drainTimer) return;
      const elapsed = Math.max(0, now() - lastUpdateSend);
      const intervalWait = Math.max(0, minIntervalMs - elapsed);
      const tokenWait = updateBucket.msUntilNextToken();
      const delay = Math.max(10, Math.max(intervalWait, tokenWait));
      drainTimer = setTimeout(() => {
        drainTimer = null;
        drain();
      }, delay);
    };

    const checkLadder = () => {
      const escalation = ladder.checkEscalation();
      if (escalation.level === 'closing') {
        flushPendingUpdates();
        control(ws, 'throttle_notice', {
          level: 'closing',
          message: "You're sending too fast, slowing you down",
          durationMs: escalation.durationMs,
        });
        audit(r, 'rate_limit_disconnect', member.id, {
          durationMs: escalation.durationMs,
          bufferedBytes: pendingBytes,
        });
        rateLimitCooldowns.set(`${r.row.id}:${member.id}`, now() + 5000);
        try {
          ws.close(1008, 'policy violation: rate limit exceeded');
        } catch {}
        return;
      }
      if (escalation.level === 'warning') {
        if (escalation.shouldAuditWarn) {
          audit(r, 'rate_limited', member.id, {
            durationMs: escalation.durationMs,
            bufferedBytes: pendingBytes,
          });
        }
        if (escalation.shouldSendNotice) {
          control(ws, 'throttle_notice', {
            level: 'warning',
            message: "You're sending too fast, slowing you down",
            durationMs: escalation.durationMs,
          });
        }
      }
    };

    const drain = () => {
      drainTimer = null;
      if (pendingUpdates.length === 0) {
        ladder.onBufferDrained(updateBucket.tokens() >= 1);
        checkLadder();
        return;
      }

      const elapsed = Math.max(0, now() - lastUpdateSend);
      if (elapsed < minIntervalMs) {
        scheduleDrain();
        return;
      }

      if (updateBucket.tryTake(1)) {
        lastUpdateSend = now();
        flushPendingUpdates();
        ladder.onBufferDrained(updateBucket.tokens() >= 1);
        checkLadder();
        if (pendingUpdates.length > 0) scheduleDrain();
      } else {
        ladder.onBufferOccupied();
        checkLadder();
        scheduleDrain();
      }
    };

    const flushAwareness = () => {
      awarenessTimer = null;
      if (!latestAwarenessPayload) return;
      const toApply = latestAwarenessPayload;
      latestAwarenessPayload = null;
      lastAwarenessFlush = now();
      try {
        awarenessProtocol.applyAwarenessUpdate(r.awareness, toApply, ws);
        const frame = encodeAwarenessRaw(toApply);
        for (const other of r.members.values()) {
          if (other.socket !== ws && other.socket.readyState === WebSocket.OPEN) {
            safeSend(other.socket, frame);
          }
        }
      } catch {}
    };

    ws.on('pong', () => {
      member.missedHeartbeats = 0;
      member.lastSeen = now();
    });

    ws.on('message', (raw: RawData) => {
      try {
        const data = Buffer.from(raw as Buffer);
        if (!data.length) return;
        member.lastSeen = now();
        const { type, payload } = decodeFrame(data);

        if (type === FRAME_TYPES.sync) {
          if (r.row.readonly && member.role !== 'host') return;
          const dec = decoding.createDecoder(payload);
          const syncType = decoding.readVarUint(dec);

          if (syncType === syncProtocol.messageYjsSyncStep1) {
            if (!syncStep1Bucket.tryTake(1)) return;
            const sv = decoding.readVarUint8Array(dec);
            safeSend(ws, encodeSyncStep2(r.doc, sv));
            return;
          }

          if (
            syncType === syncProtocol.messageYjsSyncStep2 ||
            syncType === syncProtocol.messageYjsUpdate
          ) {
            const updatePayload = decoding.readVarUint8Array(dec);
            if (updatePayload.length === 0) return;

            const scratch = new Y.Doc();
            try {
              Y.applyUpdate(scratch, Y.encodeStateAsUpdate(r.doc));
              Y.applyUpdate(scratch, updatePayload);
              const nextSize = Y.encodeStateAsUpdate(scratch).byteLength;
              if (nextSize > config.maxDocBytes) {
                control(ws, 'error', { code: 'doc_too_large' });
                return;
              }
            } catch {
              return;
            } finally {
              scratch.destroy();
            }

            const minIntervalMs = 1000 / config.rateLimitUpdatesPerSec;
            const isIdle = pendingUpdates.length === 0 && now() - lastUpdateSend >= minIntervalMs;

            if (isIdle && updateBucket.tryTake(1)) {
              lastUpdateSend = now();
              Y.applyUpdate(r.doc, updatePayload, ws);
              ladder.onBufferDrained(updateBucket.tokens() >= 1);
              checkLadder();
            } else {
              if (pendingBytes + updatePayload.length > config.maxBufferBytes) {
                flushPendingUpdates();
                audit(r, 'rate_limit_disconnect', member.id, {
                  reason: 'buffer_overflow',
                  bufferedBytes: pendingBytes,
                });
                rateLimitCooldowns.set(`${r.row.id}:${member.id}`, now() + 5000);
                try {
                  ws.close(1008, 'policy violation: buffer overflow');
                } catch {}
                return;
              }
              pendingUpdates.push(updatePayload);
              pendingBytes += updatePayload.length;
              ladder.onBufferOccupied();
              checkLadder();
              scheduleDrain();
            }
            return;
          }
        } else if (type === FRAME_TYPES.awareness) {
          if (payload.length === 0) return;
          let clientIds: number[];
          try {
            clientIds = getAwarenessClientIDs(payload);
          } catch {
            return;
          }
          if (clientIds.length === 0) return;

          if (allowedAwarenessIds.size === 0) {
            for (const cid of clientIds) allowedAwarenessIds.add(cid);
          } else {
            const hasSpoofed = clientIds.some((cid) => !allowedAwarenessIds.has(cid));
            if (hasSpoofed) return;
          }

          latestAwarenessPayload = payload;
          const timeSinceLast = now() - lastAwarenessFlush;
          if (timeSinceLast >= 100 && !awarenessTimer) {
            flushAwareness();
          } else if (!awarenessTimer) {
            awarenessTimer = setTimeout(flushAwareness, Math.max(10, 100 - timeSinceLast));
          }
        } else if (type === FRAME_TYPES.control) {
          let jsonMsg: any;
          try {
            jsonMsg = JSON.parse(Buffer.from(payload).toString('utf8'));
          } catch {
            control(ws, 'error', { code: 'invalid_control' });
            return;
          }

          if (jsonMsg && jsonMsg.type === 'ping') {
            control(ws, 'pong', jsonMsg.t !== undefined ? { t: jsonMsg.t } : {});
            return;
          }

          if (!controlBucket.tryTake(1)) {
            if (now() - lastControlRateLimitSent >= 1000) {
              lastControlRateLimitSent = now();
              control(ws, 'error', { code: 'rate_limited' });
            }
            return;
          }

          const parsed = controlMessageSchema.safeParse(jsonMsg);
          if (!parsed.success) {
            control(ws, 'error', { code: 'invalid_control' });
            return;
          }
          const msg = parsed.data;
          if (msg.type === 'audit_more') {
            sendAuditHistory(ws, r.row.id, msg.beforeId);
            return;
          }

          if (
            msg.type === 'set_language' ||
            msg.type === 'set_readonly' ||
            msg.type === 'set_locked' ||
            msg.type === 'set_passcode' ||
            msg.type === 'remove_passcode' ||
            msg.type === 'make_host' ||
            msg.type === 'kick'
          ) {
            if (member.role !== 'host' || r.hostPending !== null) {
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
              broadcastRoomUpdated(r);
            } else if (msg.type === 'set_readonly') {
              r.row.readonly = msg.value ? 1 : 0;
              db.prepare('UPDATE rooms SET readonly=?,updated_at=? WHERE id=?').run(
                r.row.readonly,
                now(),
                r.row.id,
              );
              audit(r, 'readonly_changed', member.id, { readonly: !!r.row.readonly });
              broadcastRoomUpdated(r);
            } else if (msg.type === 'set_locked') {
              const isLocked = msg.value !== undefined ? msg.value : !!msg.locked;
              r.row.locked = isLocked ? 1 : 0;
              db.prepare('UPDATE rooms SET locked=?,updated_at=? WHERE id=?').run(
                r.row.locked,
                now(),
                r.row.id,
              );
              audit(r, isLocked ? 'room_locked' : 'room_unlocked', member.id);
              broadcastRoomUpdated(r);
            } else if (msg.type === 'set_passcode') {
              const passcode = msg.passcode;
              const currentHostId = member.id;
              r.passcodeQueue = r.passcodeQueue
                .then(async () => {
                  const salt = randomBytes(16);
                  const passHash = await hashPasscode(passcode, salt);
                  if (
                    r.hostId !== currentHostId ||
                    member.role !== 'host' ||
                    r.hostPending !== null ||
                    member.socket !== ws
                  ) {
                    return;
                  }
                  r.row.passcode_hash = passHash;
                  r.row.salt = salt;
                  db.prepare(
                    'UPDATE rooms SET passcode_hash=?, salt=?, updated_at=? WHERE id=?',
                  ).run(passHash, salt, now(), r.row.id);
                  audit(r, 'passcode_changed', currentHostId);
                  broadcastRoomUpdated(r);
                })
                .catch(() => {});
            } else if (msg.type === 'remove_passcode') {
              r.row.passcode_hash = null;
              r.row.salt = null;
              db.prepare(
                'UPDATE rooms SET passcode_hash=NULL, salt=NULL, updated_at=? WHERE id=?',
              ).run(now(), r.row.id);
              audit(r, 'passcode_removed', member.id);
              broadcastRoomUpdated(r);
            } else if (msg.type === 'kick') {
              const target = r.members.get(msg.clientId);
              if (target && target.id !== member.id) {
                kicked.set(`${r.row.id}:${msg.clientId}`, now() + config.kickBanMs);
                audit(r, 'kicked', member.id, { targetId: msg.clientId, targetName: target.name });
                target.socket.close(CLOSE_CODES.kicked, 'kicked by host');
              }
            } else if (msg.type === 'make_host') {
              const target = r.members.get(msg.clientId);
              if (!target || !target.connected || target.id === member.id) {
                control(ws, 'error', { code: 'target_gone' });
                return;
              }
              member.role = 'member';
              target.role = 'host';
              r.hostId = target.id;
              broadcastRoleChanged(r, {
                clientId: target.id,
                role: 'host',
                previousHostId: member.id,
                reason: 'handover',
              });
              broadcastRoster(r);
              audit(r, 'host_changed', member.id, {
                from: member.id,
                to: target.id,
                reason: 'handover',
              });
              assertRoomInvariants(r);
            }
          }
        } else {
          control(ws, 'error', { code: 'malformed_frame' });
        }
      } catch {
        control(ws, 'error', { code: 'malformed_frame' });
      }
    });

    const cleanupWs = () => {
      if (drainTimer) clearTimeout(drainTimer);
      if (awarenessTimer) clearTimeout(awarenessTimer);
      if (allowedAwarenessIds.size > 0) {
        try {
          awarenessProtocol.removeAwarenessStates(r.awareness, Array.from(allowedAwarenessIds), ws);
        } catch {}
      }
      remove(r, member.id, ws);
    };
    ws.on('close', cleanupWs);
    ws.on('error', cleanupWs);
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

  (app as any).evictIdleRooms = () => evictIdleRooms(now());
  (app as any).closeCarrel = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(cleanup);
    for (const r of rooms.values()) {
      if (r.saveTimer) clearTimeout(r.saveTimer);
      if (r.hostPending?.timer) clearTimeout(r.hostPending.timer);
      for (const userId of Array.from(r.pendingEdits.keys())) {
        flushUserEdit(r, userId);
      }
      for (const edit of r.pendingEdits.values()) clearTimeout(edit.timer);
      save(r);
      for (const m of r.members.values()) {
        try {
          m.socket.close(1001, 'server shutdown');
        } catch {}
      }
      try {
        r.awareness.destroy();
      } catch {}
      try {
        r.doc.destroy();
      } catch {}
    }
    rooms.clear();
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
  process.on('uncaughtException', (err) => {
    console.error('Process uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Process unhandledRejection:', reason);
  });
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
