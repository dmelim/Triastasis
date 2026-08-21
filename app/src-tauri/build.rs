fn main() {
    // In `tauri dev --no-dev-server`, frontend assets are embedded by this
    // build script. Make a reload-triggered `cargo run` rebuild that bundle
    // whenever Vite has produced new output.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build();
}
