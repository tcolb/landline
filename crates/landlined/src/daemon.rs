//! The landlined daemon: session registry + unix socket control API.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use crossbeam_channel as xchan;
use landline_proto::wire::{Frame, Request, Response, SessionInfo, SessionStatus, SpawnRequest};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::environment::LaunchSpec;
use crate::session::{Ctl, Event, Session};
use crate::spawn::resolve;

#[derive(Default)]
pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}

impl Registry {
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
}

pub async fn run(socket: PathBuf) -> Result<()> {
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

    let registry = Arc::new(Registry::default());
    loop {
        let (stream, _) = listener.accept().await?;
        let registry = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, registry).await {
                tracing::debug!("connection ended: {e}");
            }
        });
    }
}

async fn send(w: &mut (impl AsyncWriteExt + Unpin), resp: &Response) -> Result<()> {
    let mut line = serde_json::to_string(resp)?;
    line.push('\n');
    w.write_all(line.as_bytes()).await?;
    Ok(())
}

async fn handle_conn(stream: UnixStream, registry: Arc<Registry>) -> Result<()> {
    let (r, mut w) = stream.into_split();
    let mut lines = BufReader::new(r).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                send(
                    &mut w,
                    &Response::Error {
                        message: format!("bad request: {e}"),
                    },
                )
                .await?;
                continue;
            }
        };
        match req {
            Request::Spawn { spawn } => {
                // Resolution can do file IO and git operations; keep it off
                // the async runtime.
                let registry = registry.clone();
                let resp = tokio::task::spawn_blocking(move || do_spawn(&registry, &spawn)).await?;
                send(&mut w, &resp).await?;
            }
            Request::Ls => {
                send(
                    &mut w,
                    &Response::Sessions {
                        sessions: registry.list(),
                    },
                )
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
                send(&mut w, &resp).await?;
            }
            Request::Attach { session } => {
                match registry.get(&session) {
                    Some(s) => {
                        // Attach consumes the rest of this connection.
                        return attached(&mut w, &mut lines, &s).await;
                    }
                    None => {
                        send(
                            &mut w,
                            &Response::Error {
                                message: format!("no session {session}"),
                            },
                        )
                        .await?;
                    }
                }
            }
            Request::Input { .. } | Request::Resize { .. } | Request::Detach => {
                send(
                    &mut w,
                    &Response::Error {
                        message: "not attached".into(),
                    },
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn do_spawn(registry: &Registry, req: &SpawnRequest) -> Response {
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
            registry.insert(session);
            Response::Spawned { info }
        }
        Err(e) => Response::Error {
            message: format!("spawn failed: {e:#}"),
        },
    }
}

async fn attached(
    w: &mut (impl AsyncWriteExt + Unpin),
    lines: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    session: &Arc<Session>,
) -> Result<()> {
    let mut events = session.events.subscribe();

    // Snapshot request must not race a concurrent exit: if the VT thread is
    // gone the ctl send fails and we fall back to reporting exit status.
    let (reply_tx, reply_rx) = xchan::bounded::<Frame>(1);
    if session.ctl_tx.send(Ctl::Snapshot(reply_tx)).is_ok() {
        let frame = tokio::task::spawn_blocking(move || {
            reply_rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await??;
        send(w, &Response::Frame { frame }).await?;
    }
    if let SessionStatus::Exited { code } = session.status() {
        send(w, &Response::Exited { code }).await?;
        return Ok(());
    }

    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(Event::Frame(frame)) => send(w, &Response::Frame { frame }).await?,
                Ok(Event::Exited { code }) => {
                    send(w, &Response::Exited { code }).await?;
                    return Ok(());
                }
                // Lagged: we dropped frames; resync with a fresh snapshot.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let (reply_tx, reply_rx) = xchan::bounded::<Frame>(1);
                    if session.ctl_tx.send(Ctl::Snapshot(reply_tx)).is_ok() {
                        let frame = tokio::task::spawn_blocking(move || {
                            reply_rx.recv_timeout(std::time::Duration::from_secs(5))
                        }).await??;
                        send(w, &Response::Frame { frame }).await?;
                    }
                }
                Err(_) => return Ok(()),
            },
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                match serde_json::from_str::<Request>(&line) {
                    Ok(Request::Input { data }) => {
                        let _ = session.input_tx.send(data);
                    }
                    Ok(Request::Resize { rows, cols }) => {
                        let _ = session.ctl_tx.send(Ctl::Resize { rows, cols });
                    }
                    Ok(Request::Detach) => return Ok(()),
                    Ok(_) => {
                        send(w, &Response::Error {
                            message: "already attached".into(),
                        }).await?;
                    }
                    Err(e) => {
                        send(w, &Response::Error {
                            message: format!("bad request: {e}"),
                        }).await?;
                    }
                }
            }
        }
    }
}
