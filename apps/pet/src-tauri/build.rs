fn main() {
    // UI builds regenerate this file; refresh both the PE resource and Tauri's default icon.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build();
}
