use std::{ffi::c_void, fs, os::windows::ffi::OsStrExt, path::Path, ptr};

use crate::{
    host_error::{code, HostError},
    native_host,
};

type Handle = *mut c_void;
const ERROR_ALREADY_EXISTS: i32 = 183;

#[link(name = "Kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
}
#[link(name = "User32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: Handle, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

fn mutex_name(path: &Path) -> Result<String, HostError> {
    fs::create_dir_all(path).map_err(|e| HostError::io(code::HOST_DATA_DIR_FAILED, &e))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| HostError::io(code::HOST_DATA_DIR_FAILED, &e))?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in canonical.to_string_lossy().to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(format!("Global\\BaraPet-{hash:016x}"))
}

pub enum AcquireResult {
    Acquired(SingleInstance),
    AlreadyRunning,
}
pub struct SingleInstance(Handle);
impl SingleInstance {
    pub fn acquire(path: &Path) -> Result<AcquireResult, HostError> {
        let name = wide(&mutex_name(path)?);
        let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(HostError::io(
                code::HOST_INSTANCE_GUARD_FAILED,
                &std::io::Error::last_os_error(),
            ));
        }
        let error = std::io::Error::last_os_error().raw_os_error();
        if error == Some(ERROR_ALREADY_EXISTS) {
            unsafe {
                CloseHandle(handle);
            }
            return Ok(AcquireResult::AlreadyRunning);
        }
        Ok(AcquireResult::Acquired(Self(handle)))
    }
}
impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Shows the startup-failure dialog for a host error code, before the screen exists to show
/// anything itself. The caption is the product title and the body is the code's Korean text
/// (`native_host::startup_text`) plus the OS error number when the error carries one; never
/// the raw error value, which may quote a path.
pub fn startup_error(error_code: &str, status: Option<i64>) {
    let mut body = native_host::startup_text(error_code).to_string();
    if let Some(status) = status {
        native_host::append_status(&mut body, status);
    }
    let message = wide(&body);
    let title = wide(native_host::product_title());
    unsafe {
        MessageBoxW(ptr::null_mut(), message.as_ptr(), title.as_ptr(), 0x10);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guard_is_scoped_to_data_dir_and_released() {
        let root = std::env::temp_dir().join(format!(
            "bara-pet-instance-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let a = root.join("a");
        let b = root.join("b");
        let guard = match SingleInstance::acquire(&a).unwrap() {
            AcquireResult::Acquired(value) => value,
            AcquireResult::AlreadyRunning => panic!("first acquire failed"),
        };
        assert!(matches!(
            SingleInstance::acquire(&a).unwrap(),
            AcquireResult::AlreadyRunning
        ));
        assert!(matches!(
            SingleInstance::acquire(&b).unwrap(),
            AcquireResult::Acquired(_)
        ));
        drop(guard);
        assert!(matches!(
            SingleInstance::acquire(&a).unwrap(),
            AcquireResult::Acquired(_)
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
