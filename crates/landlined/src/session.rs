//! A session: a process in an environment, a PTY, and a VT screen.
//!
//! Thread model (libghostty-vt types are !Send, so the screen is confined):
//!   - reader thread: blocking-reads PTY output, ships bytes to the VT thread
//!   - vt thread: owns the `Screen` and PTY master; applies output, coalesces
//!     diffs on a tick, services control requests, broadcasts frames to
//!     attached clients
//!   - writer thread: drains client input into the PTY
//!   - wait thread:   blocks on child exit, reports the code
//!
//! Clients attach by subscribing to the broadcast channel and requesting a
//! snapshot; detach is just dropping the subscription. Sessions outlive
//! clients by construction.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use crossbeam_channel as xchan;
use landline_proto::wire::{Frame, SessionInfo, SessionStatus};
use tokio::sync::broadcast;

use crate::environment::{Environment, LaunchSpec, Launched};
use crate::screen::{GhosttyScreen, Screen};
use crate::stats::SessionStats;

const SCROLLBACK_LINES: usize = 10_000;
/// Diff coalescing tick: bound both latency and frame rate for clients.
const FRAME_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Debug, Clone)]
pub enum Event {
    Frame(Frame),
    Exited { code: Option<i32> },
}

pub enum Ctl {
    Snapshot(xchan::Sender<Frame>),
    /// Current screen serialized as a VT escape stream (bytes-mode attach).
    VtSnapshot(xchan::Sender<Vec<u8>>),
    Resize {
        rows: u16,
        cols: u16,
    },
    ChildExited {
        code: Option<i32>,
    },
}

/// One queued input write: bytes, optional client seq, receive time.
pub type InputMsg = (Vec<u8>, Option<u64>, Instant);

pub struct Session {
    pub info: Mutex<SessionInfo>,
    pub input_tx: xchan::Sender<InputMsg>,
    pub ctl_tx: xchan::Sender<Ctl>,
    pub events: broadcast::Sender<Event>,
    /// Raw PTY output tee for bytes-mode clients.
    pub bytes: broadcast::Sender<Vec<u8>>,
    pub killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pub environment: Box<dyn Environment>,
    /// Last screen of an exited session, servable postmortem.
    pub final_frame: Mutex<Option<Frame>>,
    pub final_vt: Mutex<Option<Vec<u8>>>,
    /// Highest client input seq written to the PTY (0 = none yet); stamped
    /// onto frames as `ack` for client-side latency correlation.
    pub last_input_seq: AtomicU64,
    /// When that input was written, µs since session spawn.
    pub last_input_at_us: AtomicU64,
    pub stats: Arc<SessionStats>,
    /// Session spawn instant; epoch for `last_input_at_us`.
    pub started: Instant,
}

impl Session {
    pub fn spawn(
        env: Box<dyn Environment>,
        info: SessionInfo,
        spec: &LaunchSpec,
    ) -> Result<Arc<Self>> {
        let Launched {
            master,
            mut child,
            killer,
        } = env.launch(spec)?;

        let (out_tx, out_rx) = xchan::bounded::<Vec<u8>>(256);
        let (input_tx, input_rx) = xchan::bounded::<InputMsg>(256);
        let (ctl_tx, ctl_rx) = xchan::unbounded::<Ctl>();
        let (events, _) = broadcast::channel::<Event>(256);
        let (bytes, _) = broadcast::channel::<Vec<u8>>(256);

        let mut reader = master.try_clone_reader()?;
        let mut writer = master.take_writer()?;

        let session = Arc::new(Session {
            info: Mutex::new(info),
            input_tx,
            ctl_tx: ctl_tx.clone(),
            events: events.clone(),
            bytes: bytes.clone(),
            killer: Mutex::new(killer),
            environment: env,
            final_frame: Mutex::new(None),
            final_vt: Mutex::new(None),
            last_input_seq: AtomicU64::new(0),
            last_input_at_us: AtomicU64::new(0),
            stats: Arc::new(SessionStats::default()),
            started: Instant::now(),
        });

        // Reader: PTY output -> VT thread, teed to bytes-mode subscribers.
        {
            let stats = session.stats.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            stats.pty_bytes_in.fetch_add(n as u64, Relaxed);
                            let chunk = buf[..n].to_vec();
                            let _ = bytes.send(chunk.clone()); // no subscribers is fine
                            if out_tx.send(chunk).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }

        // Writer: client input -> PTY. Records receive→write latency and
        // publishes the seq for frame acks.
        {
            let session = session.clone();
            std::thread::spawn(move || {
                while let Ok((data, seq, received)) = input_rx.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    session.stats.inputs.fetch_add(1, Relaxed);
                    session
                        .stats
                        .input_latency
                        .record_duration(received.elapsed());
                    if let Some(seq) = seq {
                        session
                            .last_input_at_us
                            .store(session.started.elapsed().as_micros() as u64, Relaxed);
                        session.last_input_seq.fetch_max(seq, Relaxed);
                    }
                }
            });
        }

        // Wait: child exit -> VT thread (which owns status + broadcast).
        {
            let ctl_tx = ctl_tx.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|st| st.exit_code() as i32);
                let _ = ctl_tx.send(Ctl::ChildExited { code });
            });
        }

        // VT thread: owns screen + master, produces frames.
        {
            let session = session.clone();
            let (rows, cols) = (spec.rows, spec.cols);
            std::thread::spawn(move || {
                let mut screen = match GhosttyScreen::new(rows, cols, SCROLLBACK_LINES) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!("session screen init failed: {e}");
                        return;
                    }
                };
                vt_loop(&session, &mut screen, master.as_ref(), &out_rx, &ctl_rx);
            });
        }

        Ok(session)
    }

    pub fn kill(&self) {
        // Tear down the environment first: for containers, removing the
        // container also ends the `run` child; a plain SIGKILL on the child
        // would leave the container running.
        self.environment.cleanup();
        let _ = self.killer.lock().unwrap().kill();
    }

    pub fn status(&self) -> SessionStatus {
        self.info.lock().unwrap().status.clone()
    }
}

fn vt_loop(
    session: &Session,
    screen: &mut dyn Screen,
    master: &dyn portable_pty::MasterPty,
    out_rx: &xchan::Receiver<Vec<u8>>,
    ctl_rx: &xchan::Receiver<Ctl>,
) {
    let mut pending = false; // wrote bytes since last diff?
    let mut last_emit = std::time::Instant::now() - FRAME_INTERVAL;
    // Stamp the highest PTY-written input seq onto outgoing frames so
    // clients can correlate input→effect on their own clock.
    // Track which seq we've already timed so input→frame latency records
    // once, on the first frame that acks each input.
    let mut last_timed_seq: u64 = 0;
    let mut stamp_ack = |frame: &mut Frame| {
        let seq = session.last_input_seq.load(Relaxed);
        if seq > 0 {
            match frame {
                Frame::Snapshot { ack, .. } | Frame::Diff { ack, .. } => *ack = Some(seq),
            }
            if seq > last_timed_seq {
                last_timed_seq = seq;
                let written_us = session.last_input_at_us.load(Relaxed);
                let now_us = session.started.elapsed().as_micros() as u64;
                session
                    .stats
                    .input_to_frame
                    .record(now_us.saturating_sub(written_us));
            }
        }
    };
    // Adaptive tick: after a quiet period the first diff goes out at once,
    // so interactive echo never waits out the coalescing interval; only
    // continuous output is coalesced on the tick (see the responsiveness
    // budget in docs/DESIGN.md).
    macro_rules! emit_now {
        ($counter:ident) => {
            let t = Instant::now();
            let frame = screen.diff();
            session.stats.vt_diff.record_duration(t.elapsed());
            if let Some(mut frame) = frame {
                match &frame {
                    Frame::Diff { lines, .. } | Frame::Snapshot { lines, .. } => {
                        session.stats.rows_per_diff.record(lines.len() as u64);
                    }
                }
                stamp_ack(&mut frame);
                session.stats.frames.fetch_add(1, Relaxed);
                session.stats.$counter.fetch_add(1, Relaxed);
                let _ = session.events.send(Event::Frame(frame));
            }
            last_emit = std::time::Instant::now();
            pending = false;
        };
    }
    loop {
        xchan::select! {
            recv(out_rx) -> msg => match msg {
                Ok(data) => {
                    let t = Instant::now();
                    screen.write(&data);
                    // Drain whatever else is queued before diffing.
                    while let Ok(more) = out_rx.try_recv() {
                        screen.write(&more);
                    }
                    session.stats.vt_write.record_duration(t.elapsed());
                    if last_emit.elapsed() >= FRAME_INTERVAL {
                        emit_now!(frames_immediate);
                    } else {
                        pending = true;
                    }
                }
                Err(_) => { /* reader gone; keep serving ctl until exit */ }
            },
            recv(ctl_rx) -> msg => match msg {
                Ok(Ctl::Snapshot(reply)) => {
                    let mut frame = screen.snapshot();
                    stamp_ack(&mut frame);
                    let _ = reply.send(frame);
                }
                Ok(Ctl::VtSnapshot(reply)) => {
                    let _ = reply.send(screen.vt_dump());
                }
                Ok(Ctl::Resize { rows, cols }) => {
                    let _ = master.resize(portable_pty::PtySize {
                        rows, cols, pixel_width: 0, pixel_height: 0,
                    });
                    screen.resize(rows, cols);
                    {
                        let mut info = session.info.lock().unwrap();
                        info.rows = rows;
                        info.cols = cols;
                    }
                    // Resize is interactive; repaint without waiting.
                    emit_now!(frames_immediate);
                }
                Ok(Ctl::ChildExited { code }) => {
                    // Flush any final output that raced the exit.
                    while let Ok(more) = out_rx.try_recv() {
                        screen.write(&more);
                    }
                    if let Some(frame) = screen.diff() {
                        let _ = session.events.send(Event::Frame(frame));
                    }
                    // Retain the final screen (both altitudes): the VT thread
                    // ends here, but attach must keep working postmortem.
                    *session.final_frame.lock().unwrap() = Some(screen.snapshot());
                    *session.final_vt.lock().unwrap() = Some(screen.vt_dump());
                    session.info.lock().unwrap().status = SessionStatus::Exited { code };
                    session.environment.cleanup();
                    let _ = session.events.send(Event::Exited { code });
                    return;
                }
                Err(_) => return,
            },
            default(FRAME_INTERVAL) => {
                if pending {
                    emit_now!(frames_coalesced);
                }
            },
        }
    }
}
