import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const FRAME_TYPES = {
  sync: 0,
  awareness: 1,
  control: 2,
} as const;

export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, doc);
  const payload = encoding.toUint8Array(encoder);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.sync;
  buf.set(payload, 1);
  return buf;
}

export function encodeSyncStep2(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  const payload = encoding.toUint8Array(encoder);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.sync;
  buf.set(payload, 1);
  return buf;
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  const payload = encoding.toUint8Array(encoder);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.sync;
  buf.set(payload, 1);
  return buf;
}

export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clientIds: number[],
): Uint8Array {
  const payload = awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.awareness;
  buf.set(payload, 1);
  return buf;
}

export function encodeAwarenessRaw(payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.awareness;
  buf.set(payload, 1);
  return buf;
}

export function encodeControl(obj: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = FRAME_TYPES.control;
  buf.set(payload, 1);
  return buf;
}

export function decodeFrame(bytes: Uint8Array): { type: number; payload: Uint8Array } {
  if (!bytes || bytes.length === 0) {
    throw new Error('Empty frame');
  }
  return {
    type: bytes[0],
    payload: bytes.subarray(1),
  };
}

export function getAwarenessClientIDs(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
    ids.push(clientID);
  }
  return ids;
}
