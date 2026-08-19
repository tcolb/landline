//! Per-session pipeline statistics (docs/PROFILING.md).
//!
//! Lock-free: plain atomics and fixed-bucket histograms, recorded from the
//! VT/reader/writer threads and connection tasks, snapshotted as JSON by
//! the `stats` protocol request. Values are generic u64s; each histogram
//! declares its unit (µs, bytes, rows).

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Duration;

use serde_json::{Value, json};

/// Bucket upper bounds. Chosen for µs latencies but serviceable for byte
/// and row counts too; the last bucket is unbounded.
const BOUNDS: [u64; 11] = [
    50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

#[derive(Default)]
pub struct Hist {
    buckets: [AtomicU64; BOUNDS.len() + 1],
    count: AtomicU64,
    sum: AtomicU64,
    max: AtomicU64,
}

impl Hist {
    pub fn record(&self, v: u64) {
        let idx = BOUNDS.iter().position(|&b| v <= b).unwrap_or(BOUNDS.len());
        self.buckets[idx].fetch_add(1, Relaxed);
        self.count.fetch_add(1, Relaxed);
        self.sum.fetch_add(v, Relaxed);
        self.max.fetch_max(v, Relaxed);
    }

    pub fn record_duration(&self, d: Duration) {
        self.record(d.as_micros() as u64);
    }

    /// Percentile approximated as the upper bound of the bucket where the
    /// cumulative count crosses the quantile.
    fn percentile(&self, counts: &[u64], total: u64, q: f64) -> u64 {
        if total == 0 {
            return 0;
        }
        let target = ((total as f64) * q).ceil() as u64;
        let mut cum = 0;
        for (i, c) in counts.iter().enumerate() {
            cum += c;
            if cum >= target {
                return *BOUNDS.get(i).unwrap_or(BOUNDS.last().unwrap());
            }
        }
        *BOUNDS.last().unwrap()
    }

    pub fn to_json(&self, unit: &str) -> Value {
        let counts: Vec<u64> = self.buckets.iter().map(|b| b.load(Relaxed)).collect();
        let count = self.count.load(Relaxed);
        let sum = self.sum.load(Relaxed);
        json!({
            "unit": unit,
            "count": count,
            "mean": sum.checked_div(count).unwrap_or(0),
            "max": self.max.load(Relaxed),
            "p50": self.percentile(&counts, count, 0.50),
            "p95": self.percentile(&counts, count, 0.95),
            "p99": self.percentile(&counts, count, 0.99),
        })
    }
}

#[derive(Default)]
pub struct SessionStats {
    /// Input message received → bytes written to the PTY.
    pub input_latency: Hist,
    /// `screen.write` duration per output batch.
    pub vt_write: Hist,
    /// `screen.diff` duration per emitted frame.
    pub vt_diff: Hist,
    /// Serialized frame size, recorded per client send.
    pub frame_bytes: Hist,
    /// Dirty rows carried per diff.
    pub rows_per_diff: Hist,
    pub inputs: AtomicU64,
    pub pty_bytes_in: AtomicU64,
    pub frames: AtomicU64,
    /// Frames emitted immediately after a quiet period vs on the tick.
    pub frames_immediate: AtomicU64,
    pub frames_coalesced: AtomicU64,
    /// Snapshot resyncs forced by a slow consumer (broadcast lag).
    pub lagged_resyncs: AtomicU64,
    /// Input written to the PTY → first frame emitted acking it. Includes
    /// harness (app) processing plus VT coalescing — the server-side share
    /// of end-to-end latency.
    pub input_to_frame: Hist,
}

impl SessionStats {
    pub fn to_json(&self) -> Value {
        json!({
            "input_latency_us": self.input_latency.to_json("us"),
            "vt_write_us": self.vt_write.to_json("us"),
            "vt_diff_us": self.vt_diff.to_json("us"),
            "frame_bytes": self.frame_bytes.to_json("bytes"),
            "rows_per_diff": self.rows_per_diff.to_json("rows"),
            "inputs": self.inputs.load(Relaxed),
            "pty_bytes_in": self.pty_bytes_in.load(Relaxed),
            "frames": self.frames.load(Relaxed),
            "frames_immediate": self.frames_immediate.load(Relaxed),
            "frames_coalesced": self.frames_coalesced.load(Relaxed),
            "lagged_resyncs": self.lagged_resyncs.load(Relaxed),
            "input_to_frame_us": self.input_to_frame.to_json("us"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hist_percentiles_and_counts() {
        let h = Hist::default();
        for v in [40, 60, 200, 900, 30_000] {
            h.record(v);
        }
        let j = h.to_json("us");
        assert_eq!(j["count"], 5);
        assert_eq!(j["max"], 30_000);
        assert_eq!(j["p50"], 250); // 3rd of 5 lands in the ≤250 bucket
        assert_eq!(j["p99"], 50_000); // top sample's bucket upper bound
    }
}
