import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { decodeFrame, FRAME_TYPES } from '@carrel/shared';
import { CarrelProvider, computeBackoff, type TicketResult } from './CarrelProvider';
import { ConnectionLight, ReconnectBanner } from '../ui';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sentFrames: Uint8Array[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1; // OPEN
        this.onopen?.();
      }
    });
  }

  send(data: any) {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(Buffer.from(data));
    this.sentFrames.push(bytes);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }

  simulateServerFrame(bytes: Uint8Array) {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

async function flushConnect() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5);
  }
}

describe('B3. CarrelProvider & Resilience Tests', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as any).WebSocket = MockWebSocket;
    (window as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    (globalThis as any).WebSocket = originalWebSocket;
    (window as any).WebSocket = originalWebSocket;
  });

  it('1. Backoff schedule: bounds with jitter, cap at 10s, reset after synced, 5s floor after 1008', async () => {
    // 1. Bounds with jitter
    const d0_min = computeBackoff(0, false, () => 0);
    const d0_max = computeBackoff(0, false, () => 1);
    expect(d0_min).toBe(250);
    expect(d0_max).toBe(500);

    const d1_min = computeBackoff(1, false, () => 0);
    const d1_max = computeBackoff(1, false, () => 1);
    expect(d1_min).toBe(500);
    expect(d1_max).toBe(1000);

    // 2. Cap at 10s
    const d10_min = computeBackoff(10, false, () => 0);
    const d10_max = computeBackoff(10, false, () => 1);
    expect(d10_min).toBe(5000);
    expect(d10_max).toBe(10000);

    // 3. 5s floor after 1008 (wasRateLimited = true)
    const dRateLimited_min = computeBackoff(0, true, () => 0);
    expect(dRateLimited_min).toBe(5000);
    const dRateLimited_mid = computeBackoff(1, true, () => 0.1);
    expect(dRateLimited_mid).toBeGreaterThanOrEqual(5000);

    // 4. Reset after synced in provider
    vi.useFakeTimers();
    let currentTicket = 1;
    const provider = new CarrelProvider({
      roomId: 'test-room',
      wsBaseUrl: 'ws://localhost',
      getTicket: async () => ({ ticket: `ticket-${currentTicket++}` }),
    });

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // Simulate 3 retries
    provider.attempt = 3;
    expect(provider.attempt).toBe(3);

    // Simulate receiving a sync frame from server
    const remoteDoc = new Y.Doc();
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep2(encoder, remoteDoc);
    const step2Payload = encoding.toUint8Array(encoder);
    const syncFrame = new Uint8Array(1 + step2Payload.length);
    syncFrame[0] = FRAME_TYPES.sync;
    syncFrame.set(step2Payload, 1);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.simulateServerFrame(syncFrame);
    });

    expect(provider.status).toBe('synced');
    expect(provider.attempt).toBe(0);

    // 5. 5s floor after 1008 in provider
    act(() => {
      ws.close(1008, 'rate_limit');
    });
    expect(provider.status).toBe('reconnecting');
    expect(provider.nextRetryAt).not.toBeNull();
    const delay = (provider.nextRetryAt ?? 0) - Date.now();
    expect(delay).toBeGreaterThanOrEqual(5000);

    provider.destroy();
  });

  it('2. A fresh ticket is requested on every attempt (mock fetch); single-use ticket is never reused', async () => {
    vi.useFakeTimers();
    let ticketCounter = 0;
    const requestedTickets: string[] = [];

    const getTicket = vi.fn(async (): Promise<TicketResult> => {
      ticketCounter++;
      const t = `fresh-ticket-${ticketCounter}`;
      requestedTickets.push(t);
      return { ticket: t };
    });

    const provider = new CarrelProvider({
      roomId: 'test-room',
      wsBaseUrl: 'ws://localhost',
      getTicket,
    });

    // Initial connect: attempt 1
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toContain('ticket=fresh-ticket-1');

    // Simulate transient close (e.g. 1001)
    act(() => {
      MockWebSocket.instances[0].close(1001, 'going away');
    });
    expect(provider.status).toBe('reconnecting');

    // Fast-forward past backoff delay
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    // Attempt 2: fresh ticket
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.instances[1].url).toContain('ticket=fresh-ticket-2');

    // Close again
    act(() => {
      MockWebSocket.instances[1].close(4001, 'unauthorized');
    });

    // Fast-forward past backoff delay
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    // Attempt 3: fresh ticket
    expect(getTicket).toHaveBeenCalledTimes(3);
    expect(MockWebSocket.instances.length).toBe(3);
    expect(MockWebSocket.instances[2].url).toContain('ticket=fresh-ticket-3');

    // Verify all tickets were unique and none reused
    expect(new Set(requestedTickets).size).toBe(3);
    provider.destroy();
  });

  it('3. Terminal close codes stop retries (4003, 4008, 4009, 4000); 4001/1001 retry', async () => {
    vi.useFakeTimers();

    const terminalCodes = [
      { code: 4003, event: 'kicked' },
      { code: 4008, event: 'room_full' },
      { code: 4009, event: 'room_locked' },
      { code: 4000, event: 'replaced' },
    ] as const;

    for (const { code, event } of terminalCodes) {
      const getTicket = vi.fn(async () => ({ ticket: `ticket-${code}` }));
      const provider = new CarrelProvider({
        roomId: 'test-room',
        wsBaseUrl: 'ws://localhost',
        getTicket,
      });

      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      expect(getTicket).toHaveBeenCalledTimes(1);

      let eventFired = false;
      provider.on(event as any, () => {
        eventFired = true;
      });

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        ws.close(code, 'terminal');
      });

      expect(eventFired).toBe(true);
      expect(provider.status).toBe('closed');

      // Advance by 30 seconds - no retry should happen
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(getTicket).toHaveBeenCalledTimes(1);

      provider.destroy();
    }

    // Now verify 4001 and 1001 DO retry
    for (const code of [4001, 1001]) {
      const getTicket = vi.fn(async () => ({ ticket: `ticket-retry-${code}` }));
      const provider = new CarrelProvider({
        roomId: 'test-room',
        wsBaseUrl: 'ws://localhost',
        getTicket,
      });

      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      expect(getTicket).toHaveBeenCalledTimes(1);

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        ws.close(code, 'retryable');
      });

      expect(provider.status).toBe('reconnecting');

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      expect(getTicket).toHaveBeenCalledTimes(2);
      provider.destroy();
    }
  });

  it('4. Client bucket batches 20 rapid local updates into at most 5 frames in the first second and loses nothing', async () => {
    vi.useFakeTimers();

    const provider = new CarrelProvider({
      roomId: 'test-room',
      wsBaseUrl: 'ws://localhost',
      getTicket: async () => ({ ticket: 'token-rate' }),
    });

    await flushConnect();

    const ws = MockWebSocket.instances[0];
    expect(ws.readyState).toBe(1);

    // Clear initial handshake frames
    ws.sentFrames = [];

    // Simulate 20 rapid local edits on provider's doc
    const localText = provider.doc.getText('codemirror');
    for (let i = 0; i < 20; i++) {
      localText.insert(i, String.fromCharCode(65 + i)); // A, B, C, ...
    }

    // Advance fake timers by 1000ms (1 second) in increments of 50ms
    for (let step = 0; step < 20; step++) {
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    }

    // Filter sent sync frames
    const syncFrames = ws.sentFrames.filter((f) => f[0] === FRAME_TYPES.sync);
    expect(syncFrames.length).toBeGreaterThan(0);
    expect(syncFrames.length).toBeLessThanOrEqual(5);

    // Verify nothing is lost on a remote replica
    const remoteDoc = new Y.Doc();
    for (const frame of syncFrames) {
      const { payload } = decodeFrame(frame);
      const decoder = decoding.createDecoder(payload);
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, encoder, remoteDoc, 'remote');
    }

    expect(remoteDoc.getText('codemirror').toString()).toBe(localText.toString());
    expect(remoteDoc.getText('codemirror').toString()).toBe('ABCDEFGHIJKLMNOPQRST');

    provider.destroy();
  });

  it('5. Offline/online events: offline stops retries, online retries immediately', async () => {
    vi.useFakeTimers();

    let ticketCalls = 0;
    const provider = new CarrelProvider({
      roomId: 'test-room',
      wsBaseUrl: 'ws://localhost',
      getTicket: async () => {
        ticketCalls++;
        return { ticket: `ticket-${ticketCalls}` };
      },
    });

    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(ticketCalls).toBe(1);

    const ws = MockWebSocket.instances[0];
    // Close socket with retryable code to schedule backoff
    act(() => {
      ws.close(1001, 'going away');
    });
    expect(provider.status).toBe('reconnecting');
    expect(provider.nextRetryAt).not.toBeNull();

    // Trigger offline event
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(provider.status).toBe('offline');
    expect(provider.nextRetryAt).toBeNull();

    // Advance timers by 60s: no retry while offline
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(ticketCalls).toBe(1);

    // Trigger online event
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    // Retries immediately without waiting for backoff timer
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(ticketCalls).toBe(2);

    provider.destroy();
  });

  it('6. Visibility: returning to a visible tab sends ping and reconnects if no pong in 3s', async () => {
    vi.useFakeTimers();

    const provider = new CarrelProvider({
      roomId: 'test-room',
      wsBaseUrl: 'ws://localhost',
      getTicket: async () => ({ ticket: 'vis-ticket' }),
    });

    await flushConnect();

    const ws = MockWebSocket.instances[0];
    expect(ws.readyState).toBe(1);
    ws.sentFrames = [];

    // Make tab visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Check that a ping frame was sent immediately
    const controlFrames = ws.sentFrames.filter((f) => f[0] === FRAME_TYPES.control);
    expect(controlFrames.length).toBeGreaterThanOrEqual(1);

    const lastControl = JSON.parse(
      new TextDecoder().decode(controlFrames[controlFrames.length - 1].slice(1)),
    );
    expect(lastControl.type).toBe('ping');
    expect(typeof lastControl.t).toBe('number');

    // Do NOT send pong; advance fake timers by 3000ms
    act(() => {
      vi.advanceTimersByTime(3050);
    });

    // Socket should have been closed because pong was not received within 3s
    expect(ws.readyState).toBe(3); // CLOSED
    expect(provider.status).toBe('reconnecting');

    provider.destroy();
  });

  it('7. ReconnectBanner countdown, Retry now, aria-live; ConnectionLight shows text for every state', async () => {
    vi.useFakeTimers();

    // Part A: ReconnectBanner
    const onRetry = vi.fn();
    const retryTargetTime = Date.now() + 4000;

    const { rerender, unmount } = render(
      <ReconnectBanner status="reconnecting" nextRetryAt={retryTargetTime} onRetry={onRetry} />,
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(
      screen.getByText(/Connection lost\. Your edits are safe\. Retrying in 4s/i),
    ).toBeInTheDocument();

    // Advance by 1 second -> countdown updates to 3s
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.getByText(/Connection lost\. Your edits are safe\. Retrying in 3s/i),
    ).toBeInTheDocument();

    // Click Retry now
    const retryBtn = screen.getByRole('button', { name: /Retry now/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Test offline banner variant
    rerender(<ReconnectBanner status="offline" onRetry={onRetry} />);
    expect(
      screen.getByText(/You're offline\. Your edits stay on this device until you're back\./i),
    ).toBeInTheDocument();

    unmount();

    // Part B: ConnectionLight shows text for every state
    const states = ['synced', 'connecting', 'reconnecting', 'offline', 'closed'] as const;
    for (const state of states) {
      const { unmount: unmountLight } = render(<ConnectionLight status={state} />);
      const lightWrapper = screen.getByRole('status');
      expect(lightWrapper).toBeInTheDocument();

      const expectedText = state[0].toUpperCase() + state.slice(1);
      expect(screen.getByText(expectedText)).toBeVisible();
      unmountLight();
    }
  });
});
