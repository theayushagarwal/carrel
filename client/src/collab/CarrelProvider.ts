import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  encodeControl,
  encodeSyncStep1,
  encodeSyncUpdate,
  encodeAwarenessRaw,
  decodeFrame,
  FRAME_TYPES,
  type PresenceState,
  type RosterMember,
} from '@carrel/shared';

export type ProviderStatus = 'connecting' | 'synced' | 'reconnecting' | 'offline' | 'closed';

export type ThrottleNotice = {
  level: 'warning' | 'closing';
  message: string;
  durationMs?: number;
};

export type CarrelEventMap = {
  roster: { members: RosterMember[] };
  audit: {
    id?: number;
    ts?: number;
    event: string;
    actorId?: string;
    actorName?: string;
    actorColor?: string;
    [key: string]: unknown;
  };
  audit_history: { events: any[]; hasMore: boolean };
  role_changed: {
    clientId: string;
    role: 'host' | 'member';
    previousHostId?: string | null;
    reason?: string;
  };
  error: { code: string; [key: string]: unknown };
  kicked: { reason?: string };
  room_updated: {
    language: string;
    readonly: boolean;
    locked?: boolean;
    hasPasscode?: boolean;
  };
  pong: { t?: number };
  status: { status: ProviderStatus };
  throttle_notice: ThrottleNotice;
  auth_failed: { error: string };
  room_full: Record<string, never>;
  room_locked: Record<string, never>;
  replaced: Record<string, never>;
  rate_limited: { retryAfterSec?: number };
};
export type CarrelEventName = keyof CarrelEventMap;

class TypedEmitter {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  on<K extends CarrelEventName>(event: K, listener: (payload: CarrelEventMap[K]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (payload: unknown) => void);
  }
  emit<K extends CarrelEventName>(event: K, payload: CarrelEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
  clear() {
    this.listeners.clear();
  }
}

export class ClientTokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  private currentTokens: number;
  private lastRefill: number;
  private readonly clock: () => number;

  constructor(capacity: number, refillPerSec: number, clock: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.clock = clock;
    this.currentTokens = capacity;
    this.lastRefill = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsedMs = Math.max(0, now - this.lastRefill);
    if (elapsedMs > 0) {
      const added = (elapsedMs / 1000) * this.refillPerSec;
      this.currentTokens = Math.min(this.capacity, this.currentTokens + added);
      this.lastRefill = now;
    }
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.currentTokens >= count) {
      this.currentTokens -= count;
      return true;
    }
    return false;
  }

  tokens(): number {
    this.refill();
    return this.currentTokens;
  }

  msUntilNextToken(): number {
    this.refill();
    if (this.currentTokens >= 1) return 0;
    const needed = 1 - this.currentTokens;
    return Math.max(0, Math.ceil((needed / this.refillPerSec) * 1000));
  }
}

export type TicketResult =
  | { ticket: string; [key: string]: unknown }
  | { error: string; retryAfterSec?: number; [key: string]: unknown };

export type CarrelProviderOptions = {
  roomId: string;
  getTicket: () => Promise<TicketResult>;
  wsBaseUrl: string;
  doc?: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  clock?: () => number;
};

const REMOTE_ORIGIN = 'remote';

export function computeBackoff(
  attempt: number,
  wasRateLimited = false,
  randomFn = Math.random,
): number {
  const base = Math.min(10000, 500 * 2 ** attempt);
  let delay = base / 2 + randomFn() * (base / 2);
  if (wasRateLimited) {
    delay = Math.max(5000, delay);
  }
  return Math.round(delay);
}

export class CarrelProvider extends TypedEmitter {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly roomId: string;
  readonly wsBaseUrl: string;
  readonly getTicket: () => Promise<TicketResult>;

  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(status: ProviderStatus) => void>();
  private destroyed = false;
  private _status: ProviderStatus = 'connecting';

  attempt = 0;
  nextRetryAt: number | null = null;
  latencyMs = 0;
  pending = 0;

  private readonly clock: () => number;
  private readonly updateBucket: ClientTokenBucket;
  private pendingUpdates: Uint8Array[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateSend = -Infinity;

  private latestAwarenessPayload: Uint8Array | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAwarenessSend = -Infinity;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private lastPingSent = 0;
  private visibilityPongTimeout: ReturnType<typeof setTimeout> | null = null;
  private wasRateLimited = false;

  constructor(
    urlOrOptions: string | CarrelProviderOptions,
    doc = new Y.Doc(),
    awareness = new awarenessProtocol.Awareness(doc),
  ) {
    super();

    if (typeof urlOrOptions === 'string') {
      const parsedUrl = new URL(urlOrOptions);
      const ticketParam = parsedUrl.searchParams.get('ticket') ?? '';
      this.roomId = parsedUrl.pathname.split('/').filter(Boolean).pop() ?? 'room';
      this.wsBaseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
      this.getTicket = async () => ({ ticket: ticketParam });
      this.clock = Date.now;
      this.doc = doc;
      this.awareness = awareness;
    } else {
      this.roomId = urlOrOptions.roomId;
      this.wsBaseUrl = urlOrOptions.wsBaseUrl;
      this.getTicket = urlOrOptions.getTicket;
      this.clock = urlOrOptions.clock ?? Date.now;
      this.doc = urlOrOptions.doc ?? doc;
      this.awareness = urlOrOptions.awareness ?? awareness;
    }

    this.updateBucket = new ClientTokenBucket(4, 4, this.clock);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisibilityChange);

      (window as any).__carrel = {
        ...(window as any).__carrel,
        provider: this,
        dropSocket: () => {
          if (this.socket) {
            try {
              this.socket.close();
            } catch {}
          }
        },
      };
    }

    this.connect();
  }

  get status() {
    return this._status;
  }

  private setStatus(status: ProviderStatus) {
    if (this._status === status) return;
    this._status = status;
    if (status === 'synced') {
      this.attempt = 0;
      this.pending = 0;
      this.wasRateLimited = false;
      this.nextRetryAt = null;
    }
    this.statusListeners.forEach((listener) => listener(status));
    this.emit('status', { status });
  }

  onStatusChange(listener: (status: ProviderStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  retryNow() {
    if (this.destroyed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAt = null;
    this.connect();
  }

  private onOffline = () => {
    if (this.destroyed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAt = null;
    this.setStatus('offline');
  };

  private onOnline = () => {
    if (this.destroyed) return;
    if (this._status === 'offline') {
      this.connect();
    }
  };

  private onVisibilityChange = () => {
    if (this.destroyed || typeof document === 'undefined') return;
    if (document.visibilityState === 'visible' && this.socket?.readyState === WebSocket.OPEN) {
      this.sendPing();
      if (this.visibilityPongTimeout) clearTimeout(this.visibilityPongTimeout);
      this.visibilityPongTimeout = setTimeout(() => {
        this.visibilityPongTimeout = null;
        if (this.socket?.readyState === WebSocket.OPEN && this.missedPings >= 1) {
          try {
            this.socket.close();
          } catch {}
        }
      }, 3000);
    }
  };

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN || this.destroyed) return;

    if (this._status !== 'synced') {
      this.pending++;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const minIntervalMs = 1000 / this.updateBucket.refillPerSec; // 250ms
    const isIdle =
      this.pendingUpdates.length === 0 && this.clock() - this.lastUpdateSend >= minIntervalMs;

    if (isIdle && this.updateBucket.tryTake(1)) {
      this.lastUpdateSend = this.clock();
      this.send(encodeSyncUpdate(update));
    } else {
      this.pendingUpdates.push(update);
      this.scheduleDrain();
    }
  };

  private scheduleDrain() {
    if (this.drainTimer) return;
    const minIntervalMs = 1000 / this.updateBucket.refillPerSec;
    const elapsed = Math.max(0, this.clock() - this.lastUpdateSend);
    const intervalWait = Math.max(0, minIntervalMs - elapsed);
    const tokenWait = this.updateBucket.msUntilNextToken();
    const delay = Math.max(10, Math.max(intervalWait, tokenWait));

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, delay);
  }

  private drain() {
    if (this.pendingUpdates.length === 0) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingUpdates = [];
      return;
    }

    const minIntervalMs = 1000 / this.updateBucket.refillPerSec;
    const elapsed = Math.max(0, this.clock() - this.lastUpdateSend);
    if (elapsed < minIntervalMs) {
      this.scheduleDrain();
      return;
    }

    if (this.updateBucket.tryTake(1)) {
      this.lastUpdateSend = this.clock();
      const updates = this.pendingUpdates;
      this.pendingUpdates = [];
      try {
        const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
        this.send(encodeSyncUpdate(merged));
      } catch {}
      if (this.pendingUpdates.length > 0) this.scheduleDrain();
    } else {
      this.scheduleDrain();
    }
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_ORIGIN || this.destroyed) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const changed = added.concat(updated, removed);
    const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
    this.latestAwarenessPayload = payload;

    const elapsed = this.clock() - this.lastAwarenessSend;
    if (elapsed >= 100 && !this.awarenessTimer) {
      this.flushAwareness();
    } else if (!this.awarenessTimer) {
      this.awarenessTimer = setTimeout(
        () => {
          this.awarenessTimer = null;
          this.flushAwareness();
        },
        Math.max(10, 100 - elapsed),
      );
    }
  };

  private flushAwareness() {
    if (!this.latestAwarenessPayload) return;
    const payload = this.latestAwarenessPayload;
    this.latestAwarenessPayload = null;
    this.lastAwarenessSend = this.clock();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(encodeAwarenessRaw(payload));
    }
  }

  private sendPing() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.lastPingSent = this.clock();
      this.missedPings++;
      this.sendControl({ type: 'ping', t: this.lastPingSent });
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      if (this.missedPings >= 2) {
        if (this.socket) {
          try {
            this.socket.close();
          } catch {}
        }
        return;
      }
      this.sendPing();
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.visibilityPongTimeout) {
      clearTimeout(this.visibilityPongTimeout);
      this.visibilityPongTimeout = null;
    }
    this.missedPings = 0;
  }

  private async connect() {
    if (this.destroyed) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus('offline');
      return;
    }

    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ticketResult: TicketResult;
    try {
      ticketResult = await this.getTicket();
    } catch {
      this.scheduleRetry();
      return;
    }

    if ('error' in ticketResult) {
      if (ticketResult.error === 'invalid_credentials') {
        this.emit('auth_failed', { error: 'invalid_credentials' });
        this.setStatus('closed');
        return;
      }
      if (ticketResult.error === 'room_full') {
        this.emit('room_full', {});
        this.setStatus('closed');
        return;
      }
      if (ticketResult.error === 'room_locked') {
        this.emit('room_locked', {});
        this.setStatus('closed');
        return;
      }
      if (ticketResult.error === 'rate_limited') {
        this.wasRateLimited = true;
        const retryAfterSec =
          typeof ticketResult.retryAfterSec === 'number' ? ticketResult.retryAfterSec : 5;
        this.emit('rate_limited', { retryAfterSec });
        const waitMs = retryAfterSec * 1000;
        this.scheduleRetry(waitMs);
        return;
      }
      this.scheduleRetry();
      return;
    }

    const { ticket } = ticketResult;
    try {
      const wsUrl = `${this.wsBaseUrl}/ws?ticket=${ticket}`;
      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        this.setStatus('connecting');
        this.startHeartbeat();
        this.send(encodeSyncStep1(this.doc));

        if (this.awareness.getLocalState()) {
          const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.awareness.clientID,
          ]);
          this.send(encodeAwarenessRaw(update));
        }
      };

      socket.onmessage = (event) => {
        const raw = event.data;
        const bytes =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : ArrayBuffer.isView(raw)
              ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
              : new Uint8Array(Buffer.from(raw));
        this.handleFrame(bytes);
      };

      socket.onerror = () => {
        this.emit('error', { code: 'socket_error' });
      };

      socket.onclose = (event) => {
        this.socket = null;
        this.stopHeartbeat();
        this.pendingUpdates = [];
        if (this.drainTimer) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }

        if (this.destroyed) return;

        if (event.code === 4003) {
          this.emit('kicked', { reason: event.reason });
          this.setStatus('closed');
          return;
        }
        if (event.code === 4008) {
          this.emit('room_full', {});
          this.setStatus('closed');
          return;
        }
        if (event.code === 4009) {
          this.emit('room_locked', {});
          this.setStatus('closed');
          return;
        }
        if (event.code === 4000) {
          this.emit('replaced', {});
          this.setStatus('closed');
          return;
        }

        if (event.code === 1008) {
          this.wasRateLimited = true;
          this.emit('rate_limited', { retryAfterSec: 5 });
        }

        this.scheduleRetry();
      };
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(explicitDelay?: number) {
    if (this.destroyed || this.retryTimer) return;
    this.setStatus('reconnecting');
    const delay = explicitDelay ?? computeBackoff(this.attempt, this.wasRateLimited);
    this.attempt++;
    this.nextRetryAt = this.clock() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      this.connect();
    }, delay);
  }

  private handleFrame(frame: Uint8Array) {
    if (!frame.length) return;
    try {
      const { type, payload } = decodeFrame(frame);

      if (type === FRAME_TYPES.sync) {
        try {
          const decoder = decoding.createDecoder(payload);
          const encoder = encoding.createEncoder();
          let syncType = -1;
          this.doc.transact(() => {
            syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN);
          }, REMOTE_ORIGIN);
          const response = encoding.toUint8Array(encoder);
          if (response.length) {
            const out = new Uint8Array(1 + response.length);
            out[0] = FRAME_TYPES.sync;
            out.set(response, 1);
            this.send(out);
          }
          if (
            syncType === syncProtocol.messageYjsSyncStep2 ||
            syncType === syncProtocol.messageYjsUpdate
          ) {
            this.setStatus('synced');
          }
        } catch {
          this.emit('error', { code: 'sync_decode_failed' });
        }
      } else if (type === FRAME_TYPES.awareness) {
        try {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, REMOTE_ORIGIN);
        } catch {
          this.emit('error', { code: 'awareness_decode_failed' });
        }
      } else if (type === FRAME_TYPES.control) {
        try {
          const message = JSON.parse(new TextDecoder().decode(payload));
          if (!message || typeof message.type !== 'string') return;

          if (message.type === 'pong') {
            this.missedPings = 0;
            if (typeof message.t === 'number') {
              const rtt = Math.max(0, this.clock() - message.t);
              this.latencyMs =
                this.latencyMs === 0 ? rtt : Math.round(0.8 * this.latencyMs + 0.2 * rtt);
            }
            this.emit('pong', { t: message.t });
          } else if (message.type === 'throttle_notice') {
            this.emit('throttle_notice', {
              level: message.level,
              message: message.message,
              durationMs: message.durationMs,
            });
          } else if (message.type === 'roster') {
            this.emit('roster', { members: message.members });
          } else if (message.type === 'audit') {
            this.emit('audit', message);
          } else if (message.type === 'audit_history') {
            this.emit('audit_history', message);
          } else if (message.type === 'role_changed') {
            this.emit('role_changed', message);
          } else if (message.type === 'room_updated') {
            this.emit('room_updated', message);
          } else if (message.type === 'error') {
            this.emit('error', message);
          } else if (message.type === 'kicked') {
            this.emit('kicked', message);
          }
        } catch {
          this.emit('error', { code: 'control_decode_failed' });
        }
      }
    } catch {}
  }

  send(frame: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(frame);
      } catch {}
    }
  }

  sendControl(message: Record<string, unknown>) {
    this.send(encodeControl(message));
  }

  loadMoreAudit(beforeId?: number) {
    this.sendControl({ type: 'audit_more', beforeId });
  }

  setPasscode(passcode: string) {
    this.sendControl({ type: 'set_passcode', passcode });
  }

  removePasscode() {
    this.sendControl({ type: 'remove_passcode' });
  }

  setLocked(value: boolean) {
    this.sendControl({ type: 'set_locked', value });
  }

  setReadonly(value: boolean) {
    this.sendControl({ type: 'set_readonly', value });
  }

  setLanguage(language: string) {
    this.sendControl({ type: 'set_language', language });
  }

  kick(targetId: string) {
    this.sendControl({ type: 'kick', targetId });
  }

  makeHost(targetId: string) {
    this.sendControl({ type: 'make_host', targetId });
  }

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.awarenessTimer) {
      clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    this.stopHeartbeat();
    this.pendingUpdates = [];

    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    this.awareness.setLocalState(null);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);

    if (this.socket) {
      try {
        this.socket.close(1000, 'destroyed');
      } catch {}
      this.socket = null;
    }
    this.setStatus('closed');
    this.clear();
    this.statusListeners.clear();
  }
}

export function presenceFromMember(member: RosterMember): PresenceState['user'] {
  return { id: member.id, name: member.name, color: member.color, colorLight: member.color };
}
