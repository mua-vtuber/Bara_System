//! Starts the pet's own update (docs/decisions/2026-10-14-pet-self-update-spec.md 6.3). The service
//! downloaded the installer and checked its size and sha256 (`src/service/self-update/download.ts`);
//! this runs it on its own, with `INSTALLER_ARGS`, and quits the app. Only a file directly inside
//! `<data folder>/<contract.updatesDirName>` whose name ends with `contract.installerSuffix` runs, and
//! only when that folder is a real folder, not a link.

use crate::{
    bridge::BridgeState,
    host_error::{code, HostError},
    native_host, windows,
};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State, WebviewWindow};

/// `/P` shows only the progress, `/R` starts the pet again when the install ends (spec 3), and
/// `/BARA_CLEAN` asks `windows/installer-hooks.nsh` (`BARA_CLEAN_SWITCH`) to remove the old version
/// before the new files are copied.
pub(crate) const INSTALLER_ARGS: [&str; 3] = ["/P", "/R", "/BARA_CLEAN"];

/// `canonicalize` gives `\\?\C:\...`; the installer gets the plain `C:\...` form, which it shows in
/// its own failure dialog. Any other form (a share) is kept as it is.
fn plain_path(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// `candidate` when it is an existing file directly inside the updates folder with the installer's
/// name ending; `HOST_UPDATE_PATH_REFUSED` otherwise. The path is checked as written (absolute, no
/// `.` or `..`) and again after resolving it, so no step or link leads outside.
pub(crate) fn verified_installer(data_dir: &Path, candidate: &Path) -> Result<PathBuf, HostError> {
    let refused = || HostError::new(code::HOST_UPDATE_PATH_REFUSED);
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(refused());
    }
    let name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(refused)?;
    if !name.ends_with(native_host::installer_suffix()) {
        return Err(refused());
    }
    let updates = data_dir.join(native_host::updates_dir_name());
    let folder = std::fs::symlink_metadata(&updates).map_err(|_| refused())?;
    if folder.file_type().is_symlink() || !folder.is_dir() {
        return Err(refused());
    }
    let file = std::fs::symlink_metadata(candidate).map_err(|_| refused())?;
    if !file.is_file() {
        return Err(refused());
    }
    let resolved_folder = updates.canonicalize().map_err(|_| refused())?;
    let resolved = candidate.canonicalize().map_err(|_| refused())?;
    if resolved.parent() != Some(resolved_folder.as_path()) {
        return Err(refused());
    }
    Ok(plain_path(resolved))
}

/// Set once an installer started in this run of the app; only a failed start clears it again.
static LAUNCHED: AtomicBool = AtomicBool::new(false);

/// Takes this run's one installer start: refused (`HOST_UPDATE_ALREADY_STARTED`) when one already
/// started or the app is quitting, so two calls can never run two installers.
fn claim_launch(launched: &AtomicBool, quitting: bool) -> Result<(), HostError> {
    if quitting || launched.swap(true, Ordering::SeqCst) {
        return Err(HostError::new(code::HOST_UPDATE_ALREADY_STARTED));
    }
    Ok(())
}

/// The bubble's last step after the service checked the installer: run it and quit. A start that
/// fails leaves the pet running and names the OS error (spec 6.3-2); only then may it be tried again.
#[tauri::command]
pub fn launch_update_installer(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
    path: String,
) -> Result<(), HostError> {
    if window.label() != "bubble" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let bridge = state.get(&app)?;
    let installer = verified_installer(bridge.data_dir(), Path::new(&path))?;
    claim_launch(&LAUNCHED, crate::tray::is_quitting())?;
    if let Err(error) = windows::launch_detached(&installer, &INSTALLER_ARGS) {
        LAUNCHED.store(false, Ordering::SeqCst);
        return Err(error);
    }
    // The installer closes a pet still running (spec 3); the graceful quit lets running work end first,
    // and the memory server ends with the service's Job object.
    crate::tray::quit(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU32;

    const NAME: &str = "Bara.Pet_0.1.9_x64-setup.exe";
    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A scratch data folder with an empty updates folder, removed when the test ends.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bara-self-update-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(dir.join(native_host::updates_dir_name())).unwrap();
            Scratch(dir)
        }
        fn updates(&self) -> PathBuf {
            self.0.join(native_host::updates_dir_name())
        }
        fn file(&self, path: PathBuf) -> PathBuf {
            fs::write(&path, b"setup").unwrap();
            path
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn refused(data: &Path, candidate: &Path) -> bool {
        verified_installer(data, candidate)
            .is_err_and(|error| error.code() == code::HOST_UPDATE_PATH_REFUSED)
    }

    #[test]
    fn the_checked_installer_inside_the_updates_folder_runs_by_its_plain_path() {
        let scratch = Scratch::new();
        let installer = scratch.file(scratch.updates().join(NAME));
        let verified = verified_installer(&scratch.0, &installer).unwrap();
        assert_eq!(verified.file_name().unwrap(), NAME);
        assert!(
            !verified.to_string_lossy().starts_with(r"\\?\"),
            "{verified:?}"
        );
        assert_eq!(fs::read(&verified).unwrap(), b"setup");
    }

    #[test]
    fn a_file_outside_the_updates_folder_is_refused() {
        let scratch = Scratch::new();
        let outside = scratch.file(scratch.0.join(NAME));
        assert!(refused(&scratch.0, &outside));
        assert!(refused(
            &scratch.0,
            &scratch.updates().join("..").join(NAME)
        ));
        fs::create_dir_all(scratch.updates().join("sub")).unwrap();
        let nested = scratch.file(scratch.updates().join("sub").join(NAME));
        assert!(refused(&scratch.0, &nested));
        assert!(refused(
            &scratch.0,
            &scratch.updates().join("sub").join("..").join(NAME)
        ));
        assert!(refused(&scratch.0, Path::new(NAME)));
    }

    #[test]
    fn only_an_existing_file_with_the_installer_name_runs() {
        let scratch = Scratch::new();
        assert!(refused(&scratch.0, &scratch.updates().join(NAME)));
        let other = scratch.file(scratch.updates().join("setup.exe"));
        assert!(refused(&scratch.0, &other));
        let partial = scratch.file(scratch.updates().join(format!("{NAME}.partial")));
        assert!(refused(&scratch.0, &partial));
        fs::create_dir_all(scratch.updates().join(NAME)).unwrap();
        assert!(refused(&scratch.0, &scratch.updates().join(NAME)));
    }

    #[cfg(windows)]
    #[test]
    fn an_updates_folder_that_is_a_junction_is_refused() {
        let scratch = Scratch::new();
        let elsewhere = Scratch::new();
        let target = elsewhere.file(elsewhere.updates().join(NAME));
        fs::remove_dir(scratch.updates()).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(scratch.updates())
            .arg(elsewhere.updates())
            .output()
            .unwrap();
        assert!(made.status.success());
        assert!(refused(&scratch.0, &scratch.updates().join(NAME)));
        assert!(target.is_file());
    }

    #[cfg(windows)]
    #[test]
    fn a_path_through_a_junction_inside_the_updates_folder_is_refused() {
        let scratch = Scratch::new();
        let elsewhere = Scratch::new();
        let target = elsewhere.file(elsewhere.updates().join(NAME));
        let link = scratch.updates().join("link");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(elsewhere.updates())
            .output()
            .unwrap();
        assert!(made.status.success());
        assert!(link.join(NAME).is_file());
        assert!(refused(&scratch.0, &link.join(NAME)));
        assert!(target.is_file());
    }

    #[test]
    fn only_one_installer_start_is_allowed_until_a_start_fails() {
        let launched = AtomicBool::new(false);
        let already = |result: Result<(), HostError>| {
            result.is_err_and(|error| error.code() == code::HOST_UPDATE_ALREADY_STARTED)
        };
        assert!(already(claim_launch(&launched, true)), "quitting refuses");
        assert!(!launched.load(Ordering::SeqCst), "a refusal takes nothing");
        assert!(claim_launch(&launched, false).is_ok());
        assert!(already(claim_launch(&launched, false)), "a second start");
        // A failed start clears the flag (launch_update_installer), so the arrow button can try again.
        launched.store(false, Ordering::SeqCst);
        assert!(claim_launch(&launched, false).is_ok());
    }

    #[test]
    fn a_verbatim_drive_path_becomes_the_plain_one() {
        assert_eq!(
            plain_path(PathBuf::from(r"\\?\C:\a\b.exe")),
            PathBuf::from(r"C:\a\b.exe")
        );
        assert_eq!(
            plain_path(PathBuf::from(r"\\?\UNC\s\x\b.exe")),
            PathBuf::from(r"\\?\UNC\s\x\b.exe")
        );
        assert_eq!(
            plain_path(PathBuf::from(r"C:\a\b.exe")),
            PathBuf::from(r"C:\a\b.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_installer_that_cannot_start_reports_the_os_error() {
        let error = windows::launch_detached(
            Path::new(r"C:\bara-missing-folder\Bara.Pet_0.1.9_x64-setup.exe"),
            &INSTALLER_ARGS,
        )
        .unwrap_err();
        assert_eq!(error.code(), code::HOST_UPDATE_LAUNCH_FAILED);
        assert!(error.status().is_some());
    }

    const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");

    #[test]
    fn the_installer_hook_removes_the_old_version_only_for_the_pets_own_switch() {
        assert_eq!(INSTALLER_ARGS, ["/P", "/R", "/BARA_CLEAN"]);
        assert!(HOOKS.contains(&format!(
            "!define BARA_CLEAN_SWITCH \"{}\"",
            INSTALLER_ARGS[2]
        )));
        let hook = HOOKS
            .split("!macro NSIS_HOOK_PREINSTALL")
            .nth(1)
            .and_then(|rest| rest.split("!macroend").next())
            .expect("the preinstall hook");
        for condition in [
            "${GetOptions} $CMDLINE \"${BARA_CLEAN_SWITCH}\" $BaraCleanOption",
            "${IfNot} ${Errors}",
            "${AndIf} $PassiveMode = 1",
            "${AndIf} $UpdateMode <> 1",
            "${If} $BaraOldUninstaller != \"\"",
            "${AndIf} $BaraOldDir != \"\"",
        ] {
            assert!(hook.contains(condition), "{condition}");
        }
        assert!(hook
            .contains("ExecWait '$BaraOldUninstaller /P /UPDATE _?=$BaraOldDir' $BaraCleanExit"));
        assert!(hook.contains("${ElseIf} ${FileExists} \"$BaraOldDir\\${MAINBINARYNAME}.exe\""));
        // The old memory server's Bun is waited for with the same limits as the model-deletion step.
        for wait in [
            "${DoWhile} ${FileExists} \"$BaraOldDir\\${BARA_SERVICE_RUNTIME}\"",
            "Delete \"$BaraOldDir\\${BARA_SERVICE_RUNTIME}\"",
            "${If} $BaraTries >= ${BARA_RUNTIME_WAIT_TRIES}",
            "StrCpy $BaraCleanMessage \"${BARA_TEXT_CLEAN_RUNTIME_BUSY}$BaraOldDir\\${BARA_SERVICE_RUNTIME}\"",
            "Sleep ${BARA_RUNTIME_WAIT_MS}",
        ] {
            assert!(hook.contains(wait), "{wait}");
        }
        assert!(hook.contains("MessageBox MB_OK|MB_ICONSTOP"));
        assert!(hook.contains("$EXEPATH"));
        assert!(hook.contains("Abort"));
    }
}
