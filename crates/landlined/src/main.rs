mod attach;
mod chat;
mod config;
mod daemon;
mod harness;
mod environment;
mod paths;
mod screen;
mod session;
mod spawn;
mod stats;
mod web;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use landline_proto::wire::{Request, Response, SessionStatus, SpawnRequest};

#[derive(Parser)]
#[command(name = "landline", about = "Agent session runtime")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum ModeArg {
    /// Server-rendered cell frames (thin client).
    Frames,
    /// Raw PTY passthrough into this terminal's own emulator (shim mode).
    Bytes,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon in the foreground.
    Daemon {
        /// Also serve the protocol over WebSocket, e.g. 127.0.0.1:7070.
        /// Access requires the token in ~/.local/share/landline/ws-token.
        #[arg(long, value_name = "ADDR")]
        ws: Option<std::net::SocketAddr>,
    },
    /// Spawn a session from a template and/or an inline command:
    ///   landline spawn TEMPLATE [-p key=value]...
    ///   landline spawn [--env NAME | --image IMG] -- CMD [ARGS...]
    Spawn {
        /// Template name (looked up in .landline/templates/, then
        /// ~/.config/landline/templates/).
        template: Option<String>,
        /// Template parameter, key=value. Repeatable.
        #[arg(short = 'p', long = "param", value_name = "KEY=VALUE")]
        params: Vec<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        /// Named environment spec, or "host".
        #[arg(long)]
        env: Option<String>,
        /// Shorthand: per-session container with this image.
        #[arg(long)]
        image: Option<String>,
        /// Inline command; must follow `--` so it never swallows TEMPLATE.
        #[arg(last = true)]
        cmd: Vec<String>,
    },
    /// List sessions.
    Ls,
    /// Print a session's pipeline statistics (docs/PROFILING.md).
    Stats { session: String },
    /// List spawnable templates (project .landline/ shadows user config).
    Templates,
    /// List selectable environments.
    Environments,
    /// Kill a session by id or name.
    Kill { session: String },
    /// Attach to a session by id or name. Detach with Ctrl-\.
    Attach {
        session: String,
        /// frames: server-rendered cells. bytes: raw PTY passthrough for
        /// terminals with their own emulator (hosting landline in a pane).
        #[arg(long, value_enum, default_value = "frames")]
        mode: ModeArg,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let socket = paths::socket_path();
    match cli.command {
        Command::Daemon { ws } => tokio::runtime::Runtime::new()?.block_on(daemon::run(socket, ws)),
        Command::Spawn {
            template,
            params,
            name,
            cwd,
            env,
            image,
            cmd,
        } => {
            let mut parsed = std::collections::HashMap::new();
            for pair in params {
                let Some((k, v)) = pair.split_once('=') else {
                    anyhow::bail!("--param wants KEY=VALUE, got '{pair}'");
                };
                parsed.insert(k.to_string(), v.to_string());
            }
            let cwd = cwd.or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|d| d.display().to_string())
            });
            let (rows, cols) = client_term_size();
            let spawn = SpawnRequest {
                template,
                params: parsed,
                name,
                cmd: if cmd.is_empty() { None } else { Some(cmd) },
                cwd,
                env,
                image,
                rows,
                cols,
            };
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Spawn { spawn })? {
                Response::Spawned { info } => {
                    println!("{}\t{}\t{}", info.id, info.name, info.environment);
                    Ok(())
                }
                other => fail(other),
            }
        }
        Command::Ls => {
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Ls)? {
                Response::Sessions { sessions } => {
                    for s in sessions {
                        let status = match s.status {
                            SessionStatus::Running => "running".to_string(),
                            SessionStatus::Exited { code } => {
                                format!("exited({})", code.map_or("?".into(), |c| c.to_string()))
                            }
                        };
                        println!(
                            "{}\t{}\t{}\t{}\t{}x{}\t{}",
                            s.id,
                            s.name,
                            status,
                            s.environment,
                            s.cols,
                            s.rows,
                            s.cmd.join(" ")
                        );
                    }
                    Ok(())
                }
                other => fail(other),
            }
        }
        Command::Templates => {
            let cwd = std::env::current_dir()
                .ok()
                .map(|d| d.display().to_string());
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Templates { cwd })? {
                Response::Templates { templates } => {
                    for t in templates {
                        let params: Vec<String> = t
                            .params
                            .iter()
                            .map(|p| {
                                if p.required {
                                    format!("{}*", p.name)
                                } else {
                                    p.name.clone()
                                }
                            })
                            .collect();
                        println!(
                            "{}	{}	{}	[{}]	{}",
                            t.name,
                            t.environment,
                            t.command,
                            params.join(", "),
                            t.description.as_deref().unwrap_or("")
                        );
                    }
                    Ok(())
                }
                other => fail(other),
            }
        }
        Command::Environments => {
            let cwd = std::env::current_dir()
                .ok()
                .map(|d| d.display().to_string());
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Environments { cwd })? {
                Response::Environments { environments } => {
                    for e in environments {
                        println!(
                            "{}	{}	{}	{}",
                            e.name,
                            e.kind,
                            e.image.as_deref().unwrap_or("-"),
                            e.description.as_deref().unwrap_or("")
                        );
                    }
                    Ok(())
                }
                other => fail(other),
            }
        }
        Command::Stats { session } => {
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Stats { session })? {
                Response::Stats { stats } => {
                    println!("{}", serde_json::to_string_pretty(&stats)?);
                    Ok(())
                }
                other => fail(other),
            }
        }
        Command::Kill { session } => {
            let mut stream = connect_or_start(&socket)?;
            match roundtrip(&mut stream, &Request::Kill { session })? {
                Response::Ok => Ok(()),
                other => fail(other),
            }
        }
        Command::Attach { session, mode } => attach::run(
            &socket,
            &session,
            match mode {
                ModeArg::Frames => landline_proto::wire::AttachMode::Frames,
                ModeArg::Bytes => landline_proto::wire::AttachMode::Bytes,
            },
        ),
    }
}

fn fail(resp: Response) -> Result<()> {
    match resp {
        Response::Error { message } => anyhow::bail!("{message}"),
        other => anyhow::bail!("unexpected response: {other:?}"),
    }
}

fn roundtrip(stream: &mut UnixStream, req: &Request) -> Result<Response> {
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut resp_line = String::new();
    reader.read_line(&mut resp_line)?;
    Ok(serde_json::from_str(&resp_line)?)
}

/// Connect to the daemon, starting one in the background if none is running.
fn connect_or_start(socket: &std::path::Path) -> Result<UnixStream> {
    if let Ok(stream) = UnixStream::connect(socket) {
        return Ok(stream);
    }
    let exe = std::env::current_exe().context("current exe")?;
    let log = std::fs::File::create(paths::log_path()).context("open daemon log")?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log);
    // Detach into its own session so the daemon outlives the terminal
    // (and its process group) that spawned it.
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("start daemon")?;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(stream) = UnixStream::connect(socket) {
            return Ok(stream);
        }
    }
    anyhow::bail!(
        "daemon did not come up; see {}",
        paths::log_path().display()
    )
}

fn client_term_size() -> (u16, u16) {
    // SAFETY: plain ioctl on stdout with a zeroed winsize out-param.
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0
            && ws.ws_row > 0
            && ws.ws_col > 0
        {
            return (ws.ws_row, ws.ws_col);
        }
    }
    (24, 80)
}
