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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use crossbeam_channel as xchan;
use landline_proto::wire::{Frame, SessionInfo, SessionStatus};
use tokio::sync::broadcast;

use crate::environment::{Environment, LaunchSpec, Launched};
use crate::screen::{GhosttyScreen, Screen};

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

pub struct Session {
    pub info: Mutex<SessionInfo>,
    pub input_tx: xchan::Sender<Vec<u8>>,
    pub ctl_tx: xchan::Sender<Ctl>,
    pub events: broadcast::Sender<Event>,
    /// Raw PTY output tee for bytes-mode clients.
    pub bytes: broadcast::Sender<Vec<u8>>,
    pub killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pub environment: Box<dyn Environment>,
    /// Last screen of an exited session, servable postmortem.
    pub final_frame: Mutex<Option<Frame>>,
    pub final_vt: Mutex<Option<Vec<u8>>>,
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
        let (input_tx, input_rx) = xchan::bounded::<Vec<u8>>(256);
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
        });

        // Reader: PTY output -> VT thread, teed to bytes-mode subscribers.
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        let _ = bytes.send(chunk.clone()); // no subscribers is fine
                        if out_tx.send(chunk).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Writer: client input -> PTY.
        std::thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });

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
    loop {
        xchan::select! {
            recv(out_rx) -> msg => match msg {
                Ok(data) => {
                    screen.write(&data);
                    // Drain whatever else is queued before diffing.
                    while let Ok(more) = out_rx.try_recv() {
                        screen.write(&more);
                    }
                    pending = true;
                }
                Err(_) => { /* reader gone; keep serving ctl until exit */ }
            },
            recv(ctl_rx) -> msg => match msg {
                Ok(Ctl::Snapshot(reply)) => {
                    let _ = reply.send(screen.snapshot());
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
                    pending = true;
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
                    pending = false;
                    if let Some(frame) = screen.diff() {
                        let _ = session.events.send(Event::Frame(frame));
                    }
                }
            },
        }
    }
}
