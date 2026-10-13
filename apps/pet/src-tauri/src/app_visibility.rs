//! The display mode the user last chose from the tray: the pet character shown, or only the tray
//! icon. Saved as `pet-display.json` next to the pet position, so the next run starts the same
//! way. Hiding the pet is a display change only: the quick input, its draft and the memory server
//! keep running.
//!
//! The write lands in a temp file next to the target and is renamed into place, like the pet
//! position (`position.rs`), so a reader never sees a half-written file.

use serde_json::{json, Value};
use std::{
    fs,
    io::ErrorKind,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// The visibility requested by the host, available before any pet window is built. The native
/// window starts hidden while its page loads, so its visibility is not a valid startup answer.
pub struct PetVisibility(AtomicBool);

impl PetVisibility {
    pub fn new(mode: DisplayMode) -> Self {
        Self(AtomicBool::new(mode.pet_visible()))
    }

    pub fn is_visible(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn set_visible(&self, visible: bool) {
        self.0.store(visible, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayMode {
    /// The pet character is on screen (the first-run default).
    Pet,
    /// Only the tray icon shows that Bara is running.
    Tray,
}

impl DisplayMode {
    /// The name the screen and the saved file use.
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayMode::Pet => "pet",
            DisplayMode::Tray => "tray",
        }
    }

    pub fn pet_visible(self) -> bool {
        self == DisplayMode::Pet
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pet" => Some(DisplayMode::Pet),
            "tray" => Some(DisplayMode::Tray),
            _ => None,
        }
    }
}

/// What reading the saved mode found. No file yet (first run) is a normal empty state, distinct
/// from a file the host could not read or understand.
#[derive(Debug, PartialEq, Eq)]
pub enum ModeRead {
    NoFile,
    Invalid,
    Found(DisplayMode),
}

impl ModeRead {
    /// The mode to start in. Anything but a saved "tray" shows the pet, so a lost or broken file
    /// never leaves the user without a visible character to start from.
    pub fn start_mode(&self) -> DisplayMode {
        match self {
            ModeRead::Found(mode) => *mode,
            ModeRead::NoFile | ModeRead::Invalid => DisplayMode::Pet,
        }
    }
}

pub fn read_mode(path: &Path) -> ModeRead {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return ModeRead::NoFile,
        Err(_) => return ModeRead::Invalid,
    };
    let mode = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| DisplayMode::parse(value.get("mode")?.as_str()?));
    match mode {
        Some(mode) => ModeRead::Found(mode),
        None => ModeRead::Invalid,
    }
}

pub fn write_mode(path: &Path, mode: DisplayMode) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json!({"mode": mode.as_str()}).to_string())?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bara-pet-display-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn both_modes_round_trip_through_an_atomic_write() {
        let path = temp_dir("roundtrip").join("pet-display.json");
        for mode in [DisplayMode::Tray, DisplayMode::Pet] {
            write_mode(&path, mode).unwrap();
            assert!(!path.with_extension("json.tmp").exists());
            assert_eq!(read_mode(&path), ModeRead::Found(mode));
            assert_eq!(read_mode(&path).start_mode(), mode);
        }
    }

    #[test]
    fn a_first_run_shows_the_pet() {
        let path = temp_dir("missing").join("pet-display.json");
        assert_eq!(read_mode(&path), ModeRead::NoFile);
        assert_eq!(read_mode(&path).start_mode(), DisplayMode::Pet);
    }

    #[test]
    fn startup_visibility_is_available_before_any_window_or_event() {
        for saved in [
            ModeRead::NoFile,
            ModeRead::Invalid,
            ModeRead::Found(DisplayMode::Pet),
            ModeRead::Found(DisplayMode::Tray),
        ] {
            let state = PetVisibility::new(saved.start_mode());
            assert_eq!(
                state.is_visible(),
                saved != ModeRead::Found(DisplayMode::Tray)
            );
        }
    }

    #[test]
    fn visibility_queries_follow_hide_and_show_without_an_event_listener() {
        for mode in [DisplayMode::Pet, DisplayMode::Tray] {
            let state = PetVisibility::new(mode);
            for visible in [false, true, true, false] {
                state.set_visible(visible);
                assert_eq!(state.is_visible(), visible);
            }
        }
    }

    #[test]
    fn a_broken_file_is_reported_and_shows_the_pet() {
        let dir = temp_dir("corrupt");
        for (name, bytes) in [
            ("not-json.json", &b"not json"[..]),
            ("unknown-mode.json", br#"{"mode":"hidden"}"#),
            ("no-mode.json", br#"{"x":1}"#),
        ] {
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            assert_eq!(read_mode(&path), ModeRead::Invalid, "{name}");
            assert_eq!(read_mode(&path).start_mode(), DisplayMode::Pet, "{name}");
        }
    }
}
