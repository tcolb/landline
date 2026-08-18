//! Execution environments: where a session's process runs.
//!
//! `host` runs a plain process on the daemon's machine. `container` wraps the
//! command in `docker run`/`podman run` — the container's TTY *is* the
//! session PTY, so screen handling is identical across environments. Later
//! impls (microVM, remote, hosted) plug in behind the same trait.
//!
//! The contract: provision whatever isolation is needed, hand back a live
//! PTY around the launched command, and tear the isolation down on cleanup.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::config::EnvironmentSpec;

pub struct LaunchSpec {
    pub cmd: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
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
    /// Tear down anything `launch` provisioned (containers, mounts).
    /// Called on kill and after the session's child exits. Must be idempotent.
    fn cleanup(&self) {}
}

fn open_pty(spec: &LaunchSpec, cmd: CommandBuilder) -> Result<Launched> {
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;
    let child = pty.slave.spawn_command(cmd).context("spawn command")?;
    let killer = child.clone_killer();
    Ok(Launched {
        master: pty.master,
        child,
        killer,
    })
}

pub struct HostEnvironment;

impl Environment for HostEnvironment {
    fn launch(&self, spec: &LaunchSpec) -> Result<Launched> {
        let mut cmd = CommandBuilder::new(&spec.cmd[0]);
        cmd.args(&spec.cmd[1..]);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        open_pty(spec, cmd)
    }
}

/// One container per session; `runtime run` is the PTY command, so the
/// container's lifetime is the session's. Works with docker and podman —
/// the flag subset used here is CLI-compatible across both.
pub struct ContainerEnvironment {
    runtime: String, // resolved binary
    spec: EnvironmentSpec,
    container_name: String,
}

impl ContainerEnvironment {
    pub fn new(spec: EnvironmentSpec, session_id: &str) -> Result<Self> {
        let runtime = resolve_runtime(&spec.runtime)?;
        Ok(Self {
            runtime,
            spec,
            container_name: format!("landline-{session_id}"),
        })
    }

    /// The full `runtime run ...` argv wrapping `inner`. Pure; unit-tested.
    fn run_command(&self, launch: &LaunchSpec) -> Result<Vec<String>> {
        let spec = &self.spec;
        let image = spec
            .image
            .as_deref()
            .context("container environment has no image")?;
        let mut argv = vec![
            self.runtime.clone(),
            "run".into(),
            "--rm".into(),
            "-it".into(),
            "--name".into(),
            self.container_name.clone(),
            "-e".into(),
            "TERM=xterm-256color".into(),
        ];
        for (k, v) in &launch.env {
            argv.push("-e".into());
            argv.push(format!("{k}={v}"));
        }
        if spec.mount_workspace {
            argv.push("-v".into());
            argv.push(format!("{}:/workspace", launch.cwd.display()));
            argv.push("-w".into());
            argv.push("/workspace".into());
        }
        for mount in &spec.mounts {
            argv.push("-v".into());
            argv.push(mount.clone());
        }
        if let Some(network) = &spec.network {
            argv.push(format!("--network={network}"));
        }
        if let Some(memory) = &spec.memory {
            argv.push(format!("--memory={memory}"));
        }
        if let Some(cpus) = &spec.cpus {
            argv.push(format!("--cpus={cpus}"));
        }
        argv.extend(spec.extra_args.iter().cloned());
        argv.push(image.to_string());
        argv.extend(launch.cmd.iter().cloned());
        Ok(argv)
    }
}

impl Environment for ContainerEnvironment {
    fn launch(&self, spec: &LaunchSpec) -> Result<Launched> {
        let argv = self.run_command(spec)?;
        let mut cmd = CommandBuilder::new(&argv[0]);
        cmd.args(&argv[1..]);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        open_pty(spec, cmd)
    }

    fn cleanup(&self) {
        // Idempotent; ignore "no such container".
        let _ = std::process::Command::new(&self.runtime)
            .args(["rm", "-f", &self.container_name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Find the container runtime binary. `LANDLINE_CONTAINER_RUNTIME` overrides
/// everything (also how tests inject a stub runtime).
fn resolve_runtime(preference: &str) -> Result<String> {
    if let Ok(bin) = std::env::var("LANDLINE_CONTAINER_RUNTIME") {
        return Ok(bin);
    }
    let candidates: &[&str] = match preference {
        "auto" | "" => &["docker", "podman"],
        one => &[one],
    };
    for bin in candidates {
        if which(bin) {
            return Ok((*bin).to_string());
        }
    }
    bail!("no container runtime found (tried {candidates:?}); install docker or podman")
}

fn which(bin: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .any(|dir| std::path::Path::new(dir).join(bin).is_file())
}

/// Build the environment object for a resolved spec.
pub fn from_spec(spec: &EnvironmentSpec, session_id: &str) -> Result<Box<dyn Environment>> {
    match spec.kind.as_str() {
        "host" => Ok(Box::new(HostEnvironment)),
        "container" => Ok(Box::new(ContainerEnvironment::new(
            spec.clone(),
            session_id,
        )?)),
        other => bail!("unknown environment type '{other}'"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(cmd: &[&str]) -> LaunchSpec {
        LaunchSpec {
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
            cwd: PathBuf::from("/proj"),
            env: vec![("FOO".into(), "bar".into())],
            rows: 24,
            cols: 80,
        }
    }

    #[test]
    fn container_run_command_shape() {
        let mut spec = EnvironmentSpec::container("ubuntu:24.04");
        spec.memory = Some("2g".into());
        spec.mounts = vec!["/data:/data:ro".into()];
        let env = ContainerEnvironment {
            runtime: "docker".into(),
            spec,
            container_name: "landline-s1".into(),
        };
        let argv = env.run_command(&launch(&["htop"])).unwrap();
        let joined = argv.join(" ");
        assert!(joined.starts_with("docker run --rm -it --name landline-s1"));
        assert!(joined.contains("-e FOO=bar"));
        assert!(joined.contains("-v /proj:/workspace -w /workspace"));
        assert!(joined.contains("-v /data:/data:ro"));
        assert!(joined.contains("--memory=2g"));
        assert!(joined.ends_with("ubuntu:24.04 htop"));
        // image comes after all flags, command after image
        let img = argv.iter().position(|a| a == "ubuntu:24.04").unwrap();
        assert_eq!(argv[img + 1], "htop");
        assert_eq!(img + 2, argv.len());
    }

    #[test]
    fn no_workspace_mount_when_disabled() {
        let mut spec = EnvironmentSpec::container("alpine");
        spec.mount_workspace = false;
        let env = ContainerEnvironment {
            runtime: "podman".into(),
            spec,
            container_name: "landline-s2".into(),
        };
        let argv = env.run_command(&launch(&["sh"])).unwrap();
        assert!(!argv.join(" ").contains("/workspace"));
    }
}
