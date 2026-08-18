//! WebSocket transport + debug page.
//!
//! Speaks the exact protocol of the unix socket — one JSON message per text
//! frame — by pumping the socket into the same channel-erased `Client` the
//! unix listener uses. Access is gated by a bearer token generated on first
//! start (`?token=` query param); real authentication is relay work (M5).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::daemon::{Client, Registry, serve_client};
use crate::paths;

struct WebState {
    registry: Arc<Registry>,
    token: String,
}

pub async fn run(addr: SocketAddr, registry: Arc<Registry>) -> Result<()> {
    let token = load_or_create_token()?;
    let state = Arc::new(WebState { registry, token });
    let app = axum::Router::new()
        .route("/", get(page))
        .route("/ws", get(upgrade))
        .with_state(state);
    use axum::serve::ListenerExt;
    // Keystroke-sized packets must never wait on Nagle (responsiveness
    // budget, docs/DESIGN.md).
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?
        .tap_io(|stream| {
            let _ = stream.set_nodelay(true);
        });
    tracing::info!(
        "websocket API on http://{addr}/ (token in {})",
        paths::ws_token_path().display()
    );
    axum::serve(listener, app).await?;
    Ok(())
}

/// Random hex token, created 0600 on first use, stable across restarts.
fn load_or_create_token() -> Result<String> {
    let path = paths::ws_token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let mut raw = [0u8; 16];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom").context("open /dev/urandom")?,
        &mut raw,
    )?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}

async fn page() -> impl IntoResponse {
    Html(include_str!("debug.html"))
}

async fn upgrade(
    State(state): State<Arc<WebState>>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    if query.get("token") != Some(&state.token) {
        return (StatusCode::UNAUTHORIZED, "bad or missing token").into_response();
    }
    let registry = state.registry.clone();
    ws.on_upgrade(move |socket| handle(socket, registry))
}

async fn handle(socket: WebSocket, registry: Arc<Registry>) {
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::channel::<String>(64);
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);

    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    if in_tx.send(text.to_string()).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if sink.send(Message::Text(line.into())).await.is_err() {
                break;
            }
        }
    });

    let _ = serve_client(
        Client {
            rx: in_rx,
            tx: out_tx,
        },
        registry,
    )
    .await;
}
