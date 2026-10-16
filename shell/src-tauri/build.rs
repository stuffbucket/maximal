fn main() {
    // SIDECAR_PORT reads this with option_env!; rebuild when it changes.
    println!("cargo:rerun-if-env-changed=MAXIMAL_DEV_PORT");
    tauri_build::build()
}
