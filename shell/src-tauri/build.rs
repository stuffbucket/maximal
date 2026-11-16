use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

fn target_profile_directory(out_dir: &Path) -> Result<PathBuf, String> {
    let build_directory = out_dir
        .ancestors()
        .find(|ancestor| ancestor.file_name() == Some(OsStr::new("build")))
        .ok_or_else(|| {
            format!(
                "OUT_DIR does not contain Cargo's build directory: {}",
                out_dir.display()
            )
        })?;
    build_directory
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            format!(
                "Cargo build directory has no target profile parent: {}",
                build_directory.display()
            )
        })
}

fn remove_staged_plugin_builtins() -> Result<(), String> {
    let out_dir = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "Cargo did not provide OUT_DIR to the Tauri build script.".to_owned())?;
    let staged = target_profile_directory(&out_dir)?.join("plugin-builtins");
    match std::fs::remove_dir_all(&staged) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove staged sealed plugin generation at {}: {error}",
            staged.display()
        )),
    }
}

fn main() {
    // tauri-build preserves the source modes when it copies resources. Sealed
    // generation files are intentionally read-only, so a later copy cannot
    // truncate the previous target-stage files. Remove only that disposable
    // stage before Tauri recopies the authoritative sealed generation.
    remove_staged_plugin_builtins().unwrap_or_else(|message| panic!("{message}"));
    tauri_build::build()
}
