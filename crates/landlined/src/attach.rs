//! Terminal attach client.
//!
//! `frames` mode is a deliberately dumb renderer: it paints frames the
//! daemon sends and forwards raw stdin bytes back — the same job the mobile
//! client will do, which is the point: attaching validates the protocol,
//! not a second emulator.
//!
//! `bytes` mode is the opposite altitude: raw PTY passthrough into the
//! hosting terminal's own emulator. This is the universal shim — any
//! frontend that can run a command in a pane can run `landline attach
//! --mode bytes` and host a landline session.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};

use anyhow::{Context, Result};
use landline_proto::wire::{
    AttachMode, CellData, Cursor, Frame, Request, Response, RowData, cellflags,
};

/// Detach key: Ctrl-\ (0x1C). Rarely used by TUIs (SIGQUIT char).
const DETACH_BYTE: u8 = 0x1c;

pub fn run(socket: &Path, session: &str, mode: AttachMode) -> Result<()> {
    let mut stream = UnixStream::connect(socket).context("connect to daemon")?;
    let reader = BufReader::new(stream.try_clone()?);

    send(
        &mut stream,
        &Request::Attach {
            session: session.to_string(),
            mode,
        },
    )?;
    let (rows, cols) = term_size();
    send(&mut stream, &Request::Resize { rows, cols })?;
    forward_winch(stream.try_clone()?)?;

    let _raw = RawMode::enter()?;
    let mut out = std::io::stdout().lock();
    // Alternate screen + clear, so we restore the user's terminal on detach.
    // (In bytes mode the replayed dump re-enters alt screen itself if the
    // session is using it; nesting is harmless.)
    out.write_all(b"\x1b[?1049h\x1b[2J\x1b[H")?;
    out.flush()?;

    // Stdin -> daemon.
    {
        let mut stream = stream.try_clone()?;
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf[..n].contains(&DETACH_BYTE) {
                            let _ = send(&mut stream, &Request::Detach);
                            break;
                        }
                        if send(
                            &mut stream,
                            &Request::Input {
                                data: buf[..n].to_vec(),
                                seq: None,
                            },
                        )
                        .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
    }

    // Daemon -> screen.
    let mut exit_note = String::from("detached");
    for line in reader.lines() {
        let line = line?;
        match serde_json::from_str::<Response>(&line) {
            Ok(Response::Frame { frame }) => render(&mut out, &frame)?,
            Ok(Response::Bytes { data }) => {
                out.write_all(&data)?;
                out.flush()?;
            }
            Ok(Response::Exited { code }) => {
                exit_note = format!("session exited (code {:?})", code);
                break;
            }
            Ok(Response::Error { message }) => {
                exit_note = format!("error: {message}");
                break;
            }
            _ => {}
        }
    }

    if mode == AttachMode::Bytes {
        // The replayed dump may have set modes (mouse tracking, bracketed
        // paste, margins); reset them before handing the terminal back.
        out.write_all(b"\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l")?;
    }
    out.write_all(b"\x1b[?1049l\x1b[0m\x1b[?25h")?;
    out.flush()?;
    drop(_raw);
    eprintln!("[landline: {exit_note}]");
    Ok(())
}

/// SIGWINCH -> Resize. Self-pipe: the handler only does an async-signal-safe
/// write; a thread reads the pipe and re-measures the terminal. Mandatory
/// for shim hosting, where the surrounding pane resizes under us.
fn forward_winch(mut stream: UnixStream) -> Result<()> {
    static PIPE_W: AtomicI32 = AtomicI32::new(-1);
    extern "C" fn on_winch(_: libc::c_int) {
        let fd = PIPE_W.load(Ordering::Relaxed);
        if fd >= 0 {
            // SAFETY: write(2) is async-signal-safe; fd outlives the process.
            unsafe { libc::write(fd, b"w".as_ptr().cast(), 1) };
        }
    }
    let mut fds = [0i32; 2];
    // SAFETY: plain pipe(2) with a stack out-param.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        anyhow::bail!("pipe for SIGWINCH failed");
    }
    PIPE_W.store(fds[1], Ordering::Relaxed);
    // SAFETY: installing a handler that only touches async-signal-safe state.
    unsafe { libc::signal(libc::SIGWINCH, on_winch as *const () as libc::sighandler_t) };
    let read_fd = fds[0];
    std::thread::spawn(move || {
        let mut buf = [0u8; 16];
        loop {
            // SAFETY: blocking read on our own pipe fd.
            let n = unsafe { libc::read(read_fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break;
            }
            let (rows, cols) = term_size();
            if send(&mut stream, &Request::Resize { rows, cols }).is_err() {
                break;
            }
        }
    });
    Ok(())
}

fn send(stream: &mut UnixStream, req: &Request) -> Result<()> {
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    Ok(())
}

fn render(out: &mut impl Write, frame: &Frame) -> Result<()> {
    let (lines, cursor) = match frame {
        Frame::Snapshot { lines, cursor, .. } => {
            out.write_all(b"\x1b[2J")?;
            (lines, cursor)
        }
        Frame::Diff { lines, cursor, .. } => (lines, cursor),
    };
    out.write_all(b"\x1b[?25l")?;
    for row in lines {
        render_row(out, row)?;
    }
    place_cursor(out, cursor)?;
    out.flush()?;
    Ok(())
}

fn render_row(out: &mut impl Write, row: &RowData) -> Result<()> {
    write!(out, "\x1b[{};1H", row.y + 1)?;
    let mut last_sgr = String::new();
    for cell in &row.cells {
        if cell.fl & cellflags::WIDE_SPACER != 0 {
            continue; // wide base cell already advanced the cursor
        }
        let sgr = sgr_for(cell);
        if sgr != last_sgr {
            write!(out, "\x1b[0m{sgr}")?;
            last_sgr = sgr;
        }
        if cell.t.is_empty() {
            out.write_all(b" ")?;
        } else {
            out.write_all(cell.t.as_bytes())?;
        }
    }
    out.write_all(b"\x1b[0m\x1b[K")?;
    Ok(())
}

fn sgr_for(cell: &CellData) -> String {
    let mut s = String::new();
    if cell.fl & cellflags::BOLD != 0 {
        s.push_str("\x1b[1m");
    }
    if cell.fl & cellflags::FAINT != 0 {
        s.push_str("\x1b[2m");
    }
    if cell.fl & cellflags::ITALIC != 0 {
        s.push_str("\x1b[3m");
    }
    if cell.fl & cellflags::UNDERLINE != 0 {
        s.push_str("\x1b[4m");
    }
    if cell.fl & cellflags::INVERSE != 0 {
        s.push_str("\x1b[7m");
    }
    if cell.fl & cellflags::STRIKETHROUGH != 0 {
        s.push_str("\x1b[9m");
    }
    if let Some([r, g, b]) = cell.fg {
        s.push_str(&format!("\x1b[38;2;{r};{g};{b}m"));
    }
    if let Some([r, g, b]) = cell.bg {
        s.push_str(&format!("\x1b[48;2;{r};{g};{b}m"));
    }
    s
}

fn place_cursor(out: &mut impl Write, cursor: &Cursor) -> Result<()> {
    if cursor.visible {
        write!(out, "\x1b[{};{}H\x1b[?25h", cursor.y + 1, cursor.x + 1)?;
    }
    Ok(())
}

fn term_size() -> (u16, u16) {
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

/// Puts stdin into raw mode; restores on drop.
struct RawMode {
    original: libc::termios,
}

impl RawMode {
    fn enter() -> Result<Self> {
        // SAFETY: standard tcgetattr/cfmakeraw/tcsetattr sequence on stdin.
        unsafe {
            let mut original: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut original) != 0 {
                anyhow::bail!("stdin is not a terminal");
            }
            let mut raw = original;
            libc::cfmakeraw(&mut raw);
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw);
            Ok(Self { original })
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: restoring the termios captured in `enter`.
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.original);
        }
    }
}
