import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  decodeFrame,
  encodeAwareness,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  FRAME_TYPES,
  getAwarenessClientIDs,
} from './frames.js';

describe('Shared framing round-trip', () => {
  it('encodes and decodes sync updates accurately without double varuint', () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    doc1.getText('text').insert(0, 'hello carrel');
    const update = Y.encodeStateAsUpdate(doc1);

    const frame = encodeSyncUpdate(update);
    expect(frame[0]).toBe(FRAME_TYPES.sync);

    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe(FRAME_TYPES.sync);

    const decoder = decoding.createDecoder(decoded.payload);
    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, encoder, doc2, 'remote');

    expect(doc2.getText('text').toString()).toBe('hello carrel');
  });

  it('encodes and decodes sync step1 and step2', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText('text').insert(0, 'step sync');

    // Step 1
    const step1Frame = encodeSyncStep1(docB);
    expect(step1Frame[0]).toBe(FRAME_TYPES.sync);
    const decoded1 = decodeFrame(step1Frame);

    const dec1 = decoding.createDecoder(decoded1.payload);
    const enc1 = encoding.createEncoder();
    syncProtocol.readSyncMessage(dec1, enc1, docA, 'remote');
    // Step 2 using encodeSyncStep2 helper
    const step2Frame = encodeSyncStep2(docA, Y.encodeStateVector(docB));
    expect(step2Frame[0]).toBe(FRAME_TYPES.sync);
    const decoded2 = decodeFrame(step2Frame);
    const dec2 = decoding.createDecoder(decoded2.payload);
    const enc2 = encoding.createEncoder();
    syncProtocol.readSyncMessage(dec2, enc2, docB, 'remote');

    expect(docB.getText('text').toString()).toBe('step sync');
  });

  it('encodes, decodes, and inspects awareness updates', () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState({ user: { id: 'u1', name: 'Alice' }, status: 'active' });

    const frame = encodeAwareness(awareness, [awareness.clientID]);
    expect(frame[0]).toBe(FRAME_TYPES.awareness);

    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe(FRAME_TYPES.awareness);

    const clientIds = getAwarenessClientIDs(decoded.payload);
    expect(clientIds).toEqual([awareness.clientID]);

    const doc2 = new Y.Doc();
    const awareness2 = new awarenessProtocol.Awareness(doc2);
    awarenessProtocol.applyAwarenessUpdate(awareness2, decoded.payload, 'remote');

    const state = awareness2.getStates().get(awareness.clientID);
    expect(state).toEqual({ user: { id: 'u1', name: 'Alice' }, status: 'active' });
  });

  it('encodes and decodes control JSON messages', () => {
    const msg = { type: 'ping', t: 123456789 };
    const frame = encodeControl(msg);
    expect(frame[0]).toBe(FRAME_TYPES.control);

    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe(FRAME_TYPES.control);

    const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
    expect(parsed).toEqual(msg);
  });
});
