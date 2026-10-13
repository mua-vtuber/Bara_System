//! OpenSSH preparation (`ensure_ssh`) and the SSH private-key picker (`choose_key_file`).
//! Both commands return [`HostError`] so the screen looks up Korean text the same way as
//! every other native failure (`src/ui/messages.ts` `hostErrors`).

use std::{
    ffi::{c_void, OsStr},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use crate::{
    host_error::{code, HostError},
    native_host,
};

type Handle = *mut c_void;
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x00000040;
const SW_HIDE: i32 = 0;
/// How long `ensure_ssh` waits for the elevated OpenSSH installer before returning
/// `HOST_SSH_INSTALL_TIMEOUT` and leaving the installer running in the background.
const OPENSSH_INSTALL_WAIT: Duration = Duration::from_secs(10 * 60);
/// How often the wait loop checks the cancellation flag and re-evaluates the deadline.
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// `WAIT_OBJECT_0` from `winbase.h`: the process handle is signaled, i.e. the process ended.
const WAIT_OBJECT_0: u32 = 0x00000000;
/// `WAIT_TIMEOUT` from `winerror.h`: `WaitForSingleObject` returned because `milliseconds`
/// elapsed with the handle still unsignaled.
const WAIT_TIMEOUT: u32 = 0x00000102;
/// `ERROR_CANCELLED` from `winerror.h`: the user declined the UAC elevation prompt.
const ERROR_CANCELLED: i32 = 1223;

#[repr(C)]
struct ShellExecuteInfo {
    cb_size: u32,
    f_mask: u32,
    hwnd: Handle,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: Handle,
    id_list: *mut c_void,
    class: *const u16,
    class_key: Handle,
    hot_key: u32,
    icon_or_monitor: Handle,
    process: Handle,
}
#[link(name = "Shell32")]
unsafe extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
}
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

/// Holds a process handle in the raw `isize` form so it can sit in a `static` (a raw pointer
/// is not `Send`/`Sync`, but a Windows `HANDLE` value freely crosses threads).
#[derive(Clone, Copy)]
struct RawHandle(isize);
unsafe impl Send for RawHandle {}

/// The elevated OpenSSH installer and the `ensure_ssh` call waiting for it.
struct InstallSlot {
    /// The installer an earlier or the current `ensure_ssh` call started, until a wait sees it
    /// exit. It stays here while a call waits on it, and after a wait that timed out or was
    /// cancelled: an ordinary Windows account cannot close an elevated process started via
    /// `runas`, so the next call waits on this same handle instead of raising a second UAC
    /// prompt and a second installer.
    installer: Option<RawHandle>,
    /// The cancel flag of the call waiting right now; `None` while nobody waits. A second call
    /// in the meantime is refused with `HOST_SSH_INSTALL_BUSY`, and `cancel_ensure_ssh` ends only
    /// this wait, never a later one.
    waiter: Option<Arc<AtomicBool>>,
}

impl InstallSlot {
    const EMPTY: Self = Self {
        installer: None,
        waiter: None,
    };
}

static INSTALL: Mutex<InstallSlot> = Mutex::new(InstallSlot::EMPTY);

fn lock_slot(slot: &Mutex<InstallSlot>) -> Result<MutexGuard<'_, InstallSlot>, HostError> {
    slot.lock()
        .map_err(|_| HostError::new(code::HOST_STATE_LOCK_FAILED))
}

/// One `ensure_ssh` call's turn to wait. Dropping it, however the call ends, frees the turn for
/// the next call; the installer handle stays in the slot unless [`WaitTurn::release`] closed it.
struct WaitTurn<'a> {
    slot: &'a Mutex<InstallSlot>,
    cancel: Arc<AtomicBool>,
}

impl<'a> WaitTurn<'a> {
    /// Takes the turn and returns the installer an earlier call left running, if any.
    fn claim(slot: &'a Mutex<InstallSlot>) -> Result<(Self, Option<Handle>), HostError> {
        let mut state = lock_slot(slot)?;
        if state.waiter.is_some() {
            return Err(HostError::new(code::HOST_SSH_INSTALL_BUSY));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state.waiter = Some(Arc::clone(&cancel));
        let installer = state.installer.map(|RawHandle(value)| value as Handle);
        Ok((Self { slot, cancel }, installer))
    }

    /// Records the installer this call just started, so no later call starts another one.
    fn keep(&self, handle: Handle) -> Result<(), HostError> {
        lock_slot(self.slot)?.installer = Some(RawHandle(handle as isize));
        Ok(())
    }

    /// The installer is finished with (it exited, or its handle can no longer be waited on):
    /// forget it and close its handle.
    fn release(&self, handle: Handle) {
        if let Ok(mut state) = self.slot.lock() {
            state.installer = None;
        }
        unsafe {
            CloseHandle(handle);
        }
    }
}

impl Drop for WaitTurn<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.slot.lock() {
            state.waiter = None;
        }
    }
}

/// `%WINDIR%\System32`, taken from the value the caller already read from the environment.
/// PN-10: a missing `WINDIR` is a definite host failure (`HOST_WINDIR_MISSING`), never guessed
/// as `C:\Windows`, because a non-default Windows install would silently look in the wrong place.
fn system_dir_from(windir: Option<&OsStr>) -> Result<PathBuf, HostError> {
    let windir = windir.ok_or_else(|| HostError::new(code::HOST_WINDIR_MISSING))?;
    Ok(PathBuf::from(windir).join("System32"))
}

fn system_dir() -> Result<PathBuf, HostError> {
    system_dir_from(std::env::var_os("WINDIR").as_deref())
}

fn ssh_path() -> Result<PathBuf, HostError> {
    Ok(system_dir()?.join("OpenSSH/ssh.exe"))
}

fn powershell_path() -> Result<PathBuf, HostError> {
    Ok(system_dir()?.join("WindowsPowerShell/v1.0/powershell.exe"))
}

/// The PowerShell fragment that writes `expr`'s string value to the process's real stdout
/// handle as UTF-8 bytes, bypassing `[Console]::Out`.
///
/// `[Console]::Out.Write` writes through the console output code page (CP949 on a Korean
/// Windows install), while this Rust side always reads UTF-8, so a Korean path written through
/// `[Console]::Out` arrives corrupted. Setting `[Console]::OutputEncoding` does not fix it: a
/// `CREATE_NO_WINDOW` process has no console to attach the encoding to, and when the output is
/// already redirected (as it is here) the stream's writer was constructed before any such
/// change and does not pick it up. Writing straight to the OS stdout handle sidesteps both.
fn utf8_stdout(expr: &str) -> String {
    format!(
        "$b=[Text.Encoding]::UTF8.GetBytes({expr}); $o=[Console]::OpenStandardOutput(); $o.Write($b,0,$b.Length); $o.Flush()"
    )
}

/// Parses the raw bytes a picker or probe script wrote via [`utf8_stdout`]. Empty output means
/// the user closed the dialog without choosing anything (`None`); bytes that are not valid
/// UTF-8 mean the value could not be recovered at all, which is a decode failure rather than
/// "nothing chosen".
fn decode_picker_output(bytes: &[u8]) -> Result<Option<String>, HostError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    String::from_utf8(bytes.to_vec())
        .map(Some)
        .map_err(|_| HostError::new(code::HOST_SSH_PICKER_DECODE_FAILED))
}

/// Outcome of waiting for a child process to end, distinguishing a real timeout or
/// cancellation from a normal exit so the caller can report each with its own code.
#[derive(Debug)]
enum WaitOutcome {
    Exited(u32),
    TimedOut,
    Cancelled,
    /// Windows could not wait on the handle or read its exit code. The process may still be
    /// running, so no exit code is invented (reading one anyway returns `STILL_ACTIVE`, 259).
    Failed(std::io::Error),
}

/// Polls `handle` with `WaitForSingleObject` in `WAIT_POLL_INTERVAL` slices instead of blocking
/// on `INFINITE`, so the wait can end early on `deadline` or `cancel` without leaving the
/// process itself running unmonitored. Ordinary Windows accounts cannot terminate the elevated
/// installer process, so on `TimedOut`/`Cancelled` the process is left running; the caller
/// keeps its handle in `INSTALL` (`InstallSlot::installer`) so a later call can resume waiting on it.
fn wait_installer(handle: Handle, deadline: Instant, cancel: &AtomicBool) -> WaitOutcome {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return WaitOutcome::Cancelled;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return WaitOutcome::TimedOut;
        }
        let slice = remaining.min(WAIT_POLL_INTERVAL).as_millis() as u32;
        match unsafe { WaitForSingleObject(handle, slice) } {
            WAIT_TIMEOUT => continue,
            WAIT_OBJECT_0 => {
                let mut exit_code = 0u32;
                if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
                    return WaitOutcome::Failed(std::io::Error::last_os_error());
                }
                return WaitOutcome::Exited(exit_code);
            }
            // `WAIT_FAILED`: the handle cannot be waited on; `GetLastError` names why.
            _ => return WaitOutcome::Failed(std::io::Error::last_os_error()),
        }
    }
}

fn launch_openssh_installer() -> Result<Handle, HostError> {
    let powershell = powershell_path()?;
    if !powershell.is_file() {
        return Err(HostError::new(code::HOST_SSH_UNAVAILABLE));
    }
    let command = "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null; if (-not (Test-Path (Join-Path $env:WINDIR 'System32\\OpenSSH\\ssh.exe'))) { exit 1 }";
    let verb = wide("runas");
    let file = wide(powershell.as_os_str());
    let arguments = wide(format!(
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{command}\""
    ));
    let mut info = ShellExecuteInfo {
        cb_size: std::mem::size_of::<ShellExecuteInfo>() as u32,
        f_mask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: ptr::null_mut(),
        verb: verb.as_ptr(),
        file: file.as_ptr(),
        parameters: arguments.as_ptr(),
        directory: ptr::null(),
        show: SW_HIDE,
        instance: ptr::null_mut(),
        id_list: ptr::null_mut(),
        class: ptr::null(),
        class_key: ptr::null_mut(),
        hot_key: 0,
        icon_or_monitor: ptr::null_mut(),
        process: ptr::null_mut(),
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_CANCELLED) {
            return Err(HostError::new(code::HOST_SSH_INSTALL_DENIED));
        }
        return Err(HostError::io(code::HOST_SSH_INSTALL_START_FAILED, &error));
    }
    if info.process.is_null() {
        return Err(HostError::new(code::HOST_SSH_INSTALL_START_FAILED));
    }
    Ok(info.process)
}

/// Installs the Windows OpenSSH client if it is missing, waiting through an elevated,
/// hidden PowerShell installer. An installer an earlier call left running (its wait timed out
/// or was cancelled) is waited on again instead of starting a second UAC prompt; a call made
/// while another one is still waiting is refused with `HOST_SSH_INSTALL_BUSY`.
pub fn ensure_ssh() -> Result<bool, HostError> {
    ensure_with(
        &INSTALL,
        || Ok(ssh_path()?.is_file()),
        launch_openssh_installer,
        OPENSSH_INSTALL_WAIT,
    )
}

/// [`ensure_ssh`] against `slot`, with how to tell OpenSSH is present (`installed`) and how to
/// start the installer (`launch`) passed in, so the tests drive it with real child processes.
fn ensure_with(
    slot: &Mutex<InstallSlot>,
    installed: impl Fn() -> Result<bool, HostError>,
    launch: impl FnOnce() -> Result<Handle, HostError>,
    wait: Duration,
) -> Result<bool, HostError> {
    let (turn, left_running) = WaitTurn::claim(slot)?;
    let handle = match left_running {
        Some(handle) => handle,
        None => {
            if installed()? {
                return Ok(true);
            }
            let handle = launch()?;
            if let Err(error) = turn.keep(handle) {
                turn.release(handle);
                return Err(error);
            }
            handle
        }
    };
    match wait_installer(handle, Instant::now() + wait, &turn.cancel) {
        WaitOutcome::TimedOut => Err(HostError::new(code::HOST_SSH_INSTALL_TIMEOUT)),
        WaitOutcome::Cancelled => Err(HostError::new(code::HOST_SSH_INSTALL_CANCELLED)),
        WaitOutcome::Failed(error) => {
            // A handle that cannot be waited on never becomes waitable again; keeping it would
            // fail every later call the same way.
            turn.release(handle);
            Err(HostError::io(code::HOST_SSH_INSTALL_WAIT_FAILED, &error))
        }
        WaitOutcome::Exited(exit_code) => {
            turn.release(handle);
            if exit_code != 0 {
                return Err(
                    HostError::new(code::HOST_SSH_INSTALL_FAILED).with_status(i64::from(exit_code))
                );
            }
            if !installed()? {
                return Err(HostError::new(code::HOST_SSH_INSTALL_FAILED));
            }
            Ok(true)
        }
    }
}

/// Stops the `ensure_ssh` wait in progress, if any (the `cancel_ensure_ssh` Tauri command). The
/// elevated installer itself keeps running; only the wait ends, and the next `ensure_ssh` call
/// waits on the same installer.
pub fn cancel_ensure_ssh() -> Result<(), HostError> {
    cancel_wait(&INSTALL)
}

fn cancel_wait(slot: &Mutex<InstallSlot>) -> Result<(), HostError> {
    if let Some(cancel) = lock_slot(slot)?.waiter.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

pub fn choose_key_file() -> Result<Option<String>, HostError> {
    use std::process::{Command, Stdio};
    let powershell = powershell_path()?;
    if !powershell.is_file() {
        return Err(HostError::new(code::HOST_SSH_PICKER_UNAVAILABLE));
    }
    let labels = native_host::ssh_key_picker_labels();
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = $env:BARA_PET_PICKER_TITLE; $d.Filter = $env:BARA_PET_PICKER_FILTER; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ {} }}",
        utf8_stdout("$d.FileName")
    );
    let mut command = Command::new(powershell);
    command
        .args([
            "-STA",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .env("BARA_PET_PICKER_TITLE", labels.title)
        .env("BARA_PET_PICKER_FILTER", labels.filter)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    super::hide_process(&mut command);
    let output = command
        .output()
        .map_err(|e| HostError::io(code::HOST_SSH_PICKER_FAILED, &e))?;
    if !output.status.success() {
        return Err(HostError::new(code::HOST_SSH_PICKER_FAILED));
    }
    let Some(path) = decode_picker_output(&output.stdout)? else {
        return Ok(None);
    };
    let selected = PathBuf::from(&path);
    if !selected.is_absolute() || !selected.is_file() {
        return Err(HostError::new(code::HOST_SSH_KEY_NOT_FOUND));
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::AtomicUsize, thread};

    #[test]
    fn decode_picker_output_handles_empty_utf8_and_invalid_bytes() {
        assert_eq!(decode_picker_output(&[]).unwrap(), None);
        let path = r"C:\Users\홍길동\.ssh\id_ed25519";
        assert_eq!(
            decode_picker_output(path.as_bytes()).unwrap(),
            Some(path.to_string())
        );
        // The CP949 encoding of "C:\Users\홍길동\.ssh\id_ed25519" (what a Korean Windows
        // console code page would have produced through the old [Console]::Out.Write path);
        // it is not valid UTF-8, which is exactly the corruption utf8_stdout avoids.
        let cp949_bytes: [u8; 31] = [
            0x43, 0x3a, 0x5c, 0x55, 0x73, 0x65, 0x72, 0x73, 0x5c, 0xc8, 0xab, 0xb1, 0xe6, 0xb5,
            0xbf, 0x5c, 0x2e, 0x73, 0x73, 0x68, 0x5c, 0x69, 0x64, 0x5f, 0x65, 0x64, 0x32, 0x35,
            0x35, 0x31, 0x39,
        ];
        let error = decode_picker_output(&cp949_bytes).unwrap_err();
        assert_eq!(error.code_str(), code::HOST_SSH_PICKER_DECODE_FAILED);
    }

    #[test]
    fn system_dir_from_none_reports_windir_missing() {
        let error = system_dir_from(None).unwrap_err();
        assert_eq!(error.code_str(), code::HOST_WINDIR_MISSING);
    }

    #[test]
    fn system_dir_from_some_joins_system32() {
        let dir = system_dir_from(Some(OsStr::new(r"C:\Windows"))).unwrap();
        assert_eq!(dir, PathBuf::from(r"C:\Windows\System32"));
    }

    /// Real Windows PowerShell, launched exactly the way `choose_key_file` launches it
    /// (`CREATE_NO_WINDOW`, `-NoProfile -NonInteractive`), must emit a Korean value through
    /// [`utf8_stdout`] as UTF-8 regardless of the system's console code page (CP949 included).
    #[test]
    fn utf8_stdout_emits_utf8_from_a_real_powershell_process() {
        let powershell = powershell_path().expect("WINDIR must be set in the test environment");
        if !powershell.is_file() {
            panic!("Windows PowerShell not found at {}", powershell.display());
        }
        let value = r"C:\Users\홍길동\.ssh\id_ed25519";
        let script = utf8_stdout("$env:BARA_PET_TEST_VALUE");
        let mut command = std::process::Command::new(&powershell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .env("BARA_PET_TEST_VALUE", value)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        super::super::hide_process(&mut command);
        let output = command.output().expect("failed to launch PowerShell");
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    }

    /// The wait loop is exercised against a real child process (`cmd.exe /c ping -n 4
    /// 127.0.0.1`, about 3 seconds), not a fake handle, per the plan's Windows-real-process
    /// requirement: a short deadline must time out, a cleared cancel flag must be reported as
    /// cancelled, and letting it run to completion must report its real exit code.
    #[test]
    fn wait_installer_reports_timeout_cancellation_and_exit_code() {
        use std::os::windows::io::AsRawHandle;

        let spawn = |args: &[&str]| {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(args);
            super::super::hide_process(&mut command);
            command.spawn().expect("failed to spawn cmd.exe")
        };

        // Timeout: the ping takes ~3s, the deadline is far shorter.
        let mut child = spawn(&["/c", "ping", "-n", "4", "127.0.0.1"]);
        let handle = child.as_raw_handle() as Handle;
        let cancel = AtomicBool::new(false);
        let outcome = wait_installer(handle, Instant::now() + Duration::from_millis(200), &cancel);
        assert!(matches!(outcome, WaitOutcome::TimedOut));
        let _ = child.kill();
        let _ = child.wait();

        // Cancellation: the flag is set before the deadline would ever fire.
        let mut child = spawn(&["/c", "ping", "-n", "4", "127.0.0.1"]);
        let handle = child.as_raw_handle() as Handle;
        let cancel = AtomicBool::new(true);
        let outcome = wait_installer(handle, Instant::now() + OPENSSH_INSTALL_WAIT, &cancel);
        assert!(matches!(outcome, WaitOutcome::Cancelled));
        let _ = child.kill();
        let _ = child.wait();

        // Normal exit: let the short-lived process run to completion and report its own code.
        let mut child = spawn(&["/c", "exit", "0"]);
        let handle = child.as_raw_handle() as Handle;
        let cancel = AtomicBool::new(false);
        let outcome = wait_installer(handle, Instant::now() + Duration::from_secs(30), &cancel);
        assert!(matches!(outcome, WaitOutcome::Exited(0)));
        let _ = child.wait();

        // A failing installer: its own non-zero exit code comes back unchanged.
        let mut child = spawn(&["/c", "exit", "3"]);
        let handle = child.as_raw_handle() as Handle;
        let outcome = wait_installer(handle, Instant::now() + Duration::from_secs(30), &cancel);
        assert!(matches!(outcome, WaitOutcome::Exited(3)), "{outcome:?}");
        let _ = child.wait();
    }

    /// PFIX-3 Medium 3: a handle Windows cannot wait on is a failure with its OS error number,
    /// never read as an exit (reading an exit code anyway gives `STILL_ACTIVE`, 259, or the old
    /// code's invented 1).
    #[test]
    fn a_handle_that_cannot_be_waited_on_is_a_failure_with_its_os_error() {
        const ERROR_INVALID_HANDLE: i32 = 6;
        let cancel = AtomicBool::new(false);
        let outcome = wait_installer(
            ptr::null_mut(),
            Instant::now() + Duration::from_secs(5),
            &cancel,
        );
        let WaitOutcome::Failed(error) = outcome else {
            panic!("expected a failed wait, got {outcome:?}");
        };
        assert_eq!(error.raw_os_error(), Some(ERROR_INVALID_HANDLE));

        let slot = Mutex::new(InstallSlot::EMPTY);
        let error = ensure_with(
            &slot,
            || Ok(false),
            || Ok(ptr::null_mut()),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(error.code_str(), code::HOST_SSH_INSTALL_WAIT_FAILED);
        assert_eq!(error.status(), Some(i64::from(ERROR_INVALID_HANDLE)));
        let state = slot.lock().unwrap();
        assert!(state.installer.is_none() && state.waiter.is_none());
    }

    /// A launcher for [`ensure_with`] that starts a real `cmd.exe` in place of the elevated
    /// installer and counts its launches. `script` runs as `cmd /c <script>`.
    fn counted_launcher<'a>(
        launches: &'a AtomicUsize,
        script: &'a str,
    ) -> impl FnOnce() -> Result<Handle, HostError> + 'a {
        move || {
            use std::os::windows::{io::IntoRawHandle, process::CommandExt};
            launches.fetch_add(1, Ordering::SeqCst);
            let mut command = std::process::Command::new("cmd.exe");
            command.raw_arg(format!("/d /c {script}"));
            super::super::hide_process(&mut command);
            let child = command.spawn().expect("failed to spawn cmd.exe");
            Ok(child.into_raw_handle() as Handle)
        }
    }

    /// PFIX-3 Medium 3: while one call waits on the installer, a second call neither starts a
    /// second installer (a second UAC prompt) nor waits on the same handle: it is refused. A
    /// cancelled wait leaves the installer in the slot, and the next call waits on that same
    /// installer to the end and closes its handle.
    #[test]
    fn a_second_call_during_a_wait_is_refused_and_a_cancelled_wait_is_resumed() {
        let marker = std::env::temp_dir().join(format!(
            "bara-pet-ssh-install-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&marker);
        // The stand-in installer takes about three seconds and, like the real one, leaves the
        // installed file behind only at its end.
        let script = format!("ping -n 4 127.0.0.1 >nul & type nul > {}", marker.display());
        let installed = || Ok(marker.is_file());
        let launches = AtomicUsize::new(0);
        let slot = Mutex::new(InstallSlot::EMPTY);
        let wait = Duration::from_secs(30);

        thread::scope(|scope| {
            let first = scope.spawn(|| {
                ensure_with(&slot, installed, counted_launcher(&launches, &script), wait)
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while launches.load(Ordering::SeqCst) == 0 {
                assert!(Instant::now() < deadline, "the first call never launched");
                thread::sleep(Duration::from_millis(10));
            }

            let second = ensure_with(&slot, installed, counted_launcher(&launches, &script), wait);
            assert_eq!(second.unwrap_err().code_str(), code::HOST_SSH_INSTALL_BUSY);
            assert_eq!(launches.load(Ordering::SeqCst), 1);

            cancel_wait(&slot).unwrap();
            assert_eq!(
                first.join().unwrap().unwrap_err().code_str(),
                code::HOST_SSH_INSTALL_CANCELLED
            );
        });
        {
            let state = slot.lock().unwrap();
            assert!(
                state.installer.is_some(),
                "the running installer was forgotten"
            );
            assert!(state.waiter.is_none());
        }
        assert!(
            !marker.is_file(),
            "the stand-in installer ended before the cancel"
        );

        assert!(ensure_with(&slot, installed, counted_launcher(&launches, &script), wait).unwrap());
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "a second installer was started"
        );
        assert!(marker.is_file());
        let state = slot.lock().unwrap();
        assert!(state.installer.is_none() && state.waiter.is_none());
        drop(state);
        std::fs::remove_file(&marker).unwrap();
    }

    /// PFIX-3 Medium 3: an installer that exits non-zero is reported with that exit code, and
    /// its handle is released so the next call starts afresh.
    #[test]
    fn an_installer_exiting_non_zero_is_reported_with_its_exit_code() {
        let launches = AtomicUsize::new(0);
        let slot = Mutex::new(InstallSlot::EMPTY);
        let error = ensure_with(
            &slot,
            || Ok(false),
            counted_launcher(&launches, "exit 3"),
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert_eq!(error.code_str(), code::HOST_SSH_INSTALL_FAILED);
        assert_eq!(error.status(), Some(3));
        let state = slot.lock().unwrap();
        assert!(state.installer.is_none() && state.waiter.is_none());
    }
}
