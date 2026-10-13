use super::*;
use serde_json::json;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "bara-pet-bridge-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn path_bearing_failures_send_only_code_and_status() {
    let root = scratch("paths");
    let blocker = root.join("not-a-folder");
    std::fs::write(&blocker, b"file").unwrap();
    let error = prepare_data_dir(&blocker.join("Bara/Pet")).unwrap_err();
    let value = serde_json::to_value(&error).unwrap();
    let fields: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(fields, ["code", "status"]);
    assert_eq!(value["code"], json!(code::HOST_DATA_DIR_FAILED));
    assert!(value["status"].is_i64());
    let text = value.to_string();
    assert!(!text.contains("not-a-folder") && !text.contains("bara-pet-bridge"));

    let script = root.join("service/main.js");
    let bun = root.join("runtime/bun.exe");
    assert_eq!(
        serde_json::to_value(check_service_files(&script, &bun).unwrap_err()).unwrap(),
        json!({"code":"HOST_SERVICE_MISSING"})
    );
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, b"").unwrap();
    assert_eq!(
        serde_json::to_value(check_service_files(&script, &bun).unwrap_err()).unwrap(),
        json!({"code":"HOST_RUNTIME_MISSING"})
    );
    std::fs::create_dir_all(bun.parent().unwrap()).unwrap();
    std::fs::write(&bun, b"").unwrap();
    assert!(check_service_files(&script, &bun).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn progress_reaches_the_screen_with_a_detail_only_when_the_host_can_vouch_for_it() {
    let root = scratch("progress");
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let bridge = Bridge::with_parts(
        ServicePaths {
            data_dir: root.clone(),
            resource_dir: root.clone(),
            bun: root.join("bun"),
            script: root.join("main.js"),
            backup_dir: None,
        },
        Timing {
            silence_limit: Duration::from_secs(30),
            write_limit: SERVICE_WRITE_LIMIT,
        },
        Box::new(move |payload| sink.lock().unwrap().push(payload)),
    );
    let (reply, _replies) = mpsc::channel();
    bridge
        .pending
        .lock()
        .unwrap()
        .insert("install-1".to_owned(), reply);
    let detail = json!({"part": 2, "parts": 5, "loaded": 312_000_000u64, "total": 570_000_000u64});
    let frame = |stage: &str, detail: Option<Value>| {
        let mut frame = json!({"event": "progress", "requestId": "install-1", "stage": stage});
        if let Some(detail) = detail {
            frame["detail"] = detail;
        }
        frame.to_string()
    };
    for line in [
        frame("models", None),
        frame("models", Some(detail.clone())),
        frame(
            "models",
            Some(json!({"part": 2, "parts": 5, "loaded": 1, "total": 1, "url": "https://x"})),
        ),
        frame(
            "models",
            Some(json!({"part": 2, "parts": 11, "loaded": 1, "total": 1})),
        ),
        frame("models", Some(json!("2/5"))),
        frame("secret=/path/token", Some(detail.clone())),
        json!({"event": "progress", "requestId": "other", "stage": "models", "detail": detail})
            .to_string(),
    ] {
        assert!(bridge.route_line(line.as_bytes(), 0), "{line}");
    }
    let plain = json!({"requestId": "install-1", "stage": "models"});
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            plain.clone(),
            json!({"requestId": "install-1", "stage": "models", "detail": detail}),
            plain.clone(),
            plain.clone(),
            plain,
        ]
    );
    std::fs::remove_dir_all(root).unwrap();
}

/// These tests start real Bun processes: the repository's own service (`src/service/main.ts`)
/// and the test-only line peer (`tests/fixtures/native-line-peer.ts`). Bun 1.3.6 must be on
/// PATH; without it they fail with that cause instead of being skipped.
#[cfg(windows)]
mod processes {
    use super::*;
    use crate::windows::wait_process_exit;
    use std::{
        process::{Command, Stdio},
        sync::OnceLock,
        time::Instant,
    };

    /// Long enough that no quiet wait in these tests ever reaches it; a test that hangs fails here.
    const LONG_SILENCE_LIMIT: Duration = Duration::from_secs(30);
    /// The silence limit of the heartbeat tests, short so that they finish quickly.
    const SHORT_SILENCE_LIMIT: Duration = Duration::from_millis(1_500);
    /// The peer's heartbeat interval in those tests: several beats fit in one limit, as
    /// `native-host.json` requires of the product values.
    const SHORT_HEARTBEAT: Duration = Duration::from_millis(250);
    /// How far past the silence limit an unresponsive service may take to be detected and stopped.
    const SILENCE_DETECTION_SLACK: Duration = Duration::from_secs(3);
    /// How long a test waits for a background request to register in `pending`.
    const PENDING_WAIT: Duration = Duration::from_secs(10);
    const PENDING_POLL: Duration = Duration::from_millis(10);
    /// How long an ended service or its grandchild may take to be gone (the plan allows 5 s).
    const PROCESS_EXIT_LIMIT: Duration = Duration::from_secs(5);

    fn repository() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent folder")
            .to_path_buf()
    }

    /// The real `bun.exe`. `Command` only finds `.exe` files on PATH, while a Bun installed
    /// through npm is on PATH only as a `bun.cmd` shim, so Bun is asked for its own path
    /// through `cmd.exe`, which resolves either form.
    fn bun() -> PathBuf {
        static BUN: OnceLock<PathBuf> = OnceLock::new();
        BUN.get_or_init(|| {
            let output = Command::new("cmd.exe")
                .args(["/d", "/c", "bun", "--print", "process.execPath"])
                .stdin(Stdio::null())
                .output()
                .unwrap_or_else(|error| panic!("cmd.exe could not run to look for Bun: {error}"));
            assert!(
                output.status.success(),
                "Bun 1.3.6 must be on PATH for the bridge tests; `bun --print process.execPath` failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            let path = PathBuf::from(
                String::from_utf8(output.stdout)
                    .expect("Bun printed a non-UTF-8 path")
                    .trim(),
            );
            assert!(path.is_file(), "Bun reported a missing executable: {}", path.display());
            path
        })
        .clone()
    }

    fn bridge_for(script: PathBuf, root: &Path) -> Arc<Bridge> {
        bridge_with(script, root, LONG_SILENCE_LIMIT)
    }

    fn bridge_with(script: PathBuf, root: &Path, silence_limit: Duration) -> Arc<Bridge> {
        let data_dir = root.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        Bridge::with_parts(
            ServicePaths {
                data_dir,
                resource_dir: root.to_path_buf(),
                bun: bun(),
                script,
                backup_dir: None,
            },
            Timing {
                silence_limit,
                write_limit: SERVICE_WRITE_LIMIT,
            },
            Box::new(|_| {}),
        )
    }

    fn peer(root: &Path) -> Arc<Bridge> {
        bridge_for(
            repository().join("tests/fixtures/native-line-peer.ts"),
            root,
        )
    }

    fn quiet_peer(root: &Path) -> Arc<Bridge> {
        bridge_with(
            repository().join("tests/fixtures/native-line-peer.ts"),
            root,
            SHORT_SILENCE_LIMIT,
        )
    }

    fn millis(duration: Duration) -> u64 {
        u64::try_from(duration.as_millis()).expect("test durations fit in u64 milliseconds")
    }

    fn pid_of(reply: &Value) -> u32 {
        reply["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .unwrap_or_else(|| panic!("reply has no process id: {reply}"))
    }

    /// Sends `method` on a background thread under a fixed id and returns once the host has
    /// registered it as waiting.
    fn send_in_background(
        bridge: &Arc<Bridge>,
        id: &str,
        method: &'static str,
    ) -> thread::JoinHandle<Result<Value, HostError>> {
        let sender = Arc::clone(bridge);
        let owned = id.to_owned();
        let handle = thread::spawn(move || sender.request(Some(owned), method, json!({})));
        let deadline = Instant::now() + PENDING_WAIT;
        while !bridge.pending.lock().unwrap().contains_key(id) {
            assert!(
                Instant::now() < deadline,
                "request {id} never became pending"
            );
            thread::sleep(PENDING_POLL);
        }
        handle
    }

    fn assert_code(result: Result<Value, HostError>, expected: &str) {
        assert_eq!(result.unwrap_err().code_str(), expected);
    }

    #[test]
    fn real_service_answers_settings_through_the_dpapi_vault() {
        let root = scratch("service");
        let bridge = bridge_for(repository().join("src/service/main.ts"), &root);

        // A new data folder: the service asks the host for each of its four secrets through
        // host frames, finds none, and reports the initial settings.
        let settings = bridge
            .request(None, "settings.get", json!({}))
            .expect("settings.get from the real service");
        assert_eq!(settings["version"], json!(1));
        assert_eq!(settings["connection"]["mode"], json!("local"));
        assert_eq!(settings["autoStart"], json!(false));
        for flag in ["hasToken", "hasOwnerToken", "hasAiKey"] {
            assert_eq!(settings[flag], json!(false), "{flag}");
        }

        // An AI key encrypted by the real DPAPI vault and bound to the current AI settings, in
        // the service's own format (`config.ts` `aiAudience` / `encodeBoundSecret`): the service
        // reports it only if the host decrypted it and sent it back over the pipe.
        let ai_audience = format!(
            r#"{{"provider":{},"origin":{}}}"#,
            settings["ai"]["provider"], settings["ai"]["baseUrl"]
        );
        let secret = "bridge-test-ai-key";
        bridge
            .vault
            .set(
                "ai.apiKey",
                &json!({"version":1,"audience":ai_audience,"secret":secret}).to_string(),
            )
            .expect("DPAPI vault write");
        let stored = std::fs::read_to_string(root.join("data/vault.json")).unwrap();
        assert!(!stored.contains(secret), "the vault file holds plain text");
        let settings = bridge
            .request(None, "settings.get", json!({}))
            .expect("settings.get after storing a key");
        assert_eq!(settings["hasAiKey"], json!(true));
        assert!(!settings.to_string().contains(secret));

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drain_does_not_restart_a_service_that_ended_after_the_running_check() {
        let root = scratch("drain-ended");
        let bridge = peer(&root);
        let pid = pid_of(&bridge.request(None, "echo", json!({})).unwrap());
        assert!(bridge.is_running());
        // The tray has obtained the running bridge, but the process ends before its drain
        // thread sends the request. Put that exact ordering under test without a timing race.
        bridge.stop();
        assert!(wait_process_exit(pid, PROCESS_EXIT_LIMIT).unwrap());
        let epoch = bridge.epoch.load(Ordering::SeqCst);
        let result = bridge.request(None, "service.drain", json!({"timeoutMs": 0}));
        let restarted = bridge.is_running();
        let after = bridge.epoch.load(Ordering::SeqCst);
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
        assert!(!restarted, "a drain restarted the service while quitting");
        assert_eq!(after, epoch);
        assert_code(result, code::HOST_SERVICE_STOPPED);
    }

    #[test]
    fn drain_does_not_start_a_service_that_was_never_started() {
        let root = scratch("drain-idle");
        let bridge = peer(&root);
        let result = bridge.request(None, "service.drain", json!({"timeoutMs": 0}));
        let started = bridge.is_running();
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
        assert!(!started, "a drain started an idle service");
        assert_code(result, code::HOST_SERVICE_STOPPED);
    }

    #[test]
    fn running_real_service_drains_without_changing_generation() {
        let root = scratch("drain-real");
        let bridge = bridge_for(repository().join("src/service/main.ts"), &root);
        bridge.request(None, "settings.get", json!({})).unwrap();
        let epoch = bridge.epoch.load(Ordering::SeqCst);
        let result = bridge.request(None, "service.drain", json!({"timeoutMs": 0}));
        let after = bridge.epoch.load(Ordering::SeqCst);
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap(), json!({"finished": true, "cancelled": 0}));
        assert_eq!(after, epoch);
    }

    #[test]
    fn service_that_exits_fails_waiting_requests_and_restarts() {
        let root = scratch("restart");
        let bridge = peer(&root);
        let first = pid_of(&bridge.request(None, "echo", json!({"n":1})).unwrap());
        let waiting = send_in_background(&bridge, "waiting", "silent");

        assert_code(
            bridge.request(None, "exit", json!({})),
            code::HOST_SERVICE_DISCONNECTED,
        );
        assert_code(waiting.join().unwrap(), code::HOST_SERVICE_DISCONNECTED);
        assert!(wait_process_exit(first, PROCESS_EXIT_LIMIT).unwrap());

        let reply = bridge.request(None, "echo", json!({"n":2})).unwrap();
        assert_eq!(reply["params"], json!({"n":2}));
        assert_ne!(pid_of(&reply), first);

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    /// How many generations the race test may cycle through before it gives up on seeing
    /// `start()` hold the `process` lock (it needs to be seen only once).
    const RACE_ATTEMPTS: usize = 5;

    fn process_lock_is_held(bridge: &Bridge) -> bool {
        matches!(
            bridge.process.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        )
    }

    fn wait_for_free_process_lock(bridge: &Bridge) {
        let deadline = Instant::now() + PENDING_WAIT;
        while process_lock_is_held(bridge) {
            assert!(
                Instant::now() < deadline,
                "the process lock was never released"
            );
            thread::sleep(PENDING_POLL);
        }
    }

    /// Returns true once `starter` (a `start()` just launched on its own thread) is seen holding
    /// `process`, which it does for as long as it takes to launch Bun. Returns false when it
    /// finished before that could be seen.
    fn start_is_holding_the_process_lock(
        bridge: &Bridge,
        starter: &thread::JoinHandle<Result<(), HostError>>,
    ) -> bool {
        let deadline = Instant::now() + PENDING_WAIT;
        while Instant::now() < deadline && !starter.is_finished() {
            if process_lock_is_held(bridge) {
                return true;
            }
            thread::yield_now();
        }
        false
    }

    /// Generation 1's reader retires late, on its own thread, while generation 2 is being
    /// started. `retire` checks the epoch and `start()` changes it, both under `process`, so the
    /// retire either runs before generation 2 exists or finds the epoch moved on and leaves it
    /// alone. A check made before taking the lock would pass on generation 1's epoch, wait behind
    /// `start()`, and then end generation 2.
    #[test]
    fn late_retire_of_an_old_generation_keeps_the_new_one() {
        let root = scratch("race");
        let bridge = peer(&root);

        let mut raced = None;
        for _ in 0..RACE_ATTEMPTS {
            // A generation runs, and its process ends; its reader retires it as usual.
            bridge.start().unwrap();
            let first_epoch = bridge.epoch.load(Ordering::SeqCst);
            assert_code(
                bridge.request(None, "exit", json!({})),
                code::HOST_SERVICE_DISCONNECTED,
            );
            wait_for_free_process_lock(&bridge);

            // The next generation starts on its own thread. Once `start()` is seen holding
            // `process`, the old generation's retire arrives, on yet another thread.
            let starter = {
                let bridge = Arc::clone(&bridge);
                thread::spawn(move || bridge.start())
            };
            let holding = start_is_holding_the_process_lock(&bridge, &starter);
            let late = holding.then(|| {
                let bridge = Arc::clone(&bridge);
                thread::spawn(move || bridge.retire(first_epoch, code::HOST_SERVICE_DISCONNECTED))
            });
            starter.join().unwrap().unwrap();
            if let Some(late) = late {
                assert!(
                    !late.join().unwrap(),
                    "the late retire ended a generation that had already been replaced"
                );
                raced = Some(first_epoch);
                break;
            }
        }
        let first_epoch = raced.expect("start() was never seen holding the process lock");

        // The new generation is intact: same epoch, live process, its own stdin.
        let second_epoch = bridge.epoch.load(Ordering::SeqCst);
        assert_eq!(second_epoch, first_epoch + 1);
        let second = {
            let mut process = bridge.process.lock().unwrap();
            let running = process
                .as_mut()
                .expect("the late retire removed generation 2's process");
            assert!(running.child.try_wait().unwrap().is_none());
            running.child.id()
        };
        assert_eq!(
            bridge
                .stdin
                .lock()
                .unwrap()
                .as_ref()
                .map(|input| input.epoch),
            Some(second_epoch)
        );
        assert_eq!(
            pid_of(&bridge.request(None, "echo", json!({})).unwrap()),
            second
        );

        // A request now in flight in generation 2 survives another late retire of generation 1.
        let held = send_in_background(&bridge, "held", "silent");
        assert!(!bridge.retire(first_epoch, code::HOST_SERVICE_DISCONNECTED));
        assert!(bridge.pending.lock().unwrap().contains_key("held"));
        assert_eq!(bridge.epoch.load(Ordering::SeqCst), second_epoch);
        assert_eq!(
            pid_of(&bridge.request(None, "echo", json!({})).unwrap()),
            second
        );

        bridge.stop();
        assert_code(held.join().unwrap(), code::HOST_SERVICE_STOPPED);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stop_ends_the_service_grandchild_through_the_job() {
        let root = scratch("job");
        let bridge = peer(&root);
        let grandchild = pid_of(&bridge.request(None, "grandchild", json!({})).unwrap());
        assert!(
            !wait_process_exit(grandchild, Duration::ZERO).unwrap(),
            "the grandchild must be running before stop()"
        );

        bridge.stop();
        assert!(
            wait_process_exit(grandchild, PROCESS_EXIT_LIMIT).unwrap(),
            "the grandchild outlived stop() by {PROCESS_EXIT_LIMIT:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// PN-2: a save that is still classifying keeps sending heartbeats, so the host waits for its
    /// confirmed result however long it takes instead of discarding it at a fixed limit.
    #[test]
    fn heartbeats_keep_a_request_waiting_past_twice_the_silence_limit() {
        let root = scratch("heartbeat");
        let bridge = quiet_peer(&root);
        let service = pid_of(&bridge.request(None, "echo", json!({})).unwrap());

        let reply_after = SHORT_SILENCE_LIMIT * 2;
        let started = Instant::now();
        let reply = bridge
            .request(
                None,
                "heartbeat",
                json!({
                    "beatMs": millis(SHORT_HEARTBEAT),
                    "replyAfterMs": millis(reply_after),
                    "state": "saved",
                }),
            )
            .expect("a request the service keeps alive is never cut off");
        // The peer's own timer decides when it answers (a JS timer may fire a millisecond early
        // by this clock); what matters is that the host kept waiting well past its silence limit.
        let waited = started.elapsed();
        assert!(
            waited > SHORT_SILENCE_LIMIT + SHORT_SILENCE_LIMIT / 2,
            "the reply came after only {waited:?}"
        );
        assert_eq!(reply["params"]["state"], json!("saved"));
        // The same process answered: the heartbeats neither broke the read loop nor restarted it.
        assert_eq!(pid_of(&reply), service);

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn silent_service_is_stopped_with_its_process_tree_and_waiting_requests_fail() {
        let root = scratch("silence");
        let bridge = quiet_peer(&root);
        let service = pid_of(&bridge.request(None, "echo", json!({})).unwrap());
        let grandchild = pid_of(&bridge.request(None, "grandchild", json!({})).unwrap());

        let started = Instant::now();
        let other = send_in_background(&bridge, "other", "silent");
        assert_code(
            bridge.request(None, "silent", json!({})),
            code::HOST_SERVICE_UNRESPONSIVE,
        );
        let waited = started.elapsed();
        assert!(
            waited >= SHORT_SILENCE_LIMIT,
            "stopped after {waited:?}, inside the {SHORT_SILENCE_LIMIT:?} limit"
        );
        assert!(
            waited < SHORT_SILENCE_LIMIT + SILENCE_DETECTION_SLACK,
            "stopped only after {waited:?}"
        );
        assert_code(other.join().unwrap(), code::HOST_SERVICE_UNRESPONSIVE);
        assert!(bridge.process.lock().unwrap().is_none());
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert!(wait_process_exit(service, PROCESS_EXIT_LIMIT).unwrap());
        assert!(
            wait_process_exit(grandchild, PROCESS_EXIT_LIMIT).unwrap(),
            "the grandchild outlived the unresponsive service by {PROCESS_EXIT_LIMIT:?}"
        );

        // The next request starts a new generation.
        let reply = bridge.request(None, "echo", json!({})).unwrap();
        assert_ne!(pid_of(&reply), service);

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    fn set_step_hook(
        bridge: &Arc<Bridge>,
        hook: impl Fn(&Arc<Bridge>, &str, RequestStep) + Send + Sync + 'static,
    ) {
        *bridge.step_hook.lock().unwrap() = Some(Box::new(hook));
    }

    fn running_pid(bridge: &Bridge) -> u32 {
        let mut process = bridge.process.lock().unwrap();
        let running = process.as_mut().expect("a generation is running");
        assert!(
            running.child.try_wait().unwrap().is_none(),
            "the running generation's process has ended"
        );
        running.child.id()
    }

    /// The ids of every request the running peer process has read, and that process's id.
    fn seen_by_peer(bridge: &Arc<Bridge>) -> (Vec<String>, u32) {
        let reply = bridge.request(None, "seen", json!({})).unwrap();
        let ids = reply["ids"]
            .as_array()
            .unwrap_or_else(|| panic!("seen reply has no ids: {reply}"))
            .iter()
            .map(|id| id.as_str().expect("request ids are strings").to_owned())
            .collect();
        (ids, pid_of(&reply))
    }

    /// PFIX-3 Medium 1: a request registered in generation N whose generation ends, and N+1
    /// starts, before its line is written. The line must not reach N+1 (it would run there while
    /// the caller is told it failed, and a resend under a new id would run it twice); the caller
    /// gets `HOST_SERVICE_STOPPED` and N+1 keeps running.
    #[test]
    fn a_request_whose_generation_ended_before_its_write_never_reaches_the_next_one() {
        let root = scratch("moved");
        let bridge = peer(&root);
        let first = pid_of(&bridge.request(None, "echo", json!({})).unwrap());
        let first_epoch = bridge.epoch.load(Ordering::SeqCst);
        let next_pid = Arc::new(Mutex::new(None::<u32>));
        let recorded = Arc::clone(&next_pid);
        set_step_hook(&bridge, move |bridge, id, step| {
            if id == "moved" && step == RequestStep::Registered {
                // Generation N's output ends (as when its process exits) and the next request's
                // `start()` replaces it, all before this request's line is written.
                assert!(bridge.retire(first_epoch, code::HOST_SERVICE_DISCONNECTED));
                bridge.start().unwrap();
                *recorded.lock().unwrap() = Some(running_pid(bridge));
            }
        });

        assert_code(
            bridge.request(Some("moved".into()), "echo", json!({})),
            code::HOST_SERVICE_STOPPED,
        );
        let next = next_pid
            .lock()
            .unwrap()
            .expect("the hook started generation N+1");
        assert_ne!(next, first);
        assert!(wait_process_exit(first, PROCESS_EXIT_LIMIT).unwrap());
        assert_eq!(bridge.epoch.load(Ordering::SeqCst), first_epoch + 1);
        assert!(!bridge.pending.lock().unwrap().contains_key("moved"));

        let (ids, pid) = seen_by_peer(&bridge);
        assert_eq!(pid, next, "generation N+1 kept running");
        assert!(
            !ids.iter().any(|id| id == "moved"),
            "the old generation's request reached the new process: {ids:?}"
        );

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }

    /// PFIX-3 Medium 1: a write that fails on generation N, while N+1 has started before the
    /// failure is handled. Handling the failure ends N only; N+1 and its process survive.
    #[test]
    fn a_failed_write_to_an_old_generation_leaves_the_new_one_running() {
        let root = scratch("write-failed");
        let bridge = peer(&root);
        let first = pid_of(&bridge.request(None, "echo", json!({})).unwrap());
        let first_epoch = bridge.epoch.load(Ordering::SeqCst);
        let next_pid = Arc::new(Mutex::new(None::<u32>));
        let recorded = Arc::clone(&next_pid);
        set_step_hook(&bridge, move |bridge, id, step| {
            if id != "broken" {
                return;
            }
            match step {
                RequestStep::Registered => {
                    // Generation N's process dies with its stdin still in the slot, so the write
                    // that follows fails (a broken pipe, or no pipe once N's reader retired it).
                    let mut process = bridge.process.lock().unwrap();
                    let running = process.as_mut().expect("generation N is running");
                    running.child.kill().unwrap();
                    running.child.wait().unwrap();
                }
                RequestStep::WriteFailed => {
                    // Before the failure is handled, N is retired (by its reader or here) and a
                    // concurrent request starts N+1.
                    bridge.retire(first_epoch, code::HOST_SERVICE_DISCONNECTED);
                    bridge.start().unwrap();
                    *recorded.lock().unwrap() = Some(running_pid(bridge));
                }
            }
        });

        let error = bridge
            .request(Some("broken".into()), "echo", json!({}))
            .unwrap_err();
        assert!(
            [
                code::HOST_SERVICE_WRITE_FAILED,
                code::HOST_SERVICE_NOT_CONNECTED
            ]
            .contains(&error.code_str()),
            "unexpected write failure: {error:?}"
        );
        let next = next_pid
            .lock()
            .unwrap()
            .expect("the hook started generation N+1");
        assert_ne!(next, first);
        assert_eq!(bridge.epoch.load(Ordering::SeqCst), first_epoch + 1);
        assert_eq!(running_pid(&bridge), next, "generation N+1 was ended");
        assert_eq!(seen_by_peer(&bridge).1, next);

        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }
}
