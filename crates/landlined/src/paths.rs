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
