//! Data registries: environment specs, harness profiles, templates, secrets.
//!
//! All TOML, all data, never code. Lookup order for every registry:
//! `<spawn cwd>/.landline/<kind>/NAME.toml` shadows
//! `~/.config/landline/<kind>/NAME.toml`.
//!
//! Interpolation is `{{param}}` substitution only; anything smarter belongs
//! in a template's `[setup]` script.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSpec {
    #[serde(rename = "type", default = "default_env_type")]
    pub kind: String, // "host" | "container"
    /// Container runtime: "docker" | "podman" | "auto" (default).
    #[serde(default = "default_runtime")]
    pub runtime: String,
    pub image: Option<String>,
    /// Extra mounts, "host_path:container_path" each.
    #[serde(default)]
    pub mounts: Vec<String>,
    /// Mount the session workspace at /workspace and start there. Default on.
    #[serde(default = "default_true")]
    pub mount_workspace: bool,
    pub network: Option<String>,
    pub memory: Option<String>,
    pub cpus: Option<String>,
    /// Escape hatch: raw args inserted before the image.
    #[serde(default)]
    pub extra_args: Vec<String>,
}

fn default_env_type() -> String {
    "host".into()
}
fn default_runtime() -> String {
    "auto".into()
}
fn default_true() -> bool {
    true
}

impl EnvironmentSpec {
    pub fn host() -> Self {
        Self {
            kind: "host".into(),
            ..Default::default()
        }
    }

    pub fn container(image: &str) -> Self {
        Self {
            kind: "container".into(),
            runtime: "auto".into(),
            image: Some(image.into()),
            mount_workspace: true,
            ..Default::default()
        }
    }

    /// Short human label for `ls`, e.g. "host" or "container:ubuntu".
    pub fn label(&self) -> String {
        match self.kind.as_str() {
            "container" => format!("container:{}", self.image.as_deref().unwrap_or("?")),
            other => other.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessProfile {
    pub cmd: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
// `schema`/`name`/`description` are format metadata, accepted but not yet
// consumed; `repo` is for the "clone" workspace strategy (later milestone).
#[allow(dead_code)]
pub struct Template {
    #[serde(default)]
    pub schema: Option<u32>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub params: HashMap<String, ParamSpec>,
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub environment: TemplateEnvironment,
    pub harness: Option<TemplateHarness>,
    #[serde(default)]
    pub setup: Setup,
    #[serde(default)]
    pub env: HashMap<String, EnvValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ParamSpec {
    Bare(String), // param = "default value"
    Full {
        #[serde(default)]
        default: Option<String>,
        #[serde(default)]
        required: bool,
    },
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    /// "dir" (default) | "worktree". ("clone" is a later milestone.)
    #[serde(default)]
    pub strategy: Option<String>,
    /// For the "clone" strategy (later milestone); accepted, not yet used.
    #[allow(dead_code)]
    pub repo: Option<String>,
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TemplateEnvironment {
    /// Named environment spec to use.
    #[serde(rename = "use")]
    pub use_name: Option<String>,
    /// Inline override/shorthand.
    pub image: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TemplateHarness {
    #[serde(rename = "use")]
    pub use_name: Option<String>,
    pub cmd: Option<Vec<String>>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    #[serde(default)]
    pub run: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum EnvValue {
    Plain(String),
    Secret { secret: String },
}

pub fn user_config_dir() -> PathBuf {
    std::env::var("LANDLINE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
            PathBuf::from(home).join(".config/landline")
        })
}

/// Load `NAME.toml` of the given registry kind, project dir shadowing user dir.
fn load_registry_entry<T: serde::de::DeserializeOwned>(
    kind: &str,
    name: &str,
    project_dir: &Path,
) -> Result<T> {
    if name.contains('/') || name.contains("..") {
        bail!("invalid {kind} name: {name}");
    }
    let candidates = [
        project_dir
            .join(".landline")
            .join(kind)
            .join(format!("{name}.toml")),
        user_config_dir().join(kind).join(format!("{name}.toml")),
    ];
    for path in &candidates {
        if path.exists() {
            let raw = std::fs::read_to_string(path)
                .with_context(|| format!("read {}", path.display()))?;
            return toml::from_str(&raw).with_context(|| format!("parse {}", path.display()));
        }
    }
    bail!(
        "no {kind} named '{name}' (looked in .landline/{kind}/ and {}/{kind}/)",
        user_config_dir().display()
    )
}

pub fn load_environment(name: &str, project_dir: &Path) -> Result<EnvironmentSpec> {
    if name == "host" {
        return Ok(EnvironmentSpec::host());
    }
    load_registry_entry("environments", name, project_dir)
}

pub fn load_harness(name: &str, project_dir: &Path) -> Result<HarnessProfile> {
    load_registry_entry("harnesses", name, project_dir)
}

pub fn load_template(name: &str, project_dir: &Path) -> Result<Template> {
    load_registry_entry("templates", name, project_dir)
}

/// Resolve `{ secret = "name" }` env values from the user secret store.
/// Plain TOML at ~/.config/landline/secrets.toml; refuses group/world access.
pub fn load_secret(name: &str) -> Result<String> {
    let path = user_config_dir().join("secrets.toml");
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("no secret store at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path)?.permissions().mode();
        if mode & 0o077 != 0 {
            bail!("{} is readable by others; chmod 600 it", path.display());
        }
    }
    let table: HashMap<String, String> = toml::from_str(&raw)?;
    table
        .get(name)
        .cloned()
        .with_context(|| format!("no secret '{name}' in {}", path.display()))
}

/// `{{param}}` substitution. Unknown params are an error; no other syntax.
pub fn interpolate(input: &str, params: &HashMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            bail!("unclosed {{{{ in: {input}");
        };
        let key = after[..end].trim();
        let value = params
            .get(key)
            .with_context(|| format!("unknown param '{key}' in: {input}"))?;
        out.push_str(value);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Validate params against the template's declarations and fill defaults.
pub fn resolve_params(
    template: &Template,
    given: &HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    let mut params = HashMap::new();
    for (key, spec) in &template.params {
        match given.get(key) {
            Some(v) => {
                params.insert(key.clone(), v.clone());
            }
            None => match spec {
                ParamSpec::Bare(default) => {
                    params.insert(key.clone(), default.clone());
                }
                ParamSpec::Full {
                    default: Some(d), ..
                } => {
                    params.insert(key.clone(), d.clone());
                }
                ParamSpec::Full { required: true, .. } => {
                    bail!("missing required param '{key}'")
                }
                ParamSpec::Full { .. } => {}
            },
        }
    }
    for key in given.keys() {
        if !template.params.contains_key(key) {
            bail!("template does not declare param '{key}'");
        }
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolate_basics() {
        let params = HashMap::from([("a".to_string(), "X".to_string())]);
        assert_eq!(
            interpolate("pre {{a}} post", &params).unwrap(),
            "pre X post"
        );
        assert_eq!(interpolate("{{ a }}", &params).unwrap(), "X");
        assert!(interpolate("{{missing}}", &params).is_err());
        assert!(interpolate("{{unclosed", &params).is_err());
    }

    #[test]
    fn params_defaults_and_required() {
        let t: Template = toml::from_str(
            r#"
            [params]
            branch = { default = "main" }
            prompt = { required = true }
            plain = "simple"
            "#,
        )
        .unwrap();
        let err = resolve_params(&t, &HashMap::new()).unwrap_err();
        assert!(err.to_string().contains("prompt"));
        let given = HashMap::from([("prompt".to_string(), "go".to_string())]);
        let p = resolve_params(&t, &given).unwrap();
        assert_eq!(p["branch"], "main");
        assert_eq!(p["plain"], "simple");
        assert_eq!(p["prompt"], "go");
        let unknown = HashMap::from([
            ("prompt".to_string(), "go".to_string()),
            ("nope".to_string(), "x".to_string()),
        ]);
        assert!(resolve_params(&t, &unknown).is_err());
    }
}
