//! The folder backups go to (`<Documents>\<contract.backupFolderName>`). The host alone decides
//! where it is: the service learns it through `BARA_PET_BACKUP_DIR` when it starts, and the screen
//! can only ask the host to open it (`open_backup_folder`), never name a path of its own.

use crate::{
    host_error::{code, HostError},
    native_host,
};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

/// The variable that hands the folder to the service (`src/service/main.ts` `runtimePaths`).
pub const BACKUP_DIR_ENV: &str = "BARA_PET_BACKUP_DIR";

/// `configured` (`BARA_PET_BACKUP_DIR` in the host's own environment, for development and tests,
/// like `BARA_PET_DATA_DIR`) when it is set, otherwise the contract's folder under `documents`,
/// which Tauri reads through the known-folder API so a Documents folder moved to OneDrive or
/// another drive is followed. Only an absolute path counts: a relative one would land wherever
/// the process happened to start. `None` leaves backups unavailable rather than guessing a folder.
pub fn root(configured: Option<OsString>, documents: Option<PathBuf>) -> Option<PathBuf> {
    match configured.filter(|value| !value.is_empty()) {
        Some(value) => Some(PathBuf::from(value)).filter(|path| path.is_absolute()),
        None => documents
            .filter(|path| path.is_absolute())
            .map(|path| path.join(native_host::backup_folder_name())),
    }
}

/// Passes the folder to a service process, or makes sure the service sees none when the host has
/// none: an inherited value from the host's own environment must not stand in for a missing one.
pub fn set_env(command: &mut Command, root: Option<&Path>) {
    match root {
        Some(root) => command.env(BACKUP_DIR_ENV, root),
        None => command.env_remove(BACKUP_DIR_ENV),
    };
}

fn prepare(root: &Path) -> Result<(), HostError> {
    std::fs::create_dir_all(root).map_err(|e| HostError::io(code::HOST_BACKUP_FOLDER_FAILED, &e))
}

/// `%WINDIR%\explorer.exe`, the same Windows folder the host's other system tools come from
/// (`windows::ssh::system_dir_from`); a missing or relative `WINDIR` is never guessed.
#[cfg_attr(not(windows), allow(dead_code))]
fn explorer_from(windir: Option<&OsStr>) -> Result<PathBuf, HostError> {
    windir
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| path.join("explorer.exe"))
        .ok_or_else(|| HostError::new(code::HOST_WINDIR_MISSING))
}

/// Creates `root` when it is missing and shows it in Windows Explorer. Explorer is started, not
/// waited for: it often hands the window to an already running Explorer and exits with 1.
#[cfg(windows)]
pub fn open(root: &Path) -> Result<(), HostError> {
    prepare(root)?;
    let explorer = explorer_from(std::env::var_os("WINDIR").as_deref())?;
    let mut child = Command::new(explorer)
        .arg(root)
        .spawn()
        .map_err(|e| HostError::io(code::HOST_BACKUP_FOLDER_OPEN_FAILED, &e))?;
    // Reaped on its own thread so the command returns at once without leaving a handle behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(not(windows))]
pub fn open(root: &Path) -> Result<(), HostError> {
    prepare(root)?;
    Err(HostError::new(code::HOST_BACKUP_FOLDER_OPEN_FAILED))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn documents_hold_the_contract_folder_and_a_configured_folder_wins() {
        let documents = absolute("documents");
        assert_eq!(
            root(None, Some(documents.clone())),
            Some(documents.join(native_host::backup_folder_name()))
        );
        let configured = absolute("elsewhere");
        assert_eq!(
            root(
                Some(configured.clone().into_os_string()),
                Some(documents.clone())
            ),
            Some(configured)
        );
        // An empty variable is the same as none.
        assert_eq!(
            root(Some(OsString::new()), Some(documents.clone())),
            Some(documents.join(native_host::backup_folder_name()))
        );
    }

    #[test]
    fn no_folder_is_guessed_from_a_missing_or_relative_path() {
        assert_eq!(root(None, None), None);
        assert_eq!(root(None, Some(PathBuf::from("Documents"))), None);
        assert_eq!(
            root(
                Some(OsString::from("relative")),
                Some(absolute("documents"))
            ),
            None
        );
    }

    #[test]
    fn the_service_gets_the_folder_or_explicitly_none() {
        let folder = absolute("backups");
        let mut command = Command::new("service");
        set_env(&mut command, Some(&folder));
        let envs: Vec<_> = command.get_envs().collect();
        assert_eq!(
            envs,
            [(OsStr::new(BACKUP_DIR_ENV), Some(folder.as_os_str()))]
        );
        let mut command = Command::new("service");
        set_env(&mut command, None);
        let envs: Vec<_> = command.get_envs().collect();
        assert_eq!(envs, [(OsStr::new(BACKUP_DIR_ENV), None)]);
    }

    #[test]
    fn explorer_comes_only_from_an_absolute_windir() {
        let windir = absolute("Windows");
        assert_eq!(
            explorer_from(Some(windir.as_os_str())).unwrap(),
            windir.join("explorer.exe")
        );
        for missing in [None, Some(OsStr::new("Windows")), Some(OsStr::new(""))] {
            assert_eq!(
                explorer_from(missing).unwrap_err().code(),
                code::HOST_WINDIR_MISSING
            );
        }
    }

    #[test]
    fn a_folder_that_cannot_be_made_reports_only_its_code_and_status() {
        let scratch = std::env::temp_dir().join(format!(
            "bara-pet-backup-folder-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let made = scratch.join("made").join("deeper");
        prepare(&made).unwrap();
        assert!(made.is_dir());
        prepare(&made).unwrap();
        let blocker = scratch.join("a-file");
        std::fs::write(&blocker, b"file").unwrap();
        let error = prepare(&blocker.join("below")).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], code::HOST_BACKUP_FOLDER_FAILED);
        assert!(value["status"].is_i64());
        assert!(!value.to_string().contains("a-file"));
        std::fs::remove_dir_all(scratch).unwrap();
    }
}
