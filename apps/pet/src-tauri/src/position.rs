//! Saves the pet window's position to disk without blocking the UI thread.
//!
//! Every window-move event only sends the latest coordinates down a channel; a single saver
//! thread coalesces them with [`POSITION_SAVE_QUIET`] of silence and writes the last one it saw.
//! The write itself lands in a temp file next to the target and is renamed into place, so a
//! reader never observes a half-written file.

use serde_json::{json, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

/// How long the saver waits for movement to stop before writing the last coordinate it saw.
pub const POSITION_SAVE_QUIET: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

enum Message {
    Moved(Point),
    Stop,
}

/// Runs the saver thread and exposes a cheap, non-blocking way to report new coordinates.
pub struct PositionStore {
    sender: Sender<Message>,
    handle: Option<thread::JoinHandle<()>>,
}

/// What the saver thread does after each quiet period: used by callers that want to react to a
/// failure (a bubble) or a recovery (clearing that bubble), and by tests that count writes.
#[derive(Debug, PartialEq, Eq)]
pub enum SaveOutcome {
    Written,
    Failed,
}

impl PositionStore {
    /// Starts the saver thread. `path` is the JSON file to keep updated; `on_outcome` runs on
    /// the saver thread after every write attempt (never called for a move that starts a fresh
    /// quiet period without a write yet, i.e. it fires once per actual write, not once per move).
    /// Stopping the store writes a position still waiting for its quiet period before the thread
    /// ends, so a move made just before the app quits is not lost.
    pub fn spawn(path: PathBuf, on_outcome: impl Fn(SaveOutcome) + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::channel::<Message>();
        let handle = thread::spawn(move || {
            let mut pending: Option<Point> = None;
            let save = |point: Point| {
                on_outcome(if write_position(&path, point).is_ok() {
                    SaveOutcome::Written
                } else {
                    SaveOutcome::Failed
                });
            };
            loop {
                let timeout = if pending.is_some() {
                    POSITION_SAVE_QUIET
                } else {
                    Duration::from_secs(3600)
                };
                match receiver.recv_timeout(timeout) {
                    Ok(Message::Moved(point)) => pending = Some(point),
                    Err(RecvTimeoutError::Timeout) => {
                        if let Some(point) = pending.take() {
                            save(point);
                        }
                    }
                    Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => {
                        if let Some(point) = pending.take() {
                            save(point);
                        }
                        break;
                    }
                }
            }
        });
        Self {
            sender,
            handle: Some(handle),
        }
    }

    /// Reports a new position; never blocks and never touches the filesystem itself.
    pub fn moved(&self, point: Point) {
        let _ = self.sender.send(Message::Moved(point));
    }
}

impl Drop for PositionStore {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Stop);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Writes `point` to `path` atomically: a temp file in the same folder, then a rename over the
/// target. The rename is atomic on the same volume, so a reader never sees a partial file.
fn write_position(path: &Path, point: Point) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    let bytes = json!({"x": point.x, "y": point.y}).to_string();
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

/// What restoring a saved position found: a real empty state (no file yet, e.g. first run) is
/// distinct from a read or parse failure (an existing file the host could not make sense of).
pub enum RestoreResult {
    NoFile,
    Invalid,
    Found(Point),
}

pub fn read_position(path: &Path) -> RestoreResult {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return RestoreResult::NoFile,
        Err(_) => return RestoreResult::Invalid,
    };
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            Some(Point {
                x: i32::try_from(value.get("x")?.as_i64()?).ok()?,
                y: i32::try_from(value.get("y")?.as_i64()?).ok()?,
            })
        });
    match parsed {
        Some(point) => RestoreResult::Found(point),
        None => RestoreResult::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bara-pet-position-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_through_an_atomic_write() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("pet-position.json");
        write_position(&path, Point { x: 12, y: -34 }).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        match read_position(&path) {
            RestoreResult::Found(point) => assert_eq!(point, Point { x: 12, y: -34 }),
            _ => panic!("expected a found position"),
        }
    }

    #[test]
    fn missing_file_is_a_normal_empty_state() {
        let dir = temp_dir("missing");
        let path = dir.join("pet-position.json");
        assert!(matches!(read_position(&path), RestoreResult::NoFile));
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_state() {
        let dir = temp_dir("corrupt");
        let path = dir.join("pet-position.json");
        fs::write(&path, b"not json").unwrap();
        assert!(matches!(read_position(&path), RestoreResult::Invalid));

        let path2 = dir.join("pet-position-2.json");
        fs::write(&path2, b"{\"x\":1}").unwrap();
        assert!(matches!(read_position(&path2), RestoreResult::Invalid));
    }

    /// PFIX-3: a move still inside its quiet period when the store stops is written, not dropped.
    #[test]
    fn stopping_writes_the_last_unsaved_position() {
        let dir = temp_dir("stop");
        let path = dir.join("pet-position.json");
        let writes = Arc::new(Mutex::new(Vec::new()));
        let writes_clone = Arc::clone(&writes);
        let store = PositionStore::spawn(path.clone(), move |outcome| {
            writes_clone.lock().unwrap().push(outcome);
        });
        store.moved(Point { x: 7, y: 8 });
        store.moved(Point { x: 70, y: 80 });
        drop(store);
        assert_eq!(*writes.lock().unwrap(), vec![SaveOutcome::Written]);
        match read_position(&path) {
            RestoreResult::Found(point) => assert_eq!(point, Point { x: 70, y: 80 }),
            _ => panic!("expected the last move to be saved on stop"),
        }
    }

    #[test]
    fn rapid_moves_coalesce_into_one_write_of_the_last_point() {
        let dir = temp_dir("coalesce");
        let path = dir.join("pet-position.json");
        let writes = Arc::new(Mutex::new(Vec::new()));
        let writes_clone = Arc::clone(&writes);
        let store = PositionStore::spawn(path.clone(), move |outcome| {
            writes_clone.lock().unwrap().push(outcome);
        });
        for i in 0..100 {
            store.moved(Point { x: i, y: i * 2 });
            thread::sleep(Duration::from_millis(1));
        }
        thread::sleep(POSITION_SAVE_QUIET + Duration::from_millis(300));
        drop(store);
        let outcomes = writes.lock().unwrap();
        assert_eq!(
            outcomes.len(),
            1,
            "expected exactly one write, got {outcomes:?}"
        );
        assert_eq!(outcomes[0], SaveOutcome::Written);
        match read_position(&path) {
            RestoreResult::Found(point) => assert_eq!(point, Point { x: 99, y: 198 }),
            _ => panic!("expected the last point to be saved"),
        }
    }
}
