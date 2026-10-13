use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

const KEYS: &[&str] = &[
    "memory.token",
    "memory.ownerToken",
    "ai.apiKey",
    "enrollment.pickupSecret",
];

pub struct Vault {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn check_key(key: &str) -> Result<(), String> {
        if KEYS.contains(&key) {
            Ok(())
        } else {
            Err("Vault key is not allowed".into())
        }
    }

    fn read(&self) -> Result<BTreeMap<String, String>, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Vault file is corrupt".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("Vault read failed: {e}")),
        }
    }

    fn write(&self, entries: &BTreeMap<String, String>) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Invalid vault path")?;
        fs::create_dir_all(parent).map_err(|e| format!("Vault directory failed: {e}"))?;
        let tmp = self.path.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let bytes = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|e| format!("Vault temp file failed: {e}"))?;
            file.write_all(&bytes)
                .map_err(|e| format!("Vault write failed: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("Vault sync failed: {e}"))?;
            drop(file);
            replace_file(&tmp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        Self::check_key(key)?;
        let _guard = self.lock.lock().map_err(|_| "Vault lock failed")?;
        self.read()?
            .get(key)
            .map(|hex| {
                let ciphertext = from_hex(hex)?;
                let bytes = unprotect(&ciphertext)?;
                String::from_utf8(bytes).map_err(|_| "Vault value is corrupt".into())
            })
            .transpose()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        Self::check_key(key)?;
        if value.len() > 64 * 1024 {
            return Err("Vault value is too large".into());
        }
        let _guard = self.lock.lock().map_err(|_| "Vault lock failed")?;
        let mut entries = self.read()?;
        entries.insert(key.into(), to_hex(&protect(value.as_bytes())?));
        self.write(&entries)
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        Self::check_key(key)?;
        let _guard = self.lock.lock().map_err(|_| "Vault lock failed")?;
        let mut entries = self.read()?;
        entries.remove(key);
        self.write(&entries)
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 15) as usize] as char);
    }
    out
}

fn from_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("Vault ciphertext is corrupt".into());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let digit = |b: u8| {
            (b as char)
                .to_digit(16)
                .ok_or("Vault ciphertext is corrupt")
        };
        bytes.push(((digit(pair[0])? << 4) | digit(pair[1])?) as u8);
    }
    Ok(bytes)
}

#[cfg(windows)]
mod win {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path};

    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(pointer: *mut c_void) -> *mut c_void;
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    const ENTROPY: &[u8] = b"BaraPet-v1-vault";
    const UI_FORBIDDEN: u32 = 0x1;

    pub fn crypt(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let mut data = input.to_vec();
        let mut salt = ENTROPY.to_vec();
        let input_blob = Blob {
            len: data.len() as u32,
            data: data.as_mut_ptr(),
        };
        let entropy_blob = Blob {
            len: salt.len() as u32,
            data: salt.as_mut_ptr(),
        };
        let mut output = Blob {
            len: 0,
            data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            if encrypt {
                CryptProtectData(
                    &input_blob,
                    std::ptr::null(),
                    &entropy_blob,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input_blob,
                    std::ptr::null_mut(),
                    &entropy_blob,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err(format!("DPAPI failed: {}", std::io::Error::last_os_error()));
        }
        let result =
            unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
        unsafe {
            LocalFree(output.data.cast());
        }
        Ok(result)
    }

    pub fn replace(from: &Path, to: &Path) -> Result<(), String> {
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), 0x1 | 0x8) } == 0 {
            return Err(format!(
                "Vault replace failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    win::crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    win::crypt(bytes, false)
}
#[cfg(windows)]
fn replace_file(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    win::replace(from, to)
}

#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI requires Windows".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI requires Windows".into())
}
#[cfg(not(windows))]
fn replace_file(_: &std::path::Path, _: &std::path::Path) -> Result<(), String> {
    Err("DPAPI requires Windows".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_corruption() {
        let path = std::env::temp_dir().join(format!(
            "bara-pet-vault-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let vault = Vault::new(path.clone());
        assert_eq!(vault.get("memory.token").unwrap(), None);
        vault.set("memory.token", "secret-value").unwrap();
        assert_eq!(
            vault.get("memory.token").unwrap(),
            Some("secret-value".into())
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("secret-value"));
        assert!(vault.set("unknown", "x").is_err());
        fs::write(&path, r#"{"memory.token":"00"}"#).unwrap();
        assert!(vault.get("memory.token").is_err());
        vault.delete("memory.token").unwrap();
        let _ = fs::remove_file(path);
    }

    #[test]
    fn failed_replace_removes_temp_ciphertext() {
        let directory = std::env::temp_dir().join(format!(
            "bara-pet-vault-error-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(directory.join("vault.json")).unwrap();
        let vault = Vault::new(directory.join("vault.json"));
        assert!(vault.write(&BTreeMap::new()).is_err());
        let names = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
