import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { PresenceState, RosterMember } from '@carrel/shared';

export type ProviderStatus = 'connecting' | 'synced' | 'reconnecting' | 'closed';
export type CarrelEventMap = {
  roster: { members: RosterMember[] };
  audit: { event: string; actorId: string; [key: string]: unknown };
  role_changed: { clientId: string; role: 'host' | 'member' };
  error: { code: string; [key: string]: unknown };
  kicked: { reason?: string };
  room_updated: { language: string; readonly: boolean };
  pong: Record<string, never>;
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

const FRAME_SYNC = 0;
const FRAME_AWARENESS = 1;
const FRAME_CONTROL = 2;
const REMOTE_ORIGIN = 'remote';

export class CarrelProvider extends TypedEmitter {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(status: ProviderStatus) => void>();
  private destroyed = false;
  private _status: ProviderStatus = 'connecting';
  private readonly url: string;
  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN || this.destroyed) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    syncProtocol.writeUpdate(encoder, update);
    this.send(FRAME_SYNC, encoding.toUint8Array(encoder));
  };
  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_ORIGIN || this.destroyed) return;
    const changed = added.concat(updated, removed);
    this.send(FRAME_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
  };

  constructor(url: string, doc = new Y.Doc(), awareness = new awarenessProtocol.Awareness(doc)) {
    super();
    this.url = url;
    this.doc = doc;
    this.awareness = awareness;
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.connect();
  }

  get status() {
    return this._status;
  }
  private setStatus(status: ProviderStatus) {
    this._status = status;
    this.emit('room_updated', { language: 'plaintext', readonly: false });
  }
  private connect() {
    if (this.destroyed) return;
    try {
      this.setStatus(this._status === 'connecting' ? 'connecting' : 'reconnecting');
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => {
        this.setStatus('connecting');
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep1);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        this.send(FRAME_SYNC, encoding.toUint8Array(encoder));
        if (this.awareness.getLocalState())
          this.send(
            FRAME_AWARENESS,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
          );
      };
      socket.onmessage = (event) => this.handleFrame(new Uint8Array(event.data as ArrayBuffer));
      socket.onerror = () => this.emit('error', { code: 'socket_error' });
      socket.onclose = (event) => {
        this.socket = null;
        if (this.destroyed) return;
        if (event.code === 4003) this.emit('kicked', { reason: event.reason });
        this.setStatus('reconnecting');
        this.retryTimer = setTimeout(() => this.connect(), 2000);
      };
    } catch {
      this.emit('error', { code: 'connection_failed' });
      this.retryTimer = setTimeout(() => this.connect(), 2000);
    }
  }
  private handleFrame(frame: Uint8Array) {
    if (!frame.length) return;
    const type = frame[0];
    const payload = frame.slice(1);
    if (type === FRAME_SYNC) {
      try {
        const decoder = decoding.createDecoder(payload);
        const encoder = encoding.createEncoder();
        this.doc.transact(
          () => syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN),
          REMOTE_ORIGIN,
        );
        const response = encoding.toUint8Array(encoder);
        if (response.length) this.send(FRAME_SYNC, response);
        this.setStatus('synced');
      } catch {
        this.emit('error', { code: 'sync_decode_failed' });
      }
    } else if (type === FRAME_AWARENESS) {
      try {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, REMOTE_ORIGIN);
      } catch {
        this.emit('error', { code: 'awareness_decode_failed' });
      }
    } else if (type === FRAME_CONTROL) {
      try {
        const message = JSON.parse(new TextDecoder().decode(payload)) as {
          type: CarrelEventName;
          [key: string]: unknown;
        };
        const { type: event, ...rest } = message;
        if (
          event === 'roster' ||
          event === 'audit' ||
          event === 'role_changed' ||
          event === 'error' ||
          event === 'kicked' ||
          event === 'room_updated' ||
          event === 'pong'
        )
          this.emit(event, rest as never);
      } catch {
        this.emit('error', { code: 'control_decode_failed' });
      }
    }
  }
  send(type: number, payload: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(new Uint8Array([type, ...payload]));
  }
  sendControl(message: Record<string, unknown>) {
    this.send(FRAME_CONTROL, new TextEncoder().encode(JSON.stringify(message)));
  }
  destroy() {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.awareness.setLocalState(null);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.socket?.close(1000, 'destroyed');
    this.socket = null;
    this.setStatus('closed');
    this.clear();
    this.statusListeners.clear();
  }
}

export function presenceFromMember(member: RosterMember): PresenceState['user'] {
  return { id: member.id, name: member.name, color: member.color, colorLight: member.color };
}
