use serde::Serialize;
use std::{borrow::Cow, fmt};

/// Error codes the host itself raises. The screen maps each one to Korean text in
/// `src/ui/messages.ts` (`hostErrors`), and `src/shared/native-host.json`
/// (`contract.hostErrorCodes`) lists the same set so both sides can check it.
pub mod code {
    pub const HOST_WINDOW_NOT_ALLOWED: &str = "HOST_WINDOW_NOT_ALLOWED";
    pub const HOST_INVALID_REQUEST: &str = "HOST_INVALID_REQUEST";
    pub const HOST_REQUEST_TOO_LARGE: &str = "HOST_REQUEST_TOO_LARGE";
    pub const HOST_WINDOW_MISSING: &str = "HOST_WINDOW_MISSING";
    pub const HOST_WINDOW_OPERATION_FAILED: &str = "HOST_WINDOW_OPERATION_FAILED";
    pub const HOST_STATE_LOCK_FAILED: &str = "HOST_STATE_LOCK_FAILED";
    pub const HOST_TASK_FAILED: &str = "HOST_TASK_FAILED";
    pub const HOST_DATA_DIR_FAILED: &str = "HOST_DATA_DIR_FAILED";
    pub const HOST_RESOURCE_DIR_FAILED: &str = "HOST_RESOURCE_DIR_FAILED";
    pub const HOST_SERVICE_MISSING: &str = "HOST_SERVICE_MISSING";
    pub const HOST_RUNTIME_MISSING: &str = "HOST_RUNTIME_MISSING";
    pub const HOST_SERVICE_START_FAILED: &str = "HOST_SERVICE_START_FAILED";
    pub const HOST_JOB_FAILED: &str = "HOST_JOB_FAILED";
    pub const HOST_SERVICE_STOPPED: &str = "HOST_SERVICE_STOPPED";
    pub const HOST_SERVICE_DISCONNECTED: &str = "HOST_SERVICE_DISCONNECTED";
    pub const HOST_SERVICE_NOT_CONNECTED: &str = "HOST_SERVICE_NOT_CONNECTED";
    pub const HOST_SERVICE_WRITE_FAILED: &str = "HOST_SERVICE_WRITE_FAILED";
    pub const HOST_SERVICE_PIPE_STALLED: &str = "HOST_SERVICE_PIPE_STALLED";
    pub const HOST_DUPLICATE_REQUEST: &str = "HOST_DUPLICATE_REQUEST";
    pub const HOST_SERVICE_UNRESPONSIVE: &str = "HOST_SERVICE_UNRESPONSIVE";
    pub const HOST_SERVICE_ERROR_REDACTED: &str = "HOST_SERVICE_ERROR_REDACTED";
    pub const HOST_DASHBOARD_LINK_INVALID: &str = "HOST_DASHBOARD_LINK_INVALID";
    pub const HOST_BROWSER_OPEN_FAILED: &str = "HOST_BROWSER_OPEN_FAILED";
    pub const HOST_TEXT_CATALOG_INVALID: &str = "HOST_TEXT_CATALOG_INVALID";
    pub const HOST_INSTANCE_GUARD_FAILED: &str = "HOST_INSTANCE_GUARD_FAILED";
    pub const HOST_BUILD_FAILED: &str = "HOST_BUILD_FAILED";
    pub const HOST_FATAL_PANIC: &str = "HOST_FATAL_PANIC";
    pub const HOST_AUTOSTART_REGISTRY_FAILED: &str = "HOST_AUTOSTART_REGISTRY_FAILED";
    pub const HOST_AUTOSTART_READ_FAILED: &str = "HOST_AUTOSTART_READ_FAILED";
    pub const HOST_AUTOSTART_READ_INVALID: &str = "HOST_AUTOSTART_READ_INVALID";
    pub const HOST_WINDIR_MISSING: &str = "HOST_WINDIR_MISSING";
    pub const HOST_SSH_UNAVAILABLE: &str = "HOST_SSH_UNAVAILABLE";
    pub const HOST_SSH_INSTALL_DENIED: &str = "HOST_SSH_INSTALL_DENIED";
    pub const HOST_SSH_INSTALL_START_FAILED: &str = "HOST_SSH_INSTALL_START_FAILED";
    pub const HOST_SSH_INSTALL_CANCELLED: &str = "HOST_SSH_INSTALL_CANCELLED";
    pub const HOST_SSH_INSTALL_TIMEOUT: &str = "HOST_SSH_INSTALL_TIMEOUT";
    pub const HOST_SSH_INSTALL_FAILED: &str = "HOST_SSH_INSTALL_FAILED";
    pub const HOST_SSH_INSTALL_BUSY: &str = "HOST_SSH_INSTALL_BUSY";
    pub const HOST_SSH_INSTALL_WAIT_FAILED: &str = "HOST_SSH_INSTALL_WAIT_FAILED";
    pub const HOST_SSH_PICKER_UNAVAILABLE: &str = "HOST_SSH_PICKER_UNAVAILABLE";
    pub const HOST_SSH_PICKER_FAILED: &str = "HOST_SSH_PICKER_FAILED";
    pub const HOST_SSH_PICKER_DECODE_FAILED: &str = "HOST_SSH_PICKER_DECODE_FAILED";
    pub const HOST_SSH_KEY_NOT_FOUND: &str = "HOST_SSH_KEY_NOT_FOUND";
    pub const HOST_POSITION_SAVE_FAILED: &str = "HOST_POSITION_SAVE_FAILED";
    pub const HOST_POSITION_READ_FAILED: &str = "HOST_POSITION_READ_FAILED";
    pub const HOST_POSITION_RESTORE_FAILED: &str = "HOST_POSITION_RESTORE_FAILED";
    pub const HOST_FEEDBACK_UNAVAILABLE: &str = "HOST_FEEDBACK_UNAVAILABLE";
    pub const HOST_DISPLAY_MODE_SAVE_FAILED: &str = "HOST_DISPLAY_MODE_SAVE_FAILED";
    pub const HOST_DISPLAY_MODE_READ_FAILED: &str = "HOST_DISPLAY_MODE_READ_FAILED";
    pub const HOST_BACKUP_FOLDER_UNAVAILABLE: &str = "HOST_BACKUP_FOLDER_UNAVAILABLE";
    pub const HOST_BACKUP_FOLDER_FAILED: &str = "HOST_BACKUP_FOLDER_FAILED";
    pub const HOST_BACKUP_FOLDER_OPEN_FAILED: &str = "HOST_BACKUP_FOLDER_OPEN_FAILED";
    pub const HOST_STARTUP_CHECK_FAILED: &str = "HOST_STARTUP_CHECK_FAILED";

    /// Prefix reserved for host codes; a service error may not use it.
    pub const HOST_PREFIX: &str = "HOST_";

    pub const ALL: &[&str] = &[
        HOST_WINDOW_NOT_ALLOWED,
        HOST_INVALID_REQUEST,
        HOST_REQUEST_TOO_LARGE,
        HOST_WINDOW_MISSING,
        HOST_WINDOW_OPERATION_FAILED,
        HOST_STATE_LOCK_FAILED,
        HOST_TASK_FAILED,
        HOST_DATA_DIR_FAILED,
        HOST_RESOURCE_DIR_FAILED,
        HOST_SERVICE_MISSING,
        HOST_RUNTIME_MISSING,
        HOST_SERVICE_START_FAILED,
        HOST_JOB_FAILED,
        HOST_SERVICE_STOPPED,
        HOST_SERVICE_DISCONNECTED,
        HOST_SERVICE_NOT_CONNECTED,
        HOST_SERVICE_WRITE_FAILED,
        HOST_SERVICE_PIPE_STALLED,
        HOST_DUPLICATE_REQUEST,
        HOST_SERVICE_UNRESPONSIVE,
        HOST_SERVICE_ERROR_REDACTED,
        HOST_DASHBOARD_LINK_INVALID,
        HOST_BROWSER_OPEN_FAILED,
        HOST_TEXT_CATALOG_INVALID,
        HOST_INSTANCE_GUARD_FAILED,
        HOST_BUILD_FAILED,
        HOST_FATAL_PANIC,
        HOST_AUTOSTART_REGISTRY_FAILED,
        HOST_AUTOSTART_READ_FAILED,
        HOST_AUTOSTART_READ_INVALID,
        HOST_WINDIR_MISSING,
        HOST_SSH_UNAVAILABLE,
        HOST_SSH_INSTALL_DENIED,
        HOST_SSH_INSTALL_START_FAILED,
        HOST_SSH_INSTALL_CANCELLED,
        HOST_SSH_INSTALL_TIMEOUT,
        HOST_SSH_INSTALL_FAILED,
        HOST_SSH_INSTALL_BUSY,
        HOST_SSH_INSTALL_WAIT_FAILED,
        HOST_SSH_PICKER_UNAVAILABLE,
        HOST_SSH_PICKER_FAILED,
        HOST_SSH_PICKER_DECODE_FAILED,
        HOST_SSH_KEY_NOT_FOUND,
        HOST_POSITION_SAVE_FAILED,
        HOST_POSITION_READ_FAILED,
        HOST_POSITION_RESTORE_FAILED,
        HOST_FEEDBACK_UNAVAILABLE,
        HOST_DISPLAY_MODE_SAVE_FAILED,
        HOST_DISPLAY_MODE_READ_FAILED,
        HOST_BACKUP_FOLDER_UNAVAILABLE,
        HOST_BACKUP_FOLDER_FAILED,
        HOST_BACKUP_FOLDER_OPEN_FAILED,
        HOST_STARTUP_CHECK_FAILED,
    ];
}

/// The only error value the host hands to the screen: a code, plus the service's already
/// checked public text (`message`) or a numeric OS error or exit status (`status`).
/// A host error never carries a file path, URL or raw exception text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    code: Cow<'static, str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<i64>,
}

impl HostError {
    pub const fn new(code: &'static str) -> Self {
        Self {
            code: Cow::Borrowed(code),
            message: None,
            status: None,
        }
    }

    pub fn with_status(mut self, status: i64) -> Self {
        self.status = Some(status);
        self
    }

    /// Keeps only the OS error number of an I/O failure; its text may name a path.
    pub fn io(code: &'static str, error: &std::io::Error) -> Self {
        Self {
            status: error.raw_os_error().map(i64::from),
            ..Self::new(code)
        }
    }

    /// A service error that passed the protocol's safety checks.
    pub fn service(code: impl Into<String>, message: Option<String>) -> Self {
        Self {
            code: Cow::Owned(code.into()),
            message,
            status: None,
        }
    }

    #[cfg(test)]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// The bare code, for host code that cannot go through `messages.hostErrors`: the
    /// startup-error dialog, which runs before the screen exists, and the startup check
    /// (`startup.rs`), which only compares it against the quit codes and never shows it.
    pub fn code_str(&self) -> &str {
        &self.code
    }

    pub fn status(&self) -> Option<i64> {
        self.status
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(f, "{} (status {status})", self.code),
            None => f.write_str(&self.code),
        }
    }
}

impl std::error::Error for HostError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::BTreeSet;

    #[test]
    fn code_list_matches_shared_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../src/shared/native-host.json")).unwrap();
        let shared: Vec<&str> = contract["contract"]["hostErrorCodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        let shared_set: BTreeSet<&str> = shared.iter().copied().collect();
        let native_set: BTreeSet<&str> = code::ALL.iter().copied().collect();
        assert_eq!(shared_set.len(), shared.len(), "duplicate shared code");
        assert_eq!(native_set.len(), code::ALL.len(), "duplicate native code");
        assert_eq!(shared_set, native_set);
        assert!(code::ALL
            .iter()
            .all(|value| value.starts_with(code::HOST_PREFIX)
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')));
    }

    #[test]
    fn serialized_shape_omits_empty_fields() {
        assert_eq!(
            serde_json::to_value(HostError::new(code::HOST_TASK_FAILED)).unwrap(),
            json!({"code":"HOST_TASK_FAILED"})
        );
        assert_eq!(
            serde_json::to_value(HostError::new(code::HOST_SERVICE_START_FAILED).with_status(2))
                .unwrap(),
            json!({"code":"HOST_SERVICE_START_FAILED","status":2})
        );
        assert_eq!(
            serde_json::to_value(HostError::service(
                "INVALID_INPUT",
                Some("검색어를 확인해 주세요.".into())
            ))
            .unwrap(),
            json!({"code":"INVALID_INPUT","message":"검색어를 확인해 주세요."})
        );
        assert_eq!(
            HostError::new(code::HOST_JOB_FAILED)
                .with_status(5)
                .to_string(),
            "HOST_JOB_FAILED (status 5)"
        );
    }

    #[test]
    fn io_failure_keeps_only_the_os_error_number() {
        let error = std::io::Error::from_raw_os_error(3);
        let value =
            serde_json::to_value(HostError::io(code::HOST_DATA_DIR_FAILED, &error)).unwrap();
        assert_eq!(value, json!({"code":"HOST_DATA_DIR_FAILED","status":3}));
        let custom = std::io::Error::other(r"C:\Users\someone\secret\path failed");
        assert_eq!(
            serde_json::to_value(HostError::io(code::HOST_DATA_DIR_FAILED, &custom)).unwrap(),
            json!({"code":"HOST_DATA_DIR_FAILED"})
        );
    }
}
