use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Default)]
struct ServerState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct ServerStatus {
    running: bool,
    pid: Option<u32>,
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn settings_path() -> PathBuf {
    std::env::var_os("MEMORY_SETTINGS_PATH")
        .map(|path| memory_dir().join(path))
        .unwrap_or_else(|| {
            local_app_data()
                .join("Bara")
                .join("memory")
                .join("memory-settings.json")
        })
}

fn apply_runtime_env(command: &mut Command) {
    command.env("MEMORY_SETTINGS_PATH", settings_path());
    // The native host starts the core directly: keep its wall clock aligned
    // with the TypeScript launch helper before Date-based schedulers initialize.
    let timezone = std::env::var("TZ")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(settings_path())
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|settings| {
                    settings
                        .pointer("/time/zone")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned)
                })
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "Asia/Seoul".to_string());
    command.env("TZ", timezone.trim());
    // Inherited explicit BARA_ASSET_DIR/BARA_SECRETS_PATH remain authoritative.
    // Otherwise the TS setup and core resolve assets from settings and secrets beside it.
    for (key, fallback) in [
        ("BARA_HF_CACHE_DIR", hf_cache_dir()),
        ("BARA_KIWI_MODEL_DIR", kiwi_model_dir()),
        (
            "SSE_TOKEN_PATH",
            local_app_data().join("Bara/memory/data/sse-tokens.json"),
        ),
    ] {
        command.env(
            key,
            std::env::var_os(key).map(PathBuf::from).unwrap_or(fallback),
        );
    }
}

fn hf_cache_dir() -> PathBuf {
    local_app_data()
        .join("Bara")
        .join("memory")
        .join("models")
        .join("hf-cache")
}

fn kiwi_model_dir() -> PathBuf {
    local_app_data()
        .join("Bara")
        .join("memory")
        .join("models")
        .join("kiwi-model")
}

fn app_dir_from_env_or_siblings(env_key: &str, app_name: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env_key).map(PathBuf::from) {
        return path;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in [
        cwd.join("apps").join(app_name),
        cwd.join("..").join(app_name),
        cwd.join("..").join("..").join(app_name),
        cwd.join(app_name),
    ] {
        if candidate.join("package.json").exists() {
            return candidate.canonicalize().unwrap_or(candidate);
        }
    }
    cwd.join("..").join(app_name)
}

fn memory_dir() -> PathBuf {
    app_dir_from_env_or_siblings("BARA_MEMORY_DIR", "memory")
}

fn setup_dir() -> PathBuf {
    app_dir_from_env_or_siblings("BARA_SETUP_DIR", "setup")
}

fn apply_hidden(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn spawn_memory_server() -> Result<Child, String> {
    if setup_needed() {
        return Err("초기 준비가 끝나지 않았습니다. 준비 버튼으로 다시 실행하세요.".to_string());
    }
    let bun = std::env::var_os("BARA_BUN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bun"));
    let memory_dir = memory_dir();
    let mut command = Command::new(bun);
    command
        .arg("run")
        .arg("src/index.ts")
        .current_dir(&memory_dir);
    apply_runtime_env(&mut command);
    apply_hidden(&mut command);
    command
        .spawn()
        .map_err(|err| format!("memory server 시작 실패: {err}"))
}

fn run_setup_profile(profile: &str, app: &AppHandle) -> Result<(), String> {
    // WP-B2-06R — "keep" sends no --ollama/--lmstudio/--no-ai flag at all, so
    // askAiSelection falls into the bare-`--yes` branch and returns a selection
    // with no `explicit` field. writeSettingsAndMigrateDb then preserves the
    // llm slot the user already has configured instead of applying a default.
    let profile_flag: Option<&str> = match profile {
        "keep" => None,
        "ollama" => Some("--ollama"),
        "lmstudio" => Some("--lmstudio"),
        "none" => Some("--no-ai"),
        _ => return Err(format!("알 수 없는 setup profile: {profile}")),
    };
    let bun = std::env::var_os("BARA_BUN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bun"));
    let mut command = Command::new(bun);
    command.arg("run").arg("src/index.ts").arg("--desktop");
    if let Some(flag) = profile_flag {
        command.arg(flag);
    }
    command
        .arg("--yes")
        .arg("--json-events")
        .current_dir(setup_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_runtime_env(&mut command);
    apply_hidden(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("setup 실행 실패: {err}"))?;
    let mut step = "settings-and-database".to_string();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // Only forward known structured progress. Never forward arbitrary child logs or links.
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if event["type"] == "setup.progress" {
                    if let Some(label) = event["step"].as_str() {
                        step = label.to_string();
                        let _ = app.emit("launcher-progress", format!("준비 중: {step}"));
                    }
                }
            }
        }
    }
    let status = child
        .wait()
        .map_err(|err| format!("setup 상태 확인 실패: {err}"))?;
    if status.success() && !setup_needed() {
        return Ok(());
    }
    Err(format!(
        "준비 실패: {step} (exit {}). 네트워크·모델 저장 공간을 확인하고 같은 준비 버튼으로 재시도하세요. 자세한 오류는 저장소에서 bun run setup -- --desktop 명령으로 확인할 수 있습니다.",
        status.code().unwrap_or(-1)
    ))
}

fn ensure_server(state: &State<ServerState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "server lock poisoned")?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(());
        }
    }
    *guard = Some(spawn_memory_server()?);
    Ok(())
}

fn stop_child(state: &State<ServerState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "server lock poisoned")?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn dashboard_url(state: &State<ServerState>) -> Result<String, String> {
    let mut command = Command::new(std::env::var_os("BARA_BUN").unwrap_or_else(|| "bun".into()));
    command
        .arg("run")
        .arg(setup_dir().join("src/launch.ts"))
        .args(["--desktop", "--link"])
        .current_dir(memory_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_runtime_env(&mut command);
    apply_hidden(&mut command);
    let mut helper = command
        .spawn()
        .map_err(|_| "대시보드 연결 도구 실행 실패. Bun 경로를 확인하세요.")?;
    loop {
        if helper
            .try_wait()
            .map_err(|_| "연결 도구 상태 확인 실패")?
            .is_some()
        {
            break;
        }
        let stopped = {
            let mut guard = state.child.lock().map_err(|_| "server lock poisoned")?;
            match guard.as_mut() {
                Some(child) => child
                    .try_wait()
                    .map_err(|_| "서버 상태 확인 실패")?
                    .is_some(),
                None => true,
            }
        };
        if stopped {
            let _ = helper.kill();
            let _ = helper.wait();
            return Err("서버가 준비 전에 종료됐습니다. 설정·사용 중인 포트와 모델 파일을 확인하고 재시작하세요.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let output = helper
        .wait_with_output()
        .map_err(|_| "연결 도구 응답 확인 실패")?;
    if !output.status.success() {
        return Err("서버 준비를 확인하지 못했습니다. 서버 오류·포트·토큰 파일 경로를 확인한 뒤 다시 열어 주세요.".into());
    }
    let link = String::from_utf8(output.stdout).map_err(|_| "대시보드 연결 응답 오류")?;
    let link = link.trim();
    if !link.starts_with("http://") || !link.contains("#bara-token=") || link.contains('\n') {
        return Err("대시보드 인증 링크를 만들지 못했습니다.".into());
    }
    Ok(link.to_string())
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Start-Process -FilePath ([Console]::In.ReadToEnd().Trim())",
        ]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_hidden(&mut command);
        let mut child = command.spawn().map_err(|_| "브라우저 실행 실패")?;
        child
            .stdin
            .take()
            .ok_or("브라우저 입력 연결 실패")?
            .write_all(url.as_bytes())
            .map_err(|_| "브라우저 링크 전달 실패")?;
        return if child
            .wait()
            .map_err(|_| "브라우저 상태 확인 실패")?
            .success()
        {
            Ok(())
        } else {
            Err("브라우저를 열지 못했습니다. 다시 시도하세요.".into())
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|err| err.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn start_server(state: State<ServerState>) -> Result<(), String> {
    ensure_server(&state)
}

#[tauri::command]
fn setup_needed() -> bool {
    let path = settings_path();
    if !path.exists() {
        return true;
    }
    let marker = path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("setup-state.json");
    std::fs::read_to_string(marker)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map(|state| state["status"] != "complete" || !state["completedAt"].is_string())
        .unwrap_or(true)
}

// WP-B2-06R — the "keep current AI settings" button on the setup screen must
// only show when a previous settings file actually exists to keep. This is a
// plain existence check (no parsing), separate from setup_needed's marker
// check, since a settings file can exist even while setup_needed() is true
// (that is exactly the retry case this WP addresses).
#[tauri::command]
fn settings_file_exists() -> bool {
    settings_path().exists()
}

#[tauri::command]
async fn run_setup(profile: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_setup_profile(&profile, &app))
        .await
        .map_err(|_| "준비 작업 실행 실패")?
}

#[tauri::command]
fn stop_server(state: State<ServerState>) -> Result<(), String> {
    stop_child(&state)
}

#[tauri::command]
fn restart_server(state: State<ServerState>) -> Result<(), String> {
    stop_child(&state)?;
    ensure_server(&state)
}

#[tauri::command]
fn server_status(state: State<ServerState>) -> Result<ServerStatus, String> {
    let mut guard = state.child.lock().map_err(|_| "server lock poisoned")?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(ServerStatus {
                running: true,
                pid: Some(child.id()),
            });
        }
    }
    Ok(ServerStatus {
        running: false,
        pid: None,
    })
}

#[tauri::command]
async fn open_dashboard(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_server(&app.state::<ServerState>())?;
        let _ = app.emit(
            "launcher-progress",
            "서버와 모델을 준비하는 중입니다. 준비가 끝나면 브라우저가 열립니다.",
        );
        open_url(&dashboard_url(&app.state::<ServerState>())?)?;
        let _ = app.emit("launcher-progress", "인증된 대시보드를 열었습니다.");
        Ok(())
    })
    .await
    .map_err(|_| "대시보드 열기 작업 실패")?
}

fn open_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_dashboard(app.clone()).await {
            let _ = app.emit("launcher-error", error);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}

fn handle_menu(app: &AppHandle, id: &str) {
    let state = app.state::<ServerState>();
    match id {
        "open_dashboard" => {
            open_from_tray(app);
        }
        "restart_server" => {
            let _ = stop_child(&state).and_then(|_| ensure_server(&state));
        }
        "stop_server" => {
            let _ = stop_child(&state);
        }
        "quit" => {
            let _ = stop_child(&state);
            app.exit(0);
        }
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .setup(|app| {
            let open =
                MenuItem::with_id(app, "open_dashboard", "대시보드 열기", true, None::<&str>)?;
            let restart =
                MenuItem::with_id(app, "restart_server", "서버 재시작", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop_server", "서버 종료", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "앱 종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &stop, &quit])?;
            let app_handle = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    handle_menu(app, event.id().as_ref());
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        open_from_tray(&app_handle);
                    }
                })
                .build(app)?;

            let state = app.state::<ServerState>();
            if !setup_needed() {
                let _ = ensure_server(&state);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            setup_needed,
            settings_file_exists,
            run_setup,
            stop_server,
            restart_server,
            server_status,
            open_dashboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bara launcher");
}

fn main() {
    run();
}
