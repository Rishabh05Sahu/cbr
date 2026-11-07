// S1-08 progress monitor: progress is printed about every 60 s. A gap of more than 120 s between
// two observations (ticks, or the last tick and the end of the run) means the test process did
// not run normally for that time. What is *observed* is only the gap and its timestamps; the
// cause is not determined here (host sleep/Modern Standby, process suspension and an event-loop
// stall all look alike). Any such gap makes the run invalid for acceptance: S1-08 must fail,
// whatever its counters say (docs/runbooks/staging-preparation.md, long-running tests).

export const PROGRESS_INTERVAL_MS = 60_000;
export const MAX_PROGRESS_GAP_MS = 120_000;
const GAP_SAMPLE_LIMIT = 20;

export interface ProgressGap {
  readonly observed: string;
  readonly fromUtc: string;
  readonly toUtc: string;
  /** Monotonic clock (performance.now) between the two observations. */
  readonly monotonicGapMs: number;
  /** Wall clock (Date.now) between the two observations. */
  readonly wallClockGapMs: number;
  readonly inferredCause: string;
}

export interface Clocks {
  readonly monotonicMs: () => number;
  readonly wallMs: () => number;
}

const realClocks: Clocks = { monotonicMs: () => performance.now(), wallMs: () => Date.now() };
const iso = (ms: number) => new Date(ms).toISOString();

export class ProgressMonitor {
  /** First 20 gaps; `gapCount` is uncapped. */
  readonly gaps: ProgressGap[] = [];
  gapCount = 0;
  readonly startedAtUtc: string;
  private lastMono: number;
  private lastWall: number;

  constructor(
    private readonly clocks: Clocks = realClocks,
    private readonly maxGapMs = MAX_PROGRESS_GAP_MS,
  ) {
    this.lastMono = clocks.monotonicMs();
    this.lastWall = clocks.wallMs();
    this.startedAtUtc = iso(this.lastWall);
  }

  /** UTC timestamp for output lines. */
  nowUtc(): string {
    return iso(this.clocks.wallMs());
  }

  /** Call on every progress tick and once at the end; returns the gap if one was observed. */
  observe(at: 'progress tick' | 'end of run'): ProgressGap | null {
    const mono = this.clocks.monotonicMs();
    const wall = this.clocks.wallMs();
    const monotonicGapMs = Math.round(mono - this.lastMono);
    const wallClockGapMs = Math.round(wall - this.lastWall);
    let gap: ProgressGap | null = null;
    // Either clock is enough: one may not advance during a suspension on some platforms.
    if (monotonicGapMs > this.maxGapMs || wallClockGapMs > this.maxGapMs) {
      gap = {
        observed: `no progress observation for more than ${this.maxGapMs / 1000} s (before ${at})`,
        fromUtc: iso(this.lastWall),
        toUtc: iso(wall),
        monotonicGapMs,
        wallClockGapMs,
        inferredCause:
          'not determined: host sleep/standby, process suspension or an event-loop stall',
      };
      this.gapCount++;
      if (this.gaps.length < GAP_SAMPLE_LIMIT) this.gaps.push(gap);
    }
    this.lastMono = mono;
    this.lastWall = wall;
    return gap;
  }

  get validForAcceptance(): boolean {
    return this.gapCount === 0;
  }

  /** The error S1-08 throws for an invalid run (never a pass). */
  invalidRunMessage(): string {
    const largest = Math.max(...this.gaps.map((g) => Math.max(g.monotonicGapMs, g.wallClockGapMs)));
    return (
      `S1-08 run invalid for acceptance: ${this.gapCount} progress gap(s) over ` +
      `${this.maxGapMs / 1000} s observed (largest ${(largest / 1000).toFixed(1)} s, first from ` +
      `${this.gaps[0]?.fromUtc} to ${this.gaps[0]?.toUtc}); cause not determined`
    );
  }
}
