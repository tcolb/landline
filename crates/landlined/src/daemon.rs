//! The landlined daemon: session registry + control API.
//!
//! Two transports, one protocol: newline-delimited JSON over the unix
//! socket, one JSON message per text frame over WebSocket. Both are pumped
//! into a channel pair and served by the same dispatch loop, so transport
//! code never touches protocol logic.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use crossbeam_channel as xchan;
use landline_proto::wire::{
    AttachMode, FEATURES, Frame, PROTOCOL_VERSION, Request, Response, SessionEvent,
    SessionEventKind, SessionInfo, SessionStatus, SpawnRequest,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

use crate::config::Hooks;
use crate::environment::LaunchSpec;
use crate::session::{Ctl, Event, Session};
use crate::spawn::resolve;

pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
    /// Global lifecycle events (`watch` subscribers).
    pub events: broadcast::Sender<SessionEvent>,
    hooks: Hooks,
}

impl Registry {
    pub fn new(hooks: Hooks) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            events,
            hooks,
        }
    }

    fn insert(&self, session: Arc<Session>) {
        let id = session.info.lock().unwrap().id.clone();
        self.sessions.lock().unwrap().insert(id, session);
    }

    fn get(&self, key: &str) -> Option<Arc<Session>> {
        let sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.get(key) {
            return Some(s.clone());
        }
        // By name: prefer a running session over exited ones with that name.
        let named: Vec<_> = sessions
            .values()
            .filter(|s| s.info.lock().unwrap().name == key)
            .cloned()
            .collect();
        named
            .iter()
            .find(|s| s.status() == SessionStatus::Running)
            .or_else(|| named.first())
            .cloned()
    }

    fn list(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<SessionInfo> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.lock().unwrap().clone())
            .collect();
        infos.sort_by(|a, b| a.id.cmp(&b.id));
        infos
    }

    fn fresh_id(&self) -> String {
        format!("s{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn emit(&self, kind: SessionEventKind, info: SessionInfo) {
        let event = SessionEvent { kind, info };
        let _ = self.events.send(event.clone());
        let hook = match kind {
            SessionEventKind::Created => &self.hooks.session_created,
            SessionEventKind::Exited => &self.hooks.session_exited,
        };
        run_hook(hook, &event);
    }
}

/// Run a lifecycle hook detached; never blocks or fails the daemon.
fn run_hook(cmd: &Option<String>, event: &SessionEvent) {
    let Some(cmd) = cmd else { return };
    let mut c = std::process::Command::new("sh");
    c.arg("-c")
        .arg(cmd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env(
            "LANDLINE_EVENT",
            match event.kind {
                SessionEventKind::Created => "session_created",
                SessionEventKind::Exited => "session_exited",
            },
        )
        .env("LANDLINE_SESSION_ID", &event.info.id)
        .env("LANDLINE_SESSION_NAME", &event.info.name)
        .env("LANDLINE_SESSION_ENVIRONMENT", &event.info.environment)
        .env("LANDLINE_SESSION_CWD", &event.info.cwd);
    if let SessionStatus::Exited { code } = &event.info.status {
        c.env(
            "LANDLINE_EXIT_CODE",
            code.map_or("?".into(), |c| c.to_string()),
        );
    }
    match c.spawn() {
        // Reap in the background so hooks never leave zombies.
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => tracing::warn!("hook failed to start: {e}"),
    }
}

pub async fn run(socket: PathBuf, ws: Option<std::net::SocketAddr>) -> Result<()> {
    // Refuse to clobber a live daemon; clean up a stale socket.
    if socket.exists() {
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            anyhow::bail!("daemon already running on {}", socket.display());
        }
        std::fs::remove_file(&socket).ok();
    }
    let listener =
        UnixListener::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
    tracing::info!("landlined listening on {}", socket.display());

    let registry = Arc::new(Registry::new(crate::config::load_daemon_config().hooks));

    if let Some(addr) = ws {
        let registry = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::web::run(addr, registry).await {
                tracing::error!("websocket server failed: {e:#}");
            }
        });
    }

    loop {
        let (stream, _) = listener.accept().await?;
        let registry = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_unix(stream, registry).await {
                tracing::debug!("connection ended: {e}");
            }
        });
    }
}

/// One connected client, transport-erased: JSON strings in and out.
pub struct Client {
    pub rx: mpsc::Receiver<String>,
    pub tx: mpsc::Sender<String>,
}

impl Client {
    async fn send(&self, resp: &Response) -> Result<()> {
        self.tx
            .send(serde_json::to_string(resp)?)
            .await
            .map_err(|_| anyhow::anyhow!("client writer gone"))
    }
}

/// Pump a unix stream into a `Client` and serve it.
async fn handle_unix(stream: UnixStream, registry: Arc<Registry>) -> Result<()> {
    let (r, mut w) = stream.into_split();
    let (in_tx, in_rx) = mpsc::channel::<String>(64);
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);

    tokio::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if in_tx.send(line).await.is_err() {
                break;
            }
        }
    });
    tokio::spawn(async move {
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if w.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    serve_client(
        Client {
            rx: in_rx,
            tx: out_tx,
        },
        registry,
    )
    .await
}

/// The dispatch loop shared by every transport.
pub async fn serve_client(mut client: Client, registry: Arc<Registry>) -> Result<()> {
    while let Some(line) = client.rx.recv().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                client
                    .send(&Response::Error {
                        message: format!("bad request: {e}"),
                    })
                    .await?;
                continue;
            }
        };
        match req {
            Request::Hello { version: _ } => {
                client
                    .send(&Response::Hello {
                        version: PROTOCOL_VERSION,
                        features: FEATURES.iter().map(|s| s.to_string()).collect(),
                    })
                    .await?;
            }
            Request::Spawn { spawn } => {
                // Resolution can do file IO and git operations; keep it off
                // the async runtime.
                let registry = registry.clone();
                let resp = tokio::task::spawn_blocking(move || do_spawn(&registry, &spawn)).await?;
                client.send(&resp).await?;
            }
            Request::Ls => {
                client
                    .send(&Response::Sessions {
                        sessions: registry.list(),
                    })
                    .await?;
            }
            Request::Kill { session } => {
                let resp = match registry.get(&session) {
                    Some(s) => {
                        s.kill();
                        Response::Ok
                    }
                    None => Response::Error {
                        message: format!("no session {session}"),
                    },
                };
                client.send(&resp).await?;
            }
            Request::Watch => {
                // Watch consumes the rest of this connection.
                return watching(client, &registry).await;
            }
            Request::Attach { session, mode } => {
                match registry.get(&session) {
                    Some(s) => {
                        // Attach consumes the rest of this connection.
                        return match mode {
                            AttachMode::Frames => attached_frames(client, &s).await,
                            AttachMode::Bytes => attached_bytes(client, &s).await,
                        };
                    }
                    None => {
                        client
                            .send(&Response::Error {
                                message: format!("no session {session}"),
                            })
                            .await?;
                    }
                }
            }
            Request::Input { .. } | Request::Resize { .. } | Request::Detach => {
                client
                    .send(&Response::Error {
                        message: "not attached".into(),
                    })
                    .await?;
            }
        }
    }
    Ok(())
}

fn do_spawn(registry: &Arc<Registry>, req: &SpawnRequest) -> Response {
    let id = registry.fresh_id();
    let resolved = match resolve(req, &id) {
        Ok(r) => r,
        Err(e) => {
            return Response::Error {
                message: format!("spawn failed: {e:#}"),
            };
        }
    };
    let environment = match crate::environment::from_spec(&resolved.environment, &id) {
        Ok(env) => env,
        Err(e) => {
            return Response::Error {
                message: format!("spawn failed: {e:#}"),
            };
        }
    };
    let info = SessionInfo {
        id: id.clone(),
        name: resolved.name.clone().unwrap_or_else(|| id.clone()),
        cmd: resolved.cmd.clone(),
        cwd: resolved.cwd.display().to_string(),
        environment: resolved.environment.label(),
        rows: req.rows,
        cols: req.cols,
        status: SessionStatus::Running,
    };
    let spec = LaunchSpec {
        cmd: resolved.final_cmd,
        cwd: resolved.cwd,
        env: resolved.env,
        rows: req.rows,
        cols: req.cols,
    };
    match Session::spawn(environment, info.clone(), &spec) {
        Ok(session) => {
            registry.insert(session.clone());
            registry.emit(SessionEventKind::Created, info.clone());
            monitor_exit(registry.clone(), session);
            Response::Spawned { info }
        }
        Err(e) => Response::Error {
            message: format!("spawn failed: {e:#}"),
        },
    }
}

/// Emit the global exited event (and hook) when a session's child ends.
fn monitor_exit(registry: Arc<Registry>, session: Arc<Session>) {
    tokio::spawn(async move {
        let mut events = session.events.subscribe();
        // The VT thread sets status before broadcasting, so checking status
        // first closes the subscribe-after-exit race.
        while session.status() == SessionStatus::Running {
            match events.recv().await {
                Ok(Event::Exited { .. }) | Err(broadcast::error::RecvError::Closed) => break,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
        let info = session.info.lock().unwrap().clone();
        registry.emit(SessionEventKind::Exited, info);
    });
}

/// Forward global lifecycle events until the client goes away.
async fn watching(mut client: Client, registry: &Arc<Registry>) -> Result<()> {
    let mut events = registry.events.subscribe();
    client.send(&Response::Ok).await?;
    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(event) => client.send(&Response::Event { event }).await?,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return Ok(()),
            },
            line = client.rx.recv() => {
                let Some(line) = line else { return Ok(()) };
                match serde_json::from_str::<Request>(&line) {
                    Ok(Request::Detach) => return Ok(()),
                    _ => {
                        client.send(&Response::Error {
                            message: "watching; only detach is valid".into(),
                        }).await?;
                    }
                }
            }
        }
    }
}

/// Ask the VT thread for a full frame; `None` if it's gone (session exited).
async fn live_snapshot(session: &Arc<Session>) -> Result<Option<Frame>> {
    let (reply_tx, reply_rx) = xchan::bounded::<Frame>(1);
    if session.ctl_tx.send(Ctl::Snapshot(reply_tx)).is_err() {
        return Ok(None);
    }
    let frame = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await?;
    Ok(frame.ok())
}

/// Ask the VT thread for a VT-reconstruction dump; `None` if it's gone.
async fn live_vt_snapshot(session: &Arc<Session>) -> Result<Option<Vec<u8>>> {
    let (reply_tx, reply_rx) = xchan::bounded::<Vec<u8>>(1);
    if session.ctl_tx.send(Ctl::VtSnapshot(reply_tx)).is_err() {
        return Ok(None);
    }
    let data = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await?;
    Ok(data.ok())
}

/// Handle client input while attached (either mode). Returns false on detach.
async fn attached_input(
    client: &Client,
    session: &Arc<Session>,
    line: Option<String>,
) -> Result<bool> {
    let Some(line) = line else { return Ok(false) };
    match serde_json::from_str::<Request>(&line) {
        Ok(Request::Input { data }) => {
            let _ = session.input_tx.send(data);
        }
        Ok(Request::Resize { rows, cols }) => {
            let _ = session.ctl_tx.send(Ctl::Resize { rows, cols });
        }
        Ok(Request::Detach) => return Ok(false),
        Ok(_) => {
            client
                .send(&Response::Error {
                    message: "already attached".into(),
                })
                .await?;
        }
        Err(e) => {
            client
                .send(&Response::Error {
                    message: format!("bad request: {e}"),
                })
                .await?;
        }
    }
    Ok(true)
}

async fn attached_frames(mut client: Client, session: &Arc<Session>) -> Result<()> {
    let mut events = session.events.subscribe();

    match live_snapshot(session).await? {
        Some(frame) => client.send(&Response::Frame { frame }).await?,
        // VT thread gone: serve the retained final screen.
        None => {
            let frame = session.final_frame.lock().unwrap().clone();
            if let Some(frame) = frame {
                client.send(&Response::Frame { frame }).await?;
            }
        }
    }
    if let SessionStatus::Exited { code } = session.status() {
        client.send(&Response::Exited { code }).await?;
        return Ok(());
    }

    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(Event::Frame(frame)) => client.send(&Response::Frame { frame }).await?,
                Ok(Event::Exited { code }) => {
                    client.send(&Response::Exited { code }).await?;
                    return Ok(());
                }
                // Lagged: we dropped frames; resync with a fresh snapshot.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(frame) = live_snapshot(session).await? {
                        client.send(&Response::Frame { frame }).await?;
                    }
                }
                Err(_) => return Ok(()),
            },
            line = client.rx.recv() => {
                if !attached_input(&client, session, line).await? {
                    return Ok(());
                }
            }
        }
    }
}

async fn attached_bytes(mut client: Client, session: &Arc<Session>) -> Result<()> {
    // Subscribe to the raw tee *before* taking the reconstruction snapshot,
    // so no output falls between snapshot and stream.
    let mut bytes = session.bytes.subscribe();
    let mut events = session.events.subscribe();

    match live_vt_snapshot(session).await? {
        Some(data) => client.send(&Response::Bytes { data }).await?,
        None => {
            let data = session.final_vt.lock().unwrap().clone();
            if let Some(data) = data {
                client.send(&Response::Bytes { data }).await?;
            }
        }
    }
    if let SessionStatus::Exited { code } = session.status() {
        client.send(&Response::Exited { code }).await?;
        return Ok(());
    }

    loop {
        tokio::select! {
            // Raw output first so exit notices don't overtake queued bytes.
            biased;
            chunk = bytes.recv() => match chunk {
                Ok(data) => client.send(&Response::Bytes { data }).await?,
                // Lagged: the raw stream has a hole; resync with a fresh
                // reconstruction (same recovery as frames mode).
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(data) = live_vt_snapshot(session).await? {
                        client.send(&Response::Bytes { data }).await?;
                    }
                }
                Err(_) => { /* reader gone; wait for the exit event */ }
            },
            ev = events.recv() => match ev {
                Ok(Event::Exited { code }) => {
                    // Drain output that raced the exit notification.
                    while let Ok(data) = bytes.try_recv() {
                        client.send(&Response::Bytes { data }).await?;
                    }
                    client.send(&Response::Exited { code }).await?;
                    return Ok(());
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return Ok(()),
            },
            line = client.rx.recv() => {
                if !attached_input(&client, session, line).await? {
                    return Ok(());
                }
            }
        }
    }
}
