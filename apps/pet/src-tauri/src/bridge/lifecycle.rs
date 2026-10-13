//! Service process lifetime: starting a generation, retiring it when its output ends, and
//! stopping it.
//!
//! Every generation gets a new `epoch`, taken while `process` is locked. A reader thread only
//! ever retires its own generation, and it re-checks the epoch under that same lock, so a
//! reader whose process ended late can never tear down the generation `start()` put in its place.
//!
//! Lock order, everywhere: `process` -> `stdin` -> `pending`. `start()`, `retire()` and `stop()`
//! hold `process` for their whole change, and nothing that holds `stdin` or `pending` ever waits
//! for `process`, so the three cannot deadlock with each other or with `write()`.

use super::{check_service_files, lock_failed, protocol::read_line_bounded, Bridge, Input};
use crate::{
    backup_folder,
    host_error::{code, HostError},
    windows,
};
use std::{
    io::{BufReader, Read},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, Arc},
    thread,
};

pub(super) struct Process {
    pub(super) child: Child,
    job: windows::Job,
}

impl Process {
    fn end(self) {
        let Process { mut child, job } = self;
        // Closing the Job handle kills Bun and every installer/SSH descendant.
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Bridge {
    pub(super) fn start(self: &Arc<Self>) -> Result<(), HostError> {
        let start_failed = || HostError::new(code::HOST_SERVICE_START_FAILED);
        let mut process = self.process.lock().map_err(|_| lock_failed())?;
        if let Some(running) = process.as_mut() {
            if running
                .child
                .try_wait()
                .map_err(|e| HostError::io(code::HOST_SERVICE_START_FAILED, &e))?
                .is_none()
            {
                return Ok(());
            }
            // The process ended but its reader has not retired it yet. Once the epoch below
            // moves on, that reader's `retire` finds a newer generation and does nothing.
            self.clear_locked(&mut process, code::HOST_SERVICE_STOPPED);
        }
        let paths = &self.paths;
        check_service_files(&paths.script, &paths.bun)?;
        let mut command = Command::new(&paths.bun);
        command
            .arg(&paths.script)
            .current_dir(&paths.resource_dir)
            .env("BARA_PET_RESOURCES", &paths.resource_dir)
            .env("BARA_PET_DATA_DIR", &paths.data_dir)
            .env("BARA_PET_BUN", &paths.bun)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        backup_folder::set_env(&mut command, paths.backup_dir.as_deref());
        windows::hide_process(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| HostError::io(code::HOST_SERVICE_START_FAILED, &e))?;
        let job = match windows::attach_job(child.id()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let pipe = child.stdin.take().ok_or_else(start_failed)?;
        let output = child.stdout.take().ok_or_else(start_failed)?;
        // Every epoch change happens while `process` is locked, so reading the next value here
        // and storing it below cannot race another change. The stdin slot carries the epoch so a
        // frame meant for an older generation is never written to this one (`Bridge::write`).
        let epoch = self.epoch.load(Ordering::SeqCst) + 1;
        *self.stdin.lock().map_err(|_| lock_failed())? = Some(Input { epoch, pipe });
        *process = Some(Process { child, job });
        self.epoch.store(epoch, Ordering::SeqCst);
        let bridge = Arc::clone(self);
        thread::spawn(move || bridge.read_output(output, epoch));
        Ok(())
    }

    fn read_output(self: Arc<Self>, output: impl Read, epoch: u64) {
        let mut reader = BufReader::new(output);
        // The unlocked epoch check only stops routing early; `retire` decides under the lock.
        while let Ok(Some(line)) = read_line_bounded(&mut reader) {
            if self.epoch.load(Ordering::SeqCst) != epoch {
                break;
            }
            // Every line of the running generation, whatever it carries, shows that the service
            // is alive; `Bridge::await_reply` measures silence from here.
            self.last_frame.store(self.clock_ms(), Ordering::SeqCst);
            if !self.route_line(&line, epoch) {
                break;
            }
        }
        self.retire(epoch, code::HOST_SERVICE_DISCONNECTED);
    }

    /// Ends generation `epoch` after its output closed, or after a waiting request found it silent
    /// past the limit (`Bridge::await_reply`): ends its process tree, drops its stdin
    /// and fails every waiting request with `failure`. Returns false, changing nothing, when a
    /// newer generation has already replaced it.
    pub(super) fn retire(&self, epoch: u64, failure: &'static str) -> bool {
        // `process` first, then the epoch check, then stdin and pending (see the module note).
        let Ok(mut process) = self.process.lock() else {
            return false;
        };
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return false;
        }
        self.clear_locked(&mut process, failure);
        true
    }

    pub fn is_running(&self) -> bool {
        self.process
            .lock()
            .map(|process| process.is_some())
            .unwrap_or(false)
    }

    pub fn stop(&self) {
        if let Ok(mut process) = self.process.lock() {
            self.clear_locked(&mut process, code::HOST_SERVICE_STOPPED);
        }
    }

    /// The caller holds the `process` lock for the whole clean-up, so `start()` cannot put a
    /// new process, stdin or request in place halfway through it.
    fn clear_locked(&self, process: &mut Option<Process>, failure: &'static str) {
        if let Some(running) = process.take() {
            running.end();
        }
        if let Ok(mut input) = self.stdin.lock() {
            *input = None;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(HostError::new(failure)));
            }
        }
    }
}
