//! Resolve a `SpawnRequest` (template reference or inline command, plus
//! overrides) into a concrete launch: final command, workspace directory,
//! environment, env vars. All registry lookups and `{{param}}` interpolation
//! happen here, daemon-side, so every client — CLI, mobile, other agents —
//! gets identical behavior.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use landline_proto::wire::SpawnRequest;

use crate::config::{self, EnvValue, EnvironmentSpec};

pub struct ResolvedSpawn {
    pub name: Option<String>,
    /// Chat mirror format, when the template declares one.
    pub chat: Option<String>,
    /// The harness command, before any setup wrapping.
    pub cmd: Vec<String>,
    /// Final command to exec in the PTY (setup-wrapped if needed).
    pub final_cmd: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub environment: EnvironmentSpec,
}

pub fn resolve(req: &SpawnRequest, session_id: &str) -> Result<ResolvedSpawn> {
    let request_cwd = req
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));

    let template = match &req.template {
        Some(name) => Some(config::load_template(name, &request_cwd)?),
        None => None,
    };
    let params = match &template {
        Some(t) => config::resolve_params(t, &req.params)?,
        None if req.params.is_empty() => HashMap::new(),
        None => bail!("params given but no template named"),
    };
    let interp = |s: &str| config::interpolate(s, &params);

    // Harness command: inline request > template harness.
    let cmd = if let Some(cmd) = &req.cmd {
        cmd.clone()
    } else if let Some(h) = template.as_ref().and_then(|t| t.harness.as_ref()) {
        let mut cmd = match (&h.use_name, &h.cmd) {
            (Some(name), _) => {
                let profile = config::load_harness(name, &request_cwd)?;
                let mut c = profile.cmd;
                c.extend(profile.args);
                c
            }
            (None, Some(cmd)) => cmd.clone(),
            (None, None) => bail!("template harness names no profile and no cmd"),
        };
        for arg in &h.args {
            cmd.push(interp(arg)?);
        }
        cmd
    } else {
        bail!("nothing to run: no command given and template has no harness")
    };
    if cmd.is_empty() {
        bail!("empty command");
    }

    // Workspace: where the session runs (host-side path; container
    // environments mount it at /workspace).
    let cwd = resolve_workspace(
        template.as_ref().map(|t| &t.workspace),
        &request_cwd,
        session_id,
        &interp,
    )?;

    // Environment precedence: --image > --env NAME > template inline image
    // > template `use` > host.
    let environment = if let Some(image) = &req.image {
        EnvironmentSpec::container(image)
    } else if let Some(name) = &req.env {
        config::load_environment(name, &request_cwd)?
    } else if let Some(te) = template.as_ref().map(|t| &t.environment) {
        if let Some(image) = &te.image {
            EnvironmentSpec::container(&interp(image)?)
        } else if let Some(name) = &te.use_name {
            config::load_environment(name, &request_cwd)?
        } else {
            EnvironmentSpec::host()
        }
    } else {
        EnvironmentSpec::host()
    };

    // Env vars: plain values interpolate; secrets come from the store.
    let mut env = Vec::new();
    if let Some(t) = &template {
        for (key, value) in &t.env {
            let value = match value {
                EnvValue::Plain(v) => interp(v)?,
                EnvValue::Secret { secret } => config::load_secret(secret)?,
            };
            env.push((key.clone(), value));
        }
        env.sort();
    }

    // Setup commands run inside the environment, in-session, before the
    // harness — output lands in the session like a CI log.
    let final_cmd = match template.as_ref().map(|t| &t.setup.run) {
        Some(run) if !run.is_empty() => {
            let mut script = String::from("set -e\n");
            for step in run {
                script.push_str(&interp(step)?);
                script.push('\n');
            }
            script.push_str("exec ");
            script.push_str(&shell_join(&cmd));
            vec!["sh".into(), "-lc".into(), script]
        }
        _ => cmd.clone(),
    };

    Ok(ResolvedSpawn {
        name: req.name.clone(),
        chat: template
            .as_ref()
            .and_then(|t| t.chat.as_ref())
            .map(|c| c.format.clone()),
        cmd,
        final_cmd,
        cwd,
        env,
        environment,
    })
}

fn resolve_workspace(
    workspace: Option<&config::Workspace>,
    request_cwd: &Path,
    session_id: &str,
    interp: &impl Fn(&str) -> Result<String>,
) -> Result<PathBuf> {
    let Some(ws) = workspace else {
        return Ok(request_cwd.to_path_buf());
    };
    let base = match &ws.dir {
        Some(dir) => {
            let dir = PathBuf::from(interp(dir)?);
            if dir.is_absolute() {
                dir
            } else {
                request_cwd.join(dir)
            }
        }
        None => request_cwd.to_path_buf(),
    };
    match ws.strategy.as_deref() {
        None | Some("dir") => Ok(base),
        Some("worktree") => {
            let git_ref = ws
                .git_ref
                .as_deref()
                .context("workspace strategy 'worktree' needs `ref`")?;
            let git_ref = interp(git_ref)?;
            let target =
                worktrees_dir().join(format!("{session_id}-{}", git_ref.replace('/', "-")));
            // Session ids restart per daemon boot; a stale worktree at the
            // target is disposable by construction.
            if target.exists() {
                let _ = std::fs::remove_dir_all(&target);
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&base)
                    .args(["worktree", "prune"])
                    .output();
            }
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&base)
                .args(["worktree", "add", "--force"])
                .arg(&target)
                .arg(&git_ref)
                .output()
                .context("run git worktree add")?;
            if !out.status.success() {
                bail!(
                    "git worktree add failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Ok(target)
        }
        Some("clone") => {
            // Repo-centric workspace: mirror-clone once into a shared cache,
            // fetch on reuse, then hand each session its own worktree. Git
            // auth is whatever the daemon host already has (ssh keys, forge
            // CLI credential helpers) — the daemon acts as the user.
            let repo = ws
                .repo
                .as_deref()
                .context("workspace strategy 'clone' needs `repo`")?;
            let repo = interp(repo)?;
            let git_ref = match ws.git_ref.as_deref() {
                Some(r) => interp(r)?,
                None => "HEAD".to_string(),
            };
            let cache = repos_dir().join(sanitize_repo(&repo));
            if !cache.exists() {
                std::fs::create_dir_all(repos_dir()).context("create repo cache dir")?;
                let out = std::process::Command::new("git")
                    .args(["clone", "--mirror"])
                    .arg(&repo)
                    .arg(&cache)
                    .output()
                    .context("run git clone --mirror")?;
                if !out.status.success() {
                    bail!(
                        "git clone failed for {repo}: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
            } else {
                // Refresh the mirror; a stale cache is worse than a slow
                // spawn. Failure is non-fatal (offline spawns still work).
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&cache)
                    .args(["fetch", "--prune"])
                    .output();
            }
            let target =
                worktrees_dir().join(format!("{session_id}-{}", git_ref.replace('/', "-")));
            if target.exists() {
                let _ = std::fs::remove_dir_all(&target);
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&cache)
                    .args(["worktree", "prune"])
                    .output();
            }
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&cache)
                .args(["worktree", "add", "--force"])
                .arg(&target)
                .arg(&git_ref)
                .output()
                .context("run git worktree add")?;
            if !out.status.success() {
                bail!(
                    "git worktree add failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Ok(target)
        }
        Some(other) => bail!("unknown workspace strategy '{other}'"),
    }
}

fn repos_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".local/share/landline/repos")
}

/// Filesystem-safe cache key for a repo URL.
fn sanitize_repo(url: &str) -> String {
    url.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn worktrees_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".local/share/landline/worktrees")
}

/// POSIX shell-quote and join an argv.
fn shell_join(cmd: &[String]) -> String {
    cmd.iter()
        .map(|arg| {
            if !arg.is_empty()
                && arg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+".contains(c))
            {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_join_quotes() {
        let cmd = vec!["echo".to_string(), "a b".to_string(), "it's".to_string()];
        assert_eq!(shell_join(&cmd), r#"echo 'a b' 'it'\''s'"#);
    }

    #[test]
    fn inline_spawn_resolves_host() {
        let req = SpawnRequest {
            cmd: Some(vec!["htop".into()]),
            cwd: Some("/tmp".into()),
            rows: 24,
            cols: 80,
            ..Default::default()
        };
        let r = resolve(&req, "s1").unwrap();
        assert_eq!(r.final_cmd, vec!["htop"]);
        assert_eq!(r.environment.kind, "host");
        assert_eq!(r.cwd, PathBuf::from("/tmp"));
    }

    #[test]
    fn image_shorthand_wins() {
        let req = SpawnRequest {
            cmd: Some(vec!["sh".into()]),
            image: Some("alpine".into()),
            cwd: Some("/tmp".into()),
            rows: 24,
            cols: 80,
            ..Default::default()
        };
        let r = resolve(&req, "s1").unwrap();
        assert_eq!(r.environment.kind, "container");
        assert_eq!(r.environment.image.as_deref(), Some("alpine"));
    }
}
