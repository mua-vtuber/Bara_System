#[cfg(windows)]
mod imp {
    use std::{
        ffi::{c_void, OsStr},
        os::windows::ffi::OsStrExt,
        ptr,
    };

    use crate::host_error::{code, HostError};
    type Handle = *mut c_void;
    const HKCU: Handle = 0x80000001usize as Handle;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const JOB_KILL_ON_CLOSE: u32 = 0x00002000;
    const SW_SHOWNORMAL: i32 = 1;

    #[repr(C)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "Advapi32")]
    unsafe extern "system" {
        fn RegCreateKeyExW(
            root: Handle,
            subkey: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: *const c_void,
            result: *mut Handle,
            disposition: *mut u32,
        ) -> i32;
        fn RegOpenKeyExW(
            root: Handle,
            subkey: *const u16,
            options: u32,
            access: u32,
            result: *mut Handle,
        ) -> i32;
        fn RegSetValueExW(
            key: Handle,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            len: u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Handle,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            len: *mut u32,
        ) -> i32;
        fn RegDeleteValueW(key: Handle, name: *const u16) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: u32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "Shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: Handle,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> Handle;
    }

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }
    fn run_key() -> Vec<u16> {
        wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
    }
    fn entry_name() -> Vec<u16> {
        wide("BaraPet")
    }
    /// `failure` is the caller's code: saving the setting (`HOST_AUTOSTART_REGISTRY_FAILED`) and
    /// reading it (`HOST_AUTOSTART_READ_FAILED`) fail with different codes, so the screen never says
    /// "could not save" for a failed read.
    fn current_command(failure: &'static str) -> Result<String, HostError> {
        let exe = std::env::current_exe().map_err(|e| HostError::io(failure, &e))?;
        Ok(format!("\"{}\"", exe.display()))
    }

    fn write_failed(status: i32) -> HostError {
        HostError::new(code::HOST_AUTOSTART_REGISTRY_FAILED).with_status(i64::from(status))
    }

    fn read_failed(status: i32) -> HostError {
        HostError::new(code::HOST_AUTOSTART_READ_FAILED).with_status(i64::from(status))
    }

    pub fn set_autostart(enabled: bool) -> Result<bool, HostError> {
        let command = if enabled {
            Some(current_command(code::HOST_AUTOSTART_REGISTRY_FAILED)?)
        } else {
            None
        };
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKCU,
                run_key().as_ptr(),
                0,
                ptr::null_mut(),
                0,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                ptr::null(),
                &mut key,
                ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(write_failed(status));
        }
        let status = if enabled {
            let value = wide(command.as_deref().unwrap_or_default());
            unsafe {
                RegSetValueExW(
                    key,
                    entry_name().as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            }
        } else {
            unsafe { RegDeleteValueW(key, entry_name().as_ptr()) }
        };
        unsafe {
            RegCloseKey(key);
        }
        if status != 0 && (status != 2 || enabled) {
            return Err(write_failed(status));
        }
        Ok(enabled)
    }

    pub fn get_autostart() -> Result<bool, HostError> {
        let mut key = ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(HKCU, run_key().as_ptr(), 0, KEY_QUERY_VALUE, &mut key) };
        if status == 2 {
            return Ok(false);
        }
        if status != 0 {
            return Err(read_failed(status));
        }
        let mut len = 0u32;
        let mut kind = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                key,
                entry_name().as_ptr(),
                ptr::null_mut(),
                &mut kind,
                ptr::null_mut(),
                &mut len,
            )
        };
        if status == 2 {
            unsafe {
                RegCloseKey(key);
            }
            return Ok(false);
        }
        if status != 0 {
            unsafe {
                RegCloseKey(key);
            }
            return Err(read_failed(status));
        }
        if kind != REG_SZ || len == 0 || len > 32768 || !len.is_multiple_of(2) {
            unsafe {
                RegCloseKey(key);
            }
            return Err(HostError::new(code::HOST_AUTOSTART_READ_INVALID));
        }
        let mut data = vec![0u16; len as usize / 2];
        let status = unsafe {
            RegQueryValueExW(
                key,
                entry_name().as_ptr(),
                ptr::null_mut(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut len,
            )
        };
        unsafe {
            RegCloseKey(key);
        }
        if status != 0 {
            return Err(read_failed(status));
        }
        if kind != REG_SZ || !len.is_multiple_of(2) {
            return Err(HostError::new(code::HOST_AUTOSTART_READ_INVALID));
        }
        let value = String::from_utf16_lossy(&data)
            .trim_end_matches('\0')
            .to_string();
        Ok(value == current_command(code::HOST_AUTOSTART_READ_FAILED)?)
    }

    const ERROR_FILE_NOT_FOUND: i32 = 2;

    /// What a registry call's status says about the `BaraPet` Run value: there (`0`), missing
    /// (`ERROR_FILE_NOT_FOUND`, for the value or for the Run key itself), or unknown (any other
    /// status is a failed read, never taken as missing).
    fn entry_presence(status: i32) -> Result<bool, HostError> {
        match status {
            0 => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            _ => Err(read_failed(status)),
        }
    }

    /// Whether the `BaraPet` Run value exists at all, whatever it holds. Unlike [`get_autostart`]
    /// (true only for a value that starts this very executable), a value pointing elsewhere still
    /// counts: the startup restore after an update re-registers only a value the previous
    /// version's uninstaller deleted, and never rewrites one that is there.
    pub fn has_autostart_entry() -> Result<bool, HostError> {
        let mut key = ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(HKCU, run_key().as_ptr(), 0, KEY_QUERY_VALUE, &mut key) };
        if status != 0 {
            return entry_presence(status);
        }
        let status = unsafe {
            RegQueryValueExW(
                key,
                entry_name().as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        unsafe {
            RegCloseKey(key);
        }
        entry_presence(status)
    }

    pub struct Job(Handle);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub fn attach_job(pid: u32) -> Result<Job, HostError> {
        let job_failed = |error: &std::io::Error| HostError::io(code::HOST_JOB_FAILED, error);
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(job_failed(&std::io::Error::last_os_error()));
        }
        let mut limits: ExtendedLimit = unsafe { std::mem::zeroed() };
        limits.basic.limit_flags = JOB_KILL_ON_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job,
                9,
                (&limits as *const ExtendedLimit).cast(),
                std::mem::size_of::<ExtendedLimit>() as u32,
            )
        };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(job_failed(&error));
        }
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(job_failed(&error));
        }
        let ok = unsafe { AssignProcessToJobObject(job, process) };
        unsafe {
            CloseHandle(process);
        }
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(job_failed(&error));
        }
        Ok(Job(job))
    }

    pub fn open_url(url: &str) -> Result<(), HostError> {
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                wide("open").as_ptr(),
                wide(url).as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if result <= 32 {
            Err(HostError::new(code::HOST_BROWSER_OPEN_FAILED).with_status(result as i64))
        } else {
            Ok(())
        }
    }

    pub fn hide_process(command: &mut std::process::Command) {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// Test-only: waits up to `timeout` for process `pid` to end. `Ok(true)` once it has ended,
    /// also when no process with that id exists any more; `Ok(false)` if it is still running.
    #[cfg(test)]
    pub fn wait_process_exit(pid: u32, timeout: std::time::Duration) -> std::io::Result<bool> {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_OBJECT_0: u32 = 0;
        const WAIT_TIMEOUT: u32 = 0x0000_0102;
        const ERROR_INVALID_PARAMETER: i32 = 87;
        /// `INFINITE` is `u32::MAX`; a finite wait stays below it.
        const LONGEST_FINITE_WAIT_MS: u32 = u32::MAX - 1;
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        }
        let process = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(ERROR_INVALID_PARAMETER) => Ok(true),
                _ => Err(error),
            };
        }
        let millis = u32::try_from(timeout.as_millis())
            .unwrap_or(LONGEST_FINITE_WAIT_MS)
            .min(LONGEST_FINITE_WAIT_MS);
        let status = unsafe { WaitForSingleObject(process, millis) };
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(process);
        }
        match status {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(error),
        }
    }

    #[cfg(test)]
    mod autostart_tests {
        use super::*;
        use serde_json::json;

        // A failed read must not reuse the save failure's code: the screen would say
        // "could not save" when the setting was only being read.
        #[test]
        fn read_and_write_failures_carry_different_codes() {
            let value = |error: HostError| serde_json::to_value(error).unwrap();
            assert_eq!(
                value(read_failed(5)),
                json!({"code":"HOST_AUTOSTART_READ_FAILED","status":5})
            );
            assert_eq!(
                value(write_failed(5)),
                json!({"code":"HOST_AUTOSTART_REGISTRY_FAILED","status":5})
            );
        }

        // The startup restore writes the Run value only when it is missing, so a failed read
        // (here access denied) must stay an error and never read as "missing".
        #[test]
        fn only_not_found_reads_as_a_missing_entry() {
            assert!(entry_presence(0).unwrap());
            assert!(!entry_presence(ERROR_FILE_NOT_FOUND).unwrap());
            assert_eq!(
                serde_json::to_value(entry_presence(5).unwrap_err()).unwrap(),
                json!({"code":"HOST_AUTOSTART_READ_FAILED","status":5})
            );
        }
    }
}

#[cfg(windows)]
mod single_instance;
#[cfg(windows)]
mod ssh;
#[cfg(windows)]
pub use imp::*;
#[cfg(windows)]
pub use single_instance::{startup_error, AcquireResult, SingleInstance};
#[cfg(windows)]
pub use ssh::{cancel_ensure_ssh, choose_key_file, ensure_ssh};

#[cfg(not(windows))]
pub struct Job;
#[cfg(not(windows))]
pub fn attach_job(_: u32) -> Result<Job, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_JOB_FAILED,
    ))
}
#[cfg(not(windows))]
pub fn set_autostart(_: bool) -> Result<bool, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_AUTOSTART_REGISTRY_FAILED,
    ))
}
#[cfg(not(windows))]
pub fn get_autostart() -> Result<bool, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_AUTOSTART_READ_FAILED,
    ))
}
#[cfg(not(windows))]
pub fn has_autostart_entry() -> Result<bool, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_AUTOSTART_READ_FAILED,
    ))
}
#[cfg(not(windows))]
pub fn open_url(_: &str) -> Result<(), crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_BROWSER_OPEN_FAILED,
    ))
}
#[cfg(not(windows))]
pub fn ensure_ssh() -> Result<bool, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_SSH_UNAVAILABLE,
    ))
}
#[cfg(not(windows))]
pub fn cancel_ensure_ssh() -> Result<(), crate::host_error::HostError> {
    Ok(())
}
#[cfg(not(windows))]
pub fn choose_key_file() -> Result<Option<String>, crate::host_error::HostError> {
    Err(crate::host_error::HostError::new(
        crate::host_error::code::HOST_SSH_PICKER_UNAVAILABLE,
    ))
}
#[cfg(not(windows))]
pub fn hide_process(_: &mut std::process::Command) {}
#[cfg(not(windows))]
pub struct SingleInstance;
#[cfg(not(windows))]
pub enum AcquireResult {
    Acquired(SingleInstance),
    AlreadyRunning,
}
#[cfg(not(windows))]
impl SingleInstance {
    pub fn acquire(_: &std::path::Path) -> Result<AcquireResult, crate::host_error::HostError> {
        Ok(AcquireResult::Acquired(SingleInstance))
    }
}
#[cfg(not(windows))]
pub fn startup_error(_: &str, _: Option<i64>) {}
