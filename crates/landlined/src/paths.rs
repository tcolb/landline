use std::path::PathBuf;

pub fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("landline.sock");
    }
    // SAFETY-free fallback; unix-only daemon.
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/landline-{uid}.sock"))
}

pub fn log_path() -> PathBuf {
    socket_path().with_extension("log")
}

pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    PathBuf::from(home).join(".local/share/landline")
}

pub fn ws_token_path() -> PathBuf {
    data_dir().join("ws-token")
}
