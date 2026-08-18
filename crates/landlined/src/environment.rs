//! Execution environments: where a session's process runs.
//!
//! `host` runs a plain process on the daemon's machine. M2 adds a per-session
//! docker environment; later impls (microVM, remote, hosted) plug in here.
//! The contract: provision whatever isolation is needed, then hand back a
//! live PTY around the launched command.

use std::path::PathBuf;

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub struct LaunchSpec {
    pub cmd: Vec<String>,
    pub cwd: PathBuf,
    pub rows: u16,
    pub cols: u16,
}

/// A session's live process inside its environment.
pub struct Launched {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
}

pub trait Environment: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> Result<Launched>;
}

pub struct HostEnvironment;

impl Environment for HostEnvironment {
    fn launch(&self, spec: &LaunchSpec) -> Result<Launched> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(&spec.cmd[0]);
        cmd.args(&spec.cmd[1..]);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pty.slave.spawn_command(cmd).context("spawn command")?;
        let killer = child.clone_killer();
        Ok(Launched {
            master: pty.master,
            child,
            killer,
        })
    }
}
