mod lifecycle;
mod protocol;
#[cfg(test)]
mod tests;

use crate::{
    backup_folder,
    host_error::{code, HostError},
    native_host, policy,
    vault::Vault,
};

/// Prefix for request ids the host itself generates (`request()`'s auto-assigned id).
/// `policy::validate_request` rejects any webview-supplied `id` or `operation.cancel`
/// `params.requestId` that starts with this prefix, so a webview can never collide with, or
/// target for cancellation, a request the host itself tracks in `pending`.
pub(crate) const NATIVE_REQUEST_PREFIX: &str = "native_";
use lifecycle::Process;
use protocol::{dispatch_response, Pending};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    process::ChildStdin,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

/// How long one frame write to the service's stdin may take before the pipe counts as stalled.
const SERVICE_WRITE_LIMIT: Duration = Duration::from_secs(5);

/// Where the service process and its files are. `Bridge::new` fills these from the installed
/// layout; the bridge tests point them at the repository's own scripts and a scratch folder.
pub struct ServicePaths {
    pub data_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub bun: PathBuf,
    pub script: PathBuf,
    /// Where backups go (`backup_folder::root`); `None` when the host could not tell.
    pub backup_dir: Option<PathBuf>,
}

/// The host's waiting limits for one service generation. A request has no length limit of its
/// own: the service owns every per-operation limit (`src/service/operation-limits.ts`) and, while
/// it has work in progress, sends `{"event":"alive"}` every `contract.serviceHeartbeatMs`.
pub struct Timing {
    /// Longest a waiting request may go without any line at all from the service.
    pub silence_limit: Duration,
    pub write_limit: Duration,
}

impl Timing {
    fn product() -> Self {
        Self {
            silence_limit: native_host::service_silence_limit(),
            write_limit: SERVICE_WRITE_LIMIT,
        }
    }
}

/// Receives each `pet-progress` payload the host forwards to the screen.
pub type ProgressSink = Box<dyn Fn(Value) + Send + Sync>;
type ReplySender = mpsc::Sender<Result<Value, HostError>>;
type ReplyReceiver = mpsc::Receiver<Result<Value, HostError>>;

/// The running generation's stdin, tagged with that generation's epoch. A frame is written only
/// to the generation it belongs to: a request registered in generation N, or a vault reply to a
/// host frame N sent, must never reach N+1, which would run it while N's caller was already told
/// it failed.
struct Input {
    epoch: u64,
    pipe: ChildStdin,
}

/// Points inside [`Bridge::request`] where a test can act, to force a race that real timing
/// almost never shows: a new generation starting between registering a request and writing it,
/// or right after its write failed. Compiled only into tests; product builds have no hook.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestStep {
    Registered,
    WriteFailed,
}
#[cfg(test)]
type StepHook = Box<dyn Fn(&Arc<Bridge>, &str, RequestStep) + Send + Sync>;

pub struct Bridge {
    paths: ServicePaths,
    timing: Timing,
    progress: ProgressSink,
    vault: Vault,
    process: Mutex<Option<Process>>,
    stdin: Mutex<Option<Input>>,
    pending: Pending,
    next_id: AtomicU64,
    epoch: AtomicU64,
    /// Origin of the millisecond counts below.
    clock: Instant,
    /// When the running generation last wrote a line, in `clock` milliseconds. Its reader thread
    /// stores it for every line; waiting requests only read it.
    last_frame: AtomicU64,
    #[cfg(test)]
    step_hook: Mutex<Option<StepHook>>,
}

#[derive(Default)]
pub struct BridgeState {
    inner: Mutex<Option<Arc<Bridge>>>,
}

impl BridgeState {
    pub fn get(&self, app: &AppHandle) -> Result<Arc<Bridge>, HostError> {
        let mut inner = self.inner.lock().map_err(|_| lock_failed())?;
        if let Some(bridge) = inner.as_ref() {
            return Ok(Arc::clone(bridge));
        }
        let bridge = Bridge::new(app)?;
        *inner = Some(Arc::clone(&bridge));
        Ok(bridge)
    }

    pub fn stop(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(bridge) = inner.as_ref() {
                bridge.stop();
            }
        }
    }

    /// The bridge only when its service process is running, so a quit never starts a service just
    /// to stop it again.
    pub fn running(&self) -> Option<Arc<Bridge>> {
        let inner = self.inner.lock().ok()?;
        inner
            .as_ref()
            .filter(|bridge| bridge.is_running())
            .map(Arc::clone)
    }
}

fn lock_failed() -> HostError {
    HostError::new(code::HOST_STATE_LOCK_FAILED)
}

pub fn default_data_dir() -> Result<PathBuf, HostError> {
    if let Some(path) = std::env::var_os("BARA_PET_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    let local =
        std::env::var_os("LOCALAPPDATA").ok_or(HostError::new(code::HOST_DATA_DIR_FAILED))?;
    Ok(PathBuf::from(local).join("Bara/Pet"))
}

fn prepare_data_dir(path: &Path) -> Result<(), HostError> {
    std::fs::create_dir_all(path).map_err(|e| HostError::io(code::HOST_DATA_DIR_FAILED, &e))
}

/// Confirms the service script and the Bun runtime exist. The error names which one is
/// missing by code only; the paths stay on this side of the IPC boundary.
fn check_service_files(script: &Path, bun: &Path) -> Result<(), HostError> {
    if !script.is_file() {
        return Err(HostError::new(code::HOST_SERVICE_MISSING));
    }
    if !bun.is_file() {
        return Err(HostError::new(code::HOST_RUNTIME_MISSING));
    }
    Ok(())
}

fn resource_dir(app: &AppHandle) -> Result<PathBuf, HostError> {
    if let Some(path) = std::env::var_os("BARA_PET_RESOURCES") {
        return Ok(PathBuf::from(path));
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|_| HostError::new(code::HOST_RESOURCE_DIR_FAILED))?
        .join("resources");
    if bundled.join("service/main.js").exists() {
        return Ok(bundled);
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources");
        return Ok(dev);
    }
    Ok(bundled)
}

impl Bridge {
    pub fn data_dir(&self) -> &PathBuf {
        &self.paths.data_dir
    }

    pub fn backup_dir(&self) -> Option<&PathBuf> {
        self.paths.backup_dir.as_ref()
    }

    pub fn new(app: &AppHandle) -> Result<Arc<Self>, HostError> {
        let data_dir = default_data_dir()?;
        prepare_data_dir(&data_dir)?;
        let resource_dir = resource_dir(app)?;
        let bun = std::env::var_os("BARA_PET_BUN")
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_dir.join("runtime/bun.exe"));
        let script = resource_dir.join("service/main.js");
        let backup_dir = backup_folder::root(
            std::env::var_os(backup_folder::BACKUP_DIR_ENV),
            app.path().document_dir().ok(),
        );
        let app = app.clone();
        Ok(Self::with_parts(
            ServicePaths {
                data_dir,
                resource_dir,
                bun,
                script,
                backup_dir,
            },
            Timing::product(),
            Box::new(move |payload| {
                let _ = app.emit("pet-progress", payload);
            }),
        ))
    }

    pub fn with_parts(paths: ServicePaths, timing: Timing, progress: ProgressSink) -> Arc<Self> {
        Arc::new(Self {
            vault: Vault::new(paths.data_dir.join("vault.json")),
            paths,
            timing,
            progress,
            process: Mutex::new(None),
            stdin: Mutex::new(None),
            pending: Pending::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            epoch: AtomicU64::new(0),
            clock: Instant::now(),
            last_frame: AtomicU64::new(0),
            #[cfg(test)]
            step_hook: Mutex::new(None),
        })
    }

    fn clock_ms(&self) -> u64 {
        // Saturates only after about 584 million years of uptime.
        u64::try_from(self.clock.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub fn request(
        self: &Arc<Self>,
        id: Option<String>,
        method: &str,
        params: Value,
    ) -> Result<Value, HostError> {
        // Quitting may race the service's exit after the tray obtained this bridge. A drain
        // must only use an existing generation; register/write already fail if it has ended.
        // Ordinary requests keep their existing restart behavior.
        if method != "service.drain" {
            self.start()?;
        }
        let id = id.unwrap_or_else(|| {
            format!(
                "{NATIVE_REQUEST_PREFIX}{}",
                self.next_id.fetch_add(1, Ordering::Relaxed)
            )
        });
        let (tx, rx) = mpsc::channel();
        let epoch = self.register(&id, tx)?;
        #[cfg(test)]
        self.reached(&id, RequestStep::Registered);
        let frame = json!({"id":id,"method":method,"params":params});
        if let Err(error) = self.write_bounded(frame, epoch) {
            #[cfg(test)]
            self.reached(&id, RequestStep::WriteFailed);
            // Only generation `epoch` is ended, and only while it is still the running one: a
            // newer generation may have replaced it by now, and that one is healthy. Either way
            // this request leaves `pending`: `retire` drains it here, or the clear that ended
            // `epoch` already drained it (that clear is the only way `epoch` stops being current).
            self.retire(epoch, code::HOST_SERVICE_STOPPED);
            return Err(error);
        }
        self.await_reply(&id, &rx, epoch)
    }

    #[cfg(test)]
    fn reached(self: &Arc<Self>, id: &str, step: RequestStep) {
        if let Some(hook) = self.step_hook.lock().unwrap().as_ref() {
            hook(self, id, step);
        }
    }

    /// Adds `id` to `pending` while `process` is locked and returns the epoch of the generation
    /// running at that moment. The request then belongs to that generation: whoever clears it
    /// later (lock order `process` -> `pending`) fails this request too.
    fn register(&self, id: &str, reply: ReplySender) -> Result<u64, HostError> {
        let process = self.process.lock().map_err(|_| lock_failed())?;
        if process.is_none() {
            return Err(HostError::new(code::HOST_SERVICE_STOPPED));
        }
        let mut pending = self.pending.lock().map_err(|_| lock_failed())?;
        if pending.contains_key(id) {
            return Err(HostError::new(code::HOST_DUPLICATE_REQUEST));
        }
        pending.insert(id.to_owned(), reply);
        Ok(self.epoch.load(Ordering::SeqCst))
    }

    /// Waits for the reply to request `id`, sent to generation `epoch`, for as long as the
    /// service keeps talking: any line (a reply, progress, a host frame or a heartbeat) counts.
    /// Once the service has been silent for `timing.silence_limit` since the later of the request
    /// and its last line, the generation is retired through the locked path (its Job ends the
    /// whole process tree) and every request waiting on it fails with `HOST_SERVICE_UNRESPONSIVE`.
    fn await_reply(&self, id: &str, reply: &ReplyReceiver, epoch: u64) -> Result<Value, HostError> {
        let sent = self.clock_ms();
        loop {
            let heard = self.last_frame.load(Ordering::SeqCst).max(sent);
            let silent = Duration::from_millis(self.clock_ms().saturating_sub(heard));
            let remaining = self.timing.silence_limit.saturating_sub(silent);
            if remaining.is_zero() {
                return self.fail_unresponsive(id, reply, epoch);
            }
            match reply.recv_timeout(remaining) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HostError::new(code::HOST_SERVICE_STOPPED))
                }
            }
        }
    }

    fn fail_unresponsive(
        &self,
        id: &str,
        reply: &ReplyReceiver,
        epoch: u64,
    ) -> Result<Value, HostError> {
        self.retire(epoch, code::HOST_SERVICE_UNRESPONSIVE);
        // `retire` has just sent this request its failure, or its reply arrived first, or the
        // generation had already been cleared, which also sent the failure before the epoch
        // moved on. The outcome is therefore in the channel already, unless the `process` lock
        // was poisoned and nothing could be cleared.
        reply.try_recv().unwrap_or_else(|_| {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(id);
            }
            Err(HostError::new(code::HOST_SERVICE_UNRESPONSIVE))
        })
    }

    /// Writes `frame` to generation `epoch`'s stdin. When another generation's stdin is in the
    /// slot, `epoch` has already ended (and failed everything registered in it), so the frame is
    /// written nowhere and the caller gets `HOST_SERVICE_STOPPED`.
    fn write(&self, frame: &Value, epoch: u64) -> Result<(), HostError> {
        let write_failed = |e: std::io::Error| HostError::io(code::HOST_SERVICE_WRITE_FAILED, &e);
        let mut lock = self.stdin.lock().map_err(|_| lock_failed())?;
        let input = lock
            .as_mut()
            .ok_or(HostError::new(code::HOST_SERVICE_NOT_CONNECTED))?;
        if input.epoch != epoch {
            return Err(HostError::new(code::HOST_SERVICE_STOPPED));
        }
        let pipe = &mut input.pipe;
        serde_json::to_writer(&mut *pipe, frame).map_err(|e| write_failed(e.into()))?;
        pipe.write_all(b"\n").map_err(write_failed)?;
        pipe.flush().map_err(write_failed)
    }

    fn write_bounded(self: &Arc<Self>, frame: Value, epoch: u64) -> Result<(), HostError> {
        let bridge = Arc::clone(self);
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(bridge.write(&frame, epoch));
        });
        rx.recv_timeout(self.timing.write_limit)
            .map_err(|_| HostError::new(code::HOST_SERVICE_PIPE_STALLED))?
    }

    /// Routes one line of generation `epoch`'s output.
    fn route_line(&self, line: &[u8], epoch: u64) -> bool {
        let Ok(frame) = serde_json::from_slice::<Value>(line) else {
            return false;
        };
        if let Some(host) = frame.get("host") {
            self.handle_host(host, epoch);
            return true;
        }
        let event = frame.get("event").and_then(Value::as_str);
        if event == Some("alive") {
            // The service's heartbeat. Reading the line already refreshed `last_frame`.
            return true;
        }
        if event == Some("progress") {
            let request_id = frame.get("requestId").and_then(Value::as_str).unwrap_or("");
            let stage = frame.get("stage").and_then(Value::as_str).unwrap_or("");
            let active = self
                .pending
                .lock()
                .map(|pending| pending.contains_key(request_id))
                .unwrap_or(false);
            if active && request_id.len() <= 80 {
                // Only a stage this host's contract has named is forwarded; the child never
                // supplies its own text (it may contain a URL or credential), and a stage
                // outside `contract.progressStages` is dropped rather than shown.
                // A `detail` the host cannot vouch for is left off; the stage still goes through.
                if let Some(safe_stage) = policy::progress_stage(stage) {
                    let mut payload = json!({"requestId":request_id,"stage":safe_stage});
                    if let Some(detail) = frame.get("detail").and_then(policy::progress_detail) {
                        payload["detail"] = detail;
                    }
                    (self.progress)(payload);
                }
            }
            return true;
        }
        dispatch_response(&self.pending, &frame)
    }

    /// Answers a host frame from generation `epoch`; the reply goes back to that generation only.
    fn handle_host(&self, host: &Value, epoch: u64) {
        let Some(id) = host.get("id").and_then(Value::as_str) else {
            return;
        };
        if id.len() > 64 {
            return;
        }
        let method = host.get("method").and_then(Value::as_str).unwrap_or("");
        let params = host.get("params").cloned().unwrap_or(Value::Null);
        let key = params.get("key").and_then(Value::as_str).unwrap_or("");
        // The vault's own error text stays here; the service only learns that the vault failed.
        let result = match method {
            "vault.get" => self.vault.get(key).ok().map(|v| json!(v)),
            "vault.set" => params
                .get("value")
                .and_then(Value::as_str)
                .and_then(|value| self.vault.set(key, value).ok())
                .map(|_| Value::Null),
            "vault.delete" => self.vault.delete(key).ok().map(|_| Value::Null),
            _ => None,
        };
        let reply = match result {
            Some(value) => json!({"hostReply":{"id":id,"result":value}}),
            None => {
                json!({"hostReply":{"id":id,"error":{"code":"VAULT_ERROR","message":"Private storage failed"}}})
            }
        };
        let _ = self.write(&reply, epoch);
    }
}
