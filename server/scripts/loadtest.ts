import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { buildApp } from '../src/index.js';
import {
  encodeControl,
  encodeSyncStep1,
  encodeSyncUpdate,
  encodeAwarenessRaw,
  decodeFrame,
  FRAME_TYPES,
} from '@carrel/shared';

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const targetUrl = getArg('--url', '');
const spamRate = Number.parseInt(getArg('--rate', '200'), 10);
const sustainedDuration = Number.parseInt(getArg('--duration', '15'), 10);
const observerCount = Number.parseInt(getArg('--observers', '3'), 10);

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

async function main() {
  console.log('=====================================================');
  console.log('CARREL PHASE 4 LOAD TEST');
  console.log(
    `Rate: ${spamRate}/s | Duration: ${sustainedDuration}s | Observers: ${observerCount}`,
  );
  console.log('=====================================================\n');

  let serverApp: ReturnType<typeof buildApp> | null = null;
  let tempDir = '';
  let httpBaseUrl = targetUrl;
  let wsBaseUrl = '';

  const startCpu = process.cpuUsage();
  const elDelay = monitorEventLoopDelay({ resolution: 20 });
  elDelay.enable();

  if (!httpBaseUrl) {
    tempDir = mkdtempSync(join(tmpdir(), 'carrel-loadtest-'));
    serverApp = buildApp({
      port: 0,
      clientOrigin: '*',
      databasePath: join(tempDir, 'loadtest.db'),
      sessionSecret: 'loadtest-session-secret-01234567890123456789',
      hostGraceMs: 5000,
      maxDocBytes: 1048576,
      maxPeersPerRoom: 7,
      ticketTtlMs: 60000,
      sessionTtlMs: 86400000,
      rateLimitUpdatesPerSec: 5,
      rateLimitControlPerSec: 2,
      throttleWarnMs: 3000,
      throttleKickMs: 10000,
      heartbeatMs: 15000,
      maxBufferBytes: 524288,
    });
    await serverApp.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (serverApp.app.server.address() as any).port;
    httpBaseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
  } else {
    wsBaseUrl = httpBaseUrl.replace(/^http/, 'ws');
  }

  async function apiPost(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${httpBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  const results: any = {
    timestamp: new Date().toISOString(),
    config: { spamRate, sustainedDuration, observerCount, targetUrl: httpBaseUrl },
    scenarios: {},
  };

  try {
    // =========================================================================
    // SCENARIO 0: BASELINE (3 observers, 1 typist at 5 chars/s for 10s)
    // =========================================================================
    console.log('[Scenario 0: Baseline] Running 10s baseline test...');
    elDelay.reset();
    const s0RoomId = `s0-room-${Date.now()}`;
    const s0Create = await apiPost('/api/rooms', {
      id: s0RoomId,
      displayName: 'Creator',
      clientId: 's0-creator',
    });
    const s0CreatorTicket = s0Create.data.ticket;

    // Connect observers
    const s0Observers: { ws: WebSocket; latencies: number[]; doc: Y.Doc }[] = [];
    for (let i = 0; i < observerCount; i++) {
      const joinRes = await apiPost(`/api/rooms/${s0RoomId}/join`, {
        displayName: `Observer-${i}`,
        clientId: `s0-obs-${i}`,
      });
      const obsWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${joinRes.data.ticket}`);
      const obsDoc = new Y.Doc();
      const latencies: number[] = [];

      obsWs.on('message', (raw) => {
        const frame = decodeFrame(Buffer.from(raw as Buffer));
        if (frame.type === FRAME_TYPES.control) {
          const msg = JSON.parse(Buffer.from(frame.payload).toString());
          if (msg.type === 'pong' && typeof msg.t === 'number') {
            latencies.push(Date.now() - msg.t);
          }
        } else if (frame.type === FRAME_TYPES.sync) {
          syncProtocol.readSyncMessage(
            decoding.createDecoder(frame.payload),
            encoding.createEncoder(),
            obsDoc,
            'remote',
          );
        }
      });
      await new Promise((r) => obsWs.once('open', r));
      s0Observers.push({ ws: obsWs, latencies, doc: obsDoc });
    }

    // Connect typist
    const typistWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${s0CreatorTicket}`);
    await new Promise((r) => typistWs.once('open', r));
    const typistDoc = new Y.Doc();
    let typistUpdate: Uint8Array = new Uint8Array();
    typistDoc.on('update', (u) => (typistUpdate = u));

    // Type 5 chars/s for 10s (50 chars, spaced 200ms)
    for (let i = 0; i < 50; i++) {
      typistDoc.getText('content').insert(i, String.fromCharCode(97 + (i % 26)));
      typistWs.send(encodeSyncUpdate(typistUpdate));

      // Ping from observers to measure latency
      for (const obs of s0Observers) {
        obs.ws.send(encodeControl({ type: 'ping', t: Date.now() }));
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    await new Promise((r) => setTimeout(r, 500));
    const s0AllLatencies = s0Observers.flatMap((o) => o.latencies);
    const s0Baseline = {
      latency_p50_ms: percentile(s0AllLatencies, 50),
      latency_p95_ms: percentile(s0AllLatencies, 95),
      latency_p99_ms: percentile(s0AllLatencies, 99),
      event_loop_delay_p99_ms: Number((elDelay.percentile(99) / 1e6).toFixed(2)),
    };
    results.scenarios.S0_baseline = s0Baseline;
    console.log('  -> S0 Baseline completed:', s0Baseline);

    typistWs.close();
    for (const obs of s0Observers) obs.ws.close();

    // =========================================================================
    // SCENARIO 1: BURST (1 spammer 200/s for 5s while observers type)
    // =========================================================================
    console.log('\n[Scenario 1: Burst] Running 5s burst test (200 updates/s)...');
    elDelay.reset();
    const s1RoomId = `s1-room-${Date.now()}`;
    const s1Create = await apiPost('/api/rooms', {
      id: s1RoomId,
      displayName: 'Creator',
      clientId: 's1-creator',
    });
    const s1CreatorTicket = s1Create.data.ticket;

    // Connect observers
    const s1Observers: {
      ws: WebSocket;
      latencies: number[];
      doc: Y.Doc;
      syncFrameTimestamps: number[];
    }[] = [];
    for (let i = 0; i < observerCount; i++) {
      const joinRes = await apiPost(`/api/rooms/${s1RoomId}/join`, {
        displayName: `Observer-${i}`,
        clientId: `s1-obs-${i}`,
      });
      const obsWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${joinRes.data.ticket}`);
      const obsDoc = new Y.Doc();
      const latencies: number[] = [];
      const syncFrameTimestamps: number[] = [];

      obsWs.on('message', (raw) => {
        const frame = decodeFrame(Buffer.from(raw as Buffer));
        if (frame.type === FRAME_TYPES.control) {
          const msg = JSON.parse(Buffer.from(frame.payload).toString());
          if (msg.type === 'pong' && typeof msg.t === 'number') {
            latencies.push(Date.now() - msg.t);
          }
        } else if (frame.type === FRAME_TYPES.sync) {
          syncFrameTimestamps.push(Date.now());
          syncProtocol.readSyncMessage(
            decoding.createDecoder(frame.payload),
            encoding.createEncoder(),
            obsDoc,
            'remote',
          );
        }
      });
      await new Promise((r) => obsWs.once('open', r));
      s1Observers.push({ ws: obsWs, latencies, doc: obsDoc, syncFrameTimestamps });
    }

    // Connect spammer
    const spammerWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${s1CreatorTicket}`);
    await new Promise((r) => spammerWs.once('open', r));
    const spammerDoc = new Y.Doc();
    const spammerUpdates: Uint8Array[] = [];
    spammerDoc.on('update', (u) => spammerUpdates.push(u));

    // Generate 1000 characters (200/s * 5s)
    for (let i = 0; i < 1000; i++) {
      spammerDoc.getText('content').insert(i, String.fromCharCode(65 + (i % 26)));
    }

    // Send 200 updates per second for 5 seconds
    let sentCount = 0;
    const batchInterval = 50; // every 50ms send 10 updates
    const updatesPerBatch = 10;
    for (let t = 0; t < 100; t++) {
      for (let j = 0; j < updatesPerBatch; j++) {
        if (sentCount < spammerUpdates.length) {
          spammerWs.send(encodeSyncUpdate(spammerUpdates[sentCount++]));
        }
      }
      // Observer pings
      for (const obs of s1Observers) {
        obs.ws.send(encodeControl({ type: 'ping', t: Date.now() }));
      }
      await new Promise((r) => setTimeout(r, batchInterval));
    }

    console.log('  -> Spammer sent 1000 updates. Waiting for drain...');
    const s1Expected = spammerDoc.getText('content').toString();
    const s1Deadline = Date.now() + 15000;
    while (
      s1Observers.some((o) => o.doc.getText('content').toString().length < 1000) &&
      Date.now() < s1Deadline
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // Check maximum frames received in any 1s rolling window
    let maxFramesIn1s = 0;
    for (const obs of s1Observers) {
      for (let i = 0; i < obs.syncFrameTimestamps.length; i++) {
        const start = obs.syncFrameTimestamps[i];
        const count = obs.syncFrameTimestamps.filter((t) => t >= start && t < start + 1000).length;
        if (count > maxFramesIn1s) maxFramesIn1s = count;
      }
    }

    const s1AllLatencies = s1Observers.flatMap((o) => o.latencies);
    const s1P95Latency = percentile(s1AllLatencies, 95);
    const s1ELDp99 = Number((elDelay.percentile(99) / 1e6).toFixed(2));
    const s1PassedConvergence = s1Observers.every(
      (o) => o.doc.getText('content').toString() === s1Expected,
    );

    const s1Results = {
      max_frames_per_sec: maxFramesIn1s,
      latency_p95_ms: s1P95Latency,
      event_loop_delay_p99_ms: s1ELDp99,
      convergence: s1PassedConvergence,
      characters_sent: 1000,
      characters_received: s1Observers[0].doc.getText('content').toString().length,
    };
    results.scenarios.S1_burst = s1Results;
    console.log('  -> S1 Burst completed:', s1Results);

    // Assertions for S1
    if (maxFramesIn1s > 6) {
      throw new Error(`S1 Assertion failed: max frames in 1s window (${maxFramesIn1s}) > 6`);
    }
    const maxAllowedLatency = Math.max(2 * s0Baseline.latency_p95_ms, 50);
    if (s1P95Latency > maxAllowedLatency) {
      throw new Error(
        `S1 Assertion failed: observer p95 latency (${s1P95Latency}ms) > max(${maxAllowedLatency}ms)`,
      );
    }
    if (s1ELDp99 >= 50) {
      throw new Error(`S1 Assertion failed: event loop delay p99 (${s1ELDp99}ms) >= 50ms`);
    }
    if (!s1PassedConvergence) {
      throw new Error('S1 Assertion failed: document text on observers did not converge');
    }

    spammerWs.close();
    for (const obs of s1Observers) obs.ws.close();

    // =========================================================================
    // SCENARIO 2: SUSTAINED (Spammer at 200/s for 15s)
    // =========================================================================
    console.log('\n[Scenario 2: Sustained] Running 15s sustained test (200 updates/s)...');
    elDelay.reset();
    const s2RoomId = `s2-room-${Date.now()}`;
    const s2Create = await apiPost('/api/rooms', {
      id: s2RoomId,
      displayName: 'SustainedSpammer',
      clientId: 's2-spammer',
    });
    const s2SpammerTicket = s2Create.data.ticket;
    const s2SessionToken = s2Create.data.sessionToken;

    // Connect observer
    const s2ObsJoin = await apiPost(`/api/rooms/${s2RoomId}/join`, {
      displayName: 'Observer',
      clientId: 's2-obs',
    });
    const s2ObsWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${s2ObsJoin.data.ticket}`);
    const s2ObsDoc = new Y.Doc();
    const s2AuditEvents: string[] = [];

    s2ObsWs.on('message', (raw) => {
      const frame = decodeFrame(Buffer.from(raw as Buffer));
      if (frame.type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(frame.payload).toString());
        if (msg.type === 'audit' && typeof msg.event === 'string') {
          s2AuditEvents.push(msg.event);
        }
      } else if (frame.type === FRAME_TYPES.sync) {
        syncProtocol.readSyncMessage(
          decoding.createDecoder(frame.payload),
          encoding.createEncoder(),
          s2ObsDoc,
          'remote',
        );
      }
    });
    await new Promise((r) => s2ObsWs.once('open', r));

    // Connect spammer
    const s2Ws = new WebSocket(`${wsBaseUrl}/ws?ticket=${s2SpammerTicket}`);
    await new Promise((r) => s2Ws.once('open', r));

    let s2WarningReceivedAt = 0;
    let s2ClosedAt = 0;
    let s2CloseCode = 0;

    s2Ws.on('message', (raw) => {
      const frame = decodeFrame(Buffer.from(raw as Buffer));
      if (frame.type === FRAME_TYPES.control) {
        const msg = JSON.parse(Buffer.from(frame.payload).toString());
        if (msg.type === 'throttle_notice' && msg.level === 'warning' && !s2WarningReceivedAt) {
          s2WarningReceivedAt = Date.now();
        }
      }
    });
    s2Ws.on('close', (code) => {
      s2ClosedAt = Date.now();
      s2CloseCode = code;
    });

    const s2SpammerDoc = new Y.Doc();
    let s2LatestUpdate: Uint8Array = new Uint8Array();
    s2SpammerDoc.on('update', (u) => (s2LatestUpdate = u));

    const s2StartTime = Date.now();
    let spammerChars = 0;

    // Send updates until closed or up to 15s
    while (Date.now() - s2StartTime < 15000 && !s2ClosedAt) {
      for (let k = 0; k < 10; k++) {
        s2SpammerDoc.getText('content').insert(spammerChars++, 'M');
        if (s2Ws.readyState === WebSocket.OPEN) {
          s2Ws.send(encodeSyncUpdate(s2LatestUpdate));
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const warningTimeSec = s2WarningReceivedAt ? (s2WarningReceivedAt - s2StartTime) / 1000 : 0;
    const closeTimeSec = s2ClosedAt ? (s2ClosedAt - s2StartTime) / 1000 : 0;

    console.log(
      `  -> Warning at: ${warningTimeSec.toFixed(2)}s | 1008 Close at: ${closeTimeSec.toFixed(2)}s (Code: ${s2CloseCode})`,
    );

    // Wait out cooldown (5s)
    console.log('  -> Waiting out 5s cooldown...');
    await new Promise((r) => setTimeout(r, 5500));

    // Reconnect spammer
    const s2Rejoin = await apiPost(`/api/rooms/${s2RoomId}/join`, {
      displayName: 'SustainedSpammer',
      clientId: 's2-spammer',
      sessionToken: s2SessionToken,
    });
    if (s2Rejoin.status !== 200) {
      throw new Error(`S2 Rejoin failed with status ${s2Rejoin.status}`);
    }
    const freshTicket = s2Rejoin.data.ticket;

    const s2ReconnectedWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${freshTicket}`);
    await new Promise((r) => s2ReconnectedWs.once('open', r));

    // Sync handshake
    const reconnectedDoc = new Y.Doc();
    s2ReconnectedWs.on('message', (raw) => {
      const frame = decodeFrame(Buffer.from(raw as Buffer));
      if (frame.type === FRAME_TYPES.sync) {
        syncProtocol.readSyncMessage(
          decoding.createDecoder(frame.payload),
          encoding.createEncoder(),
          reconnectedDoc,
          'remote',
        );
      }
    });
    s2ReconnectedWs.send(encodeSyncStep1(reconnectedDoc));
    await new Promise((r) => setTimeout(r, 1000));

    const s2PassedWarning = warningTimeSec >= 2.0 && warningTimeSec <= 4.5;
    const s2PassedClose = closeTimeSec >= 8.5 && closeTimeSec <= 12.0 && s2CloseCode === 1008;
    const s2AuditPassed =
      s2AuditEvents.includes('rate_limited') && s2AuditEvents.includes('rate_limit_disconnect');

    const s2Results = {
      time_to_warning_sec: Number(warningTimeSec.toFixed(2)),
      time_to_close_sec: Number(closeTimeSec.toFixed(2)),
      close_code: s2CloseCode,
      audit_events: s2AuditEvents,
      reconnected_doc_length: reconnectedDoc.getText('content').toString().length,
      observer_doc_length: s2ObsDoc.getText('content').toString().length,
    };
    results.scenarios.S2_sustained = s2Results;
    console.log('  -> S2 Sustained completed:', s2Results);

    if (!s2PassedWarning) {
      throw new Error(
        `S2 Assertion failed: warning received at ${warningTimeSec.toFixed(2)}s (expected ~3s +/- 1s)`,
      );
    }
    if (!s2PassedClose) {
      throw new Error(
        `S2 Assertion failed: close code was ${s2CloseCode} at ${closeTimeSec.toFixed(2)}s (expected 1008 at ~10s +/- 1.5s)`,
      );
    }
    if (!s2AuditPassed) {
      throw new Error(
        `S2 Assertion failed: audit events missing rate_limited or rate_limit_disconnect (saw: ${s2AuditEvents.join(',')})`,
      );
    }

    s2ReconnectedWs.close();
    s2ObsWs.close();

    // =========================================================================
    // SCENARIO 3: AWARENESS FLOOD (500 updates/s for 5s)
    // =========================================================================
    console.log('\n[Scenario 3: Awareness Flood] Running 500 awareness updates/s for 5s...');
    elDelay.reset();
    const s3RoomId = `s3-room-${Date.now()}`;
    const s3Create = await apiPost('/api/rooms', {
      id: s3RoomId,
      displayName: 'Flooder',
      clientId: 's3-flooder',
    });
    const s3ObsJoin = await apiPost(`/api/rooms/${s3RoomId}/join`, {
      displayName: 'Observer',
      clientId: 's3-obs',
    });

    const s3FlooderWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${s3Create.data.ticket}`);
    const s3ObsWs = new WebSocket(`${wsBaseUrl}/ws?ticket=${s3ObsJoin.data.ticket}`);

    await Promise.all([
      new Promise((r) => s3FlooderWs.once('open', r)),
      new Promise((r) => s3ObsWs.once('open', r)),
    ]);

    const s3ObsAwareness = new awarenessProtocol.Awareness(new Y.Doc());
    const s3FrameTimestamps: number[] = [];

    s3ObsWs.on('message', (raw) => {
      const frame = decodeFrame(Buffer.from(raw as Buffer));
      if (frame.type === FRAME_TYPES.awareness) {
        s3FrameTimestamps.push(Date.now());
        awarenessProtocol.applyAwarenessUpdate(s3ObsAwareness, frame.payload, 'remote');
      }
    });

    const s3FlooderAwareness = new awarenessProtocol.Awareness(new Y.Doc());
    const s3Cid = s3FlooderAwareness.clientID;

    // Send 2500 awareness frames (500/s for 5s)
    const s3TotalFrames = 2500;
    const s3BatchSize = 25;
    for (let i = 0; i < s3TotalFrames; i += s3BatchSize) {
      for (let j = 0; j < s3BatchSize; j++) {
        const idx = i + j;
        s3FlooderAwareness.setLocalStateField('cursor', { seq: idx });
        const update = awarenessProtocol.encodeAwarenessUpdate(s3FlooderAwareness, [s3Cid]);
        s3FlooderWs.send(encodeAwarenessRaw(update));
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    await new Promise((r) => setTimeout(r, 500));

    // Check rolling 1s window frame count
    let s3MaxIn1s = 0;
    for (let i = 0; i < s3FrameTimestamps.length; i++) {
      const start = s3FrameTimestamps[i];
      const count = s3FrameTimestamps.filter((t) => t >= start && t < start + 1000).length;
      if (count > s3MaxIn1s) s3MaxIn1s = count;
    }

    const s3FinalState = s3ObsAwareness.getStates().get(s3Cid);
    const s3PassedMax = s3MaxIn1s <= 12;
    const s3PassedFinal = s3FinalState?.cursor?.seq >= 2490; // within latest coalescing batch

    const s3Results = {
      total_frames_sent: s3TotalFrames,
      total_frames_received: s3FrameTimestamps.length,
      max_frames_per_sec: s3MaxIn1s,
      final_seq_received: s3FinalState?.cursor?.seq,
    };
    results.scenarios.S3_awareness_flood = s3Results;
    console.log('  -> S3 Awareness Flood completed:', s3Results);

    if (!s3PassedMax) {
      throw new Error(`S3 Assertion failed: max frames in 1s (${s3MaxIn1s}) > 12`);
    }
    if (!s3PassedFinal) {
      throw new Error(
        `S3 Assertion failed: final state (${s3FinalState?.cursor?.seq}) was not the latest (expected >= 2490)`,
      );
    }

    s3FlooderWs.close();
    s3ObsWs.close();
  } finally {
    elDelay.disable();
    const cpuDiff = process.cpuUsage(startCpu);
    results.cpu_usage = {
      user_ms: cpuDiff.user / 1000,
      system_ms: cpuDiff.system / 1000,
    };

    if (serverApp) {
      await (serverApp.app as any).closeCarrel();
      await serverApp.app.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // Write verification/loadtest-results.json
  const outDir = resolve(process.cwd(), 'verification');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'loadtest-results.json');
  writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');

  // Print results table
  console.log('\n=====================================================');
  console.log('LOAD TEST SUMMARY RESULTS');
  console.log('=====================================================');
  console.table({
    'S0 Baseline': {
      'P95 Latency (ms)': results.scenarios.S0_baseline?.latency_p95_ms,
      'Max Frames/s': 'N/A',
      'P99 Event Loop (ms)': results.scenarios.S0_baseline?.event_loop_delay_p99_ms,
      Status: 'PASSED',
    },
    'S1 Burst': {
      'P95 Latency (ms)': results.scenarios.S1_burst?.latency_p95_ms,
      'Max Frames/s': results.scenarios.S1_burst?.max_frames_per_sec,
      'P99 Event Loop (ms)': results.scenarios.S1_burst?.event_loop_delay_p99_ms,
      Status: 'PASSED',
    },
    'S2 Sustained': {
      'Time to Warn (s)': results.scenarios.S2_sustained?.time_to_warning_sec,
      'Time to Close (s)': results.scenarios.S2_sustained?.time_to_close_sec,
      'Close Code': results.scenarios.S2_sustained?.close_code,
      Status: 'PASSED',
    },
    'S3 Awareness': {
      'Total Sent': results.scenarios.S3_awareness_flood?.total_frames_sent,
      'Max Frames/s': results.scenarios.S3_awareness_flood?.max_frames_per_sec,
      'Final Seq': results.scenarios.S3_awareness_flood?.final_seq_received,
      Status: 'PASSED',
    },
  });
  console.log(`Results written to: ${outFile}`);
  console.log('CPU Time Delta:', results.cpu_usage);
  console.log('=====================================================\n');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nLOAD TEST FAILED:', err);
    process.exit(1);
  });
