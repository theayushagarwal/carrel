import { describe, expect, it } from 'vitest';
import { EscalationLadder, TokenBucket } from './throttle.js';

describe('TokenBucket (A1)', () => {
  it('respects initial capacity and consumes tokens on tryTake', () => {
    const now = 1000;
    const bucket = new TokenBucket(5, 5, () => now);

    expect(bucket.tokens()).toBe(5);
    expect(bucket.msUntilNextToken()).toBe(0);

    for (let i = 0; i < 5; i++) {
      expect(bucket.tryTake()).toBe(true);
    }
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.tokens()).toBe(0);
    expect(bucket.msUntilNextToken()).toBe(200); // 1 token / 5 per sec = 200ms
  });

  it('refills tokens linearly over time up to capacity', () => {
    let now = 1000;
    const bucket = new TokenBucket(5, 5, () => now);

    // Consume all 5
    for (let i = 0; i < 5; i++) bucket.tryTake();
    expect(bucket.tokens()).toBe(0);

    // Advance 400ms -> 2 tokens
    now += 400;
    expect(bucket.tokens()).toBe(2);
    expect(bucket.msUntilNextToken()).toBe(0);
    expect(bucket.tryTake(2)).toBe(true);
    expect(bucket.tryTake()).toBe(false);

    // Advance 2000ms -> should cap at 5
    now += 2000;
    expect(bucket.tokens()).toBe(5);
    expect(bucket.tryTake(5)).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('accurately calculates msUntilNextToken', () => {
    let now = 1000;
    const bucket = new TokenBucket(2, 2, () => now);

    expect(bucket.tryTake(2)).toBe(true);
    expect(bucket.tokens()).toBe(0);
    expect(bucket.msUntilNextToken()).toBe(500); // 1 token / 2 per sec = 500ms

    now += 250;
    // 0.5 tokens available, needs 0.5 more -> 0.5 / 2 = 250ms
    expect(bucket.msUntilNextToken()).toBe(250);

    now += 250;
    // 1 token available
    expect(bucket.msUntilNextToken()).toBe(0);
  });
});

describe('EscalationLadder (A5)', () => {
  it('escalates to warning at 3s and closing at 10s of continuous overflow', () => {
    let now = 1000;
    const ladder = new EscalationLadder(3000, 10000, () => now);

    expect(ladder.checkEscalation().level).toBe('none');

    // Buffer occupied
    ladder.onBufferOccupied();

    // 2s elapsed -> none
    now += 2000;
    let res = ladder.checkEscalation();
    expect(res.level).toBe('none');
    expect(res.shouldSendNotice).toBe(false);

    // 3s elapsed -> warning
    now += 1000;
    res = ladder.checkEscalation();
    expect(res.level).toBe('warning');
    expect(res.shouldSendNotice).toBe(true);
    expect(res.shouldAuditWarn).toBe(true);

    // Check again at 4s -> warning, but repeat notice throttled (within 5s)
    now += 1000;
    res = ladder.checkEscalation();
    expect(res.level).toBe('warning');
    expect(res.shouldSendNotice).toBe(false);
    expect(res.shouldAuditWarn).toBe(false); // only 1 audit per episode

    // Check at 8.5s (5.5s after last notice) -> sends notice again
    now += 4500;
    res = ladder.checkEscalation();
    expect(res.level).toBe('warning');
    expect(res.shouldSendNotice).toBe(true);

    // At 10s -> closing
    now += 1500;
    res = ladder.checkEscalation();
    expect(res.level).toBe('closing');
    expect(res.shouldSendNotice).toBe(true);
  });

  it('clears overflow only after 1s of continuous available tokens when buffer is drained', () => {
    let now = 1000;
    const ladder = new EscalationLadder(3000, 10000, () => now);

    ladder.onBufferOccupied();
    now += 2000;
    expect(ladder.overflowSince).not.toBeNull();

    // Buffer drained but bucket has no token
    ladder.onBufferDrained(false);
    expect(ladder.overflowSince).not.toBeNull();

    // Buffer drained and bucket has tokens
    ladder.onBufferDrained(true);
    expect(ladder.overflowSince).not.toBeNull();

    // 500ms later with tokens
    now += 500;
    ladder.onBufferDrained(true);
    expect(ladder.overflowSince).not.toBeNull();

    // 1000ms total continuous tokens
    now += 500;
    ladder.onBufferDrained(true);
    expect(ladder.overflowSince).toBeNull();
  });
});
