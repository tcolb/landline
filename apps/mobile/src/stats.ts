// Client-side pipeline statistics (docs/PROFILING.md).
//
// Ring-buffer series with on-demand percentiles, plus rolling per-second
// rates. Fed by the WS client (parse/bytes) and the terminal (apply,
// record, compose, e2e latency); read by the debug panel and dumpable as
// JSON to the Metro console.

const RING = 256;

export class Series {
  private values: number[] = [];
  private idx = 0;
  count = 0;
  last = 0;

  add(v: number) {
    this.last = v;
    this.count++;
    if (this.values.length < RING) this.values.push(v);
    else this.values[this.idx] = v;
    this.idx = (this.idx + 1) % RING;
  }

  private sorted(): number[] {
    return [...this.values].sort((a, b) => a - b);
  }

  percentile(q: number): number {
    if (this.values.length === 0) return 0;
    const s = this.sorted();
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }

  get p50() {
    return this.percentile(0.5);
  }
  get p95() {
    return this.percentile(0.95);
  }
  get max() {
    return this.values.length ? Math.max(...this.values) : 0;
  }

  summary() {
    return {
      count: this.count,
      last: round1(this.last),
      p50: round1(this.p50),
      p95: round1(this.p95),
      max: round1(this.max),
    };
  }
}

/** Events-per-second over a sliding 2s window. */
export class Rate {
  private stamps: number[] = [];
  private amount: number[] = [];

  add(n = 1) {
    const now = Date.now();
    this.stamps.push(now);
    this.amount.push(n);
    while (this.stamps.length && this.stamps[0] < now - 2000) {
      this.stamps.shift();
      this.amount.shift();
    }
  }

  perSec(): number {
    const now = Date.now();
    let total = 0;
    for (let i = 0; i < this.stamps.length; i++) {
      if (this.stamps[i] >= now - 2000) total += this.amount[i];
    }
    return total / 2;
  }
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

/** One resolved input that exceeded the slow threshold, with enough
 * context to localize the stall without reproducing it. */
export interface SlowEvent {
  at: string;
  seq: number;
  e2e_ms: number;
  /** send → acking frame arrived at the client (network + server). */
  pre_ms: number;
  /** arrival → composed (client queue + render). */
  post_ms: number;
  frame_kind: string;
  frame_rows: number;
  msgs_in_tick: number;
}

const SLOW_THRESHOLD_MS = 100;
const SLOW_KEEP = 20;

export const stats = {
  /** Input sent → its ack'd frame composed+painted (ms). The headline. */
  e2e: new Series(),
  /** e2e split: send → acking frame arrival (network + server share). */
  e2ePre: new Series(),
  /** e2e split: arrival → composed (client share). */
  e2ePost: new Series(),
  /** Ring of the most recent slow resolutions (> threshold). */
  slow: [] as SlowEvent[],

  addResolved(entry: Omit<SlowEvent, "at">) {
    this.e2e.add(entry.e2e_ms);
    this.e2ePre.add(entry.pre_ms);
    this.e2ePost.add(entry.post_ms);
    if (entry.e2e_ms > SLOW_THRESHOLD_MS) {
      this.slow.push({ ...entry, at: new Date().toISOString().slice(11, 23) });
      if (this.slow.length > SLOW_KEEP) this.slow.shift();
    }
  },
  /** WS message JSON.parse duration (ms). */
  parse: new Series(),
  /** applyFrame duration (ms): grid writes + dirty marking. */
  apply: new Series(),
  /** recordRow total per compose (ms). */
  record: new Series(),
  /** compose duration (ms). */
  compose: new Series(),
  /** Frames applied between composes; persistently > 1 = JS backlog. */
  msgsPerTick: new Series(),
  /** Dirty rows per applied frame. */
  rowsPerFrame: new Series(),
  framesRate: new Rate(),
  bytesRate: new Rate(),

  snapshot() {
    return {
      e2e_ms: this.e2e.summary(),
      e2e_pre_ms: this.e2ePre.summary(),
      e2e_post_ms: this.e2ePost.summary(),
      slow_events: this.slow,
      parse_ms: this.parse.summary(),
      apply_ms: this.apply.summary(),
      record_ms: this.record.summary(),
      compose_ms: this.compose.summary(),
      msgs_per_tick: this.msgsPerTick.summary(),
      rows_per_frame: this.rowsPerFrame.summary(),
      frames_per_sec: round1(this.framesRate.perSec()),
      bytes_per_sec: Math.round(this.bytesRate.perSec()),
    };
  },

  dump() {
    console.log("landline client stats", JSON.stringify(this.snapshot()));
  },
};
