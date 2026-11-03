// Compile and exercise the exact clone-owned Job Object implementation as part
// of the shell's existing Windows test build. The module's test only launches a
// synthetic cmd.exe child; it never discovers or signals installed Maximal.
#![cfg(target_os = "windows")]

#[path = "../patches/tauri-plugin-shell-2.6.0/src/process/job_object.rs"]
mod job_object;
