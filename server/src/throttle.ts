export class TokenBucket {
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

export type ThrottleLevel = 'none' | 'warning' | 'closing';

export class EscalationLadder {
  overflowSince: number | null = null;
  lastWarnSent = -Infinity;
  warnEpisodeAudited = false;
  continuousTokensSince: number | null = null;

  constructor(
    readonly throttleWarnMs = 3000,
    readonly throttleKickMs = 10000,
    readonly clock: () => number = Date.now,
  ) {}

  onBufferOccupied(): void {
    if (this.overflowSince === null) {
      this.overflowSince = this.clock();
    }
    this.continuousTokensSince = null;
  }

  onBufferDrained(hasToken: boolean): void {
    const now = this.clock();
    if (hasToken) {
      if (this.continuousTokensSince === null) {
        this.continuousTokensSince = now;
      } else if (now - this.continuousTokensSince >= 1000) {
        this.overflowSince = null;
        this.warnEpisodeAudited = false;
        this.continuousTokensSince = null;
      }
    } else {
      this.continuousTokensSince = null;
    }
  }

  checkEscalation(): {
    level: ThrottleLevel;
    shouldSendNotice: boolean;
    shouldAuditWarn: boolean;
    durationMs: number;
  } {
    if (this.overflowSince === null) {
      return { level: 'none', shouldSendNotice: false, shouldAuditWarn: false, durationMs: 0 };
    }
    const now = this.clock();
    const duration = now - this.overflowSince;

    if (duration >= this.throttleKickMs) {
      return {
        level: 'closing',
        shouldSendNotice: true,
        shouldAuditWarn: false,
        durationMs: duration,
      };
    }

    if (duration >= this.throttleWarnMs) {
      const shouldSend = now - this.lastWarnSent >= 5000;
      if (shouldSend) {
        this.lastWarnSent = now;
      }
      const shouldAudit = !this.warnEpisodeAudited;
      if (shouldAudit) {
        this.warnEpisodeAudited = true;
      }
      return {
        level: 'warning',
        shouldSendNotice: shouldSend,
        shouldAuditWarn: shouldAudit,
        durationMs: duration,
      };
    }

    return { level: 'none', shouldSendNotice: false, shouldAuditWarn: false, durationMs: duration };
  }
}
