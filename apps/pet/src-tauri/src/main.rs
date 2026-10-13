#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_visibility;
mod backup_folder;
mod bridge;
mod feedback;
mod host_error;
mod native_host;
mod overlay;
mod panel;
mod policy;
mod position;
mod startup;
mod tray;
mod vault;
mod windows;

use bridge::BridgeState;
use host_error::{code, HostError};
use position::{PositionStore, SaveOutcome};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const PANEL_MODES: &[&str] = &[
    "input",
    "question",
    "settings",
    "cleanup",
    "answer",
    "onboarding",
];

fn require_main(window: &WebviewWindow) -> Result<(), HostError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED))
    }
}

fn task_failed<E>(_: E) -> HostError {
    HostError::new(code::HOST_TASK_FAILED)
}

fn window_failed(_: tauri::Error) -> HostError {
    HostError::new(code::HOST_WINDOW_OPERATION_FAILED)
}

fn main_panel(app: &AppHandle) -> Result<WebviewWindow, HostError> {
    app.get_webview_window("main")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))
}

#[tauri::command]
async fn request(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
    payload: Value,
) -> Result<Value, HostError> {
    let (id, method, params) = policy::validate_request(window.label(), &payload)?;
    let id = id.to_owned();
    let method = method.to_owned();
    let params = params.clone();
    let bridge = state.get(&app)?;
    tauri::async_runtime::spawn_blocking(move || bridge.request(Some(id), &method, params))
        .await
        .map_err(task_failed)?
}

#[tauri::command]
fn open_panel(
    window: WebviewWindow,
    app: AppHandle,
    mode: Option<String>,
) -> Result<(), HostError> {
    if window.label() != "main" && window.label() != "pet" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let mode = mode.unwrap_or_else(|| "input".into());
    if !PANEL_MODES.contains(&mode.as_str()) {
        return Err(HostError::new(code::HOST_INVALID_REQUEST));
    }
    show_panel_mode(&app, &mode)
}

/// Shows and focuses the main window on `mode` (one of [`PANEL_MODES`]), next to the pet or the
/// tray icon when it was hidden (`panel::show`). Shared by [`open_panel`] and the tray's "설정".
pub(crate) fn show_panel_mode(app: &AppHandle, mode: &str) -> Result<(), HostError> {
    panel::show(app)?
        .emit("pet-panel", mode)
        .map_err(window_failed)
}

#[tauri::command]
fn hide_panel(window: WebviewWindow, app: AppHandle) -> Result<(), HostError> {
    require_main(&window)?;
    main_panel(&app)?.hide().map_err(window_failed)
}

/// The first-run setup's last step: keep the pet on screen (`"pet"`) or only the tray icon
/// (`"tray"`). Same effect as the tray toggle, including saving it for the next run.
#[tauri::command]
fn set_display_mode(window: WebviewWindow, app: AppHandle, mode: String) -> Result<(), HostError> {
    require_main(&window)?;
    let mode = app_visibility::DisplayMode::parse(&mode)
        .ok_or(HostError::new(code::HOST_INVALID_REQUEST))?;
    tray::apply_display_mode(&app, mode)
}

#[tauri::command]
fn get_display_mode(window: WebviewWindow, app: AppHandle) -> Result<&'static str, HostError> {
    require_main(&window)?;
    Ok(tray::current_display_mode(&app)?.as_str())
}

/// Whether the host wants the character shown. The pet page can ask while its native window is
/// still being built hidden; later changes come as `contract.petVisibilityEvent`.
#[tauri::command]
fn get_pet_visible(
    window: WebviewWindow,
    visibility: State<'_, app_visibility::PetVisibility>,
) -> Result<bool, HostError> {
    if window.label() != "pet" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    Ok(visibility.is_visible())
}

#[tauri::command]
fn set_autostart(window: WebviewWindow, enabled: bool) -> Result<bool, HostError> {
    require_main(&window)?;
    windows::set_autostart(enabled)
}

#[tauri::command]
fn get_autostart(window: WebviewWindow) -> Result<bool, HostError> {
    require_main(&window)?;
    windows::get_autostart()
}

/// The main window takes the startup check's report (`startup.rs`) before it joins the check; false
/// once the check has ended (the host showed its outcome itself, or an earlier page of this window
/// did), so a reloaded page does not show it twice.
#[tauri::command]
fn claim_startup_report(
    window: WebviewWindow,
    report: State<'_, startup::StartupReport>,
) -> Result<bool, HostError> {
    require_main(&window)?;
    Ok(report.claim_for_screen())
}

/// Whether the login Run value exists at all (see `windows::has_autostart_entry`); used by the
/// startup restore after an update (`src/ui/autostart-restore.ts`).
#[tauri::command]
fn has_autostart_entry(window: WebviewWindow) -> Result<bool, HostError> {
    require_main(&window)?;
    windows::has_autostart_entry()
}

#[tauri::command]
async fn open_dashboard(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
    memory_id: Option<i64>,
    review: Option<bool>,
    audience: Option<String>,
) -> Result<Value, HostError> {
    require_main(&window)?;
    policy::validate_dashboard_request(memory_id, audience.as_deref())?;
    let bridge = state.get(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        open_dashboard_with(&bridge, memory_id, review.unwrap_or(false), audience)
    })
    .await
    .map_err(task_failed)?
}

/// Asks the service for a dashboard link and opens it in the browser, all inside the host: the
/// link (which carries the admin credential) never reaches a webview. Blocks on the service, so
/// callers run it off the event loop. Shared by [`open_dashboard`] and the tray's "대시보드".
pub(crate) fn open_dashboard_with(
    bridge: &std::sync::Arc<bridge::Bridge>,
    memory_id: Option<i64>,
    review: bool,
    audience: Option<String>,
) -> Result<Value, HostError> {
    let result = bridge.request(
        None,
        "dashboard.link",
        json!({"memoryId":memory_id,"review":review,"audience":audience}),
    )?;
    let link = result
        .get("url")
        .or_else(|| result.get("link"))
        .and_then(Value::as_str)
        .or_else(|| result.as_str())
        .ok_or(HostError::new(code::HOST_DASHBOARD_LINK_INVALID))?;
    policy::validate_dashboard_link(link)?;
    windows::open_url(link)?;
    Ok(json!({"opened":true}))
}

/// Shows the backup folder in Explorer, creating it first when no backup has been made yet. The
/// folder is the host's own (`backup_folder::root`); the screen sends no path.
#[tauri::command]
async fn open_backup_folder(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BridgeState>,
) -> Result<(), HostError> {
    require_main(&window)?;
    let root = state
        .get(&app)?
        .backup_dir()
        .cloned()
        .ok_or(HostError::new(code::HOST_BACKUP_FOLDER_UNAVAILABLE))?;
    tauri::async_runtime::spawn_blocking(move || backup_folder::open(&root))
        .await
        .map_err(task_failed)?
}

#[tauri::command]
async fn ensure_ssh(window: WebviewWindow) -> Result<bool, HostError> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(windows::ensure_ssh)
        .await
        .map_err(task_failed)?
}

/// Stops the current `ensure_ssh` wait without closing the elevated OpenSSH installer itself
/// (an ordinary account cannot close a `runas` process it did not start as admin); the next
/// `ensure_ssh` call resumes waiting on it. Separate from the service's `operation.cancel`,
/// which cancels a request in flight to the Bun service rather than this host-only wait.
#[tauri::command]
fn cancel_ensure_ssh(window: WebviewWindow) -> Result<(), HostError> {
    require_main(&window)?;
    windows::cancel_ensure_ssh()
}

#[tauri::command]
async fn choose_key_file(window: WebviewWindow) -> Result<Option<String>, HostError> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(windows::choose_key_file)
        .await
        .map_err(task_failed)?
}

/// Owns the saver thread for the pet window's position, plus whether the last write attempt
/// failed -- so a run of failures shows the notice bubble only once and a later success clears
/// it, rather than a bubble per failed write.
#[derive(Default)]
pub struct PositionState(Mutex<Option<PositionStore>>);

fn position_path(app: &AppHandle) -> Option<PathBuf> {
    app.state::<BridgeState>()
        .get(app)
        .ok()
        .map(|bridge| bridge.data_dir().join("pet-position.json"))
}

/// Where the display mode chosen from the tray is kept (`app_visibility`).
pub(crate) fn display_path(app: &AppHandle) -> Option<PathBuf> {
    app.state::<BridgeState>()
        .get(app)
        .ok()
        .map(|bridge| bridge.data_dir().join("pet-display.json"))
}

/// Starts the saver thread for this run and stores it in [`PositionState`]; called once from
/// [`setup`]. Reporting a save outcome (the notice bubble) tracks failure runs by only alerting
/// on the failure that follows a success (or the first one), and clearing that state on success,
/// so a string of consecutive failures shows one bubble rather than one per write.
fn start_position_store(app: &AppHandle, path: PathBuf) {
    let app_for_outcome = app.clone();
    let last_failed = std::sync::atomic::AtomicBool::new(false);
    let store = PositionStore::spawn(path, move |outcome| match outcome {
        SaveOutcome::Written => {
            last_failed.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        SaveOutcome::Failed => {
            if !last_failed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                feedback::notify_host_error(
                    &app_for_outcome,
                    "host_position_save_failed",
                    code::HOST_POSITION_SAVE_FAILED,
                );
            }
        }
    });
    *app.state::<PositionState>().0.lock().unwrap() = Some(store);
}

fn save_pet_position(app: &AppHandle, position: PhysicalPosition<i32>) {
    if let Ok(guard) = app.state::<PositionState>().0.lock() {
        if let Some(store) = guard.as_ref() {
            store.moved(position::Point {
                x: position.x,
                y: position.y,
            });
        }
    }
}

/// The pet window's configured logical size (`app.config().app.windows`), scaled to physical
/// pixels -- used only when `outer_size()` itself fails, so it never needs its own literal
/// (PN-9: it previously hardcoded `PhysicalSize::new(150, 165)`).
fn configured_pet_size(app: &AppHandle, scale_factor: f64) -> Option<PhysicalSize<u32>> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "pet")
        .map(|window| {
            PhysicalSize::new(
                (window.width * scale_factor).round().max(0.0) as u32,
                (window.height * scale_factor).round().max(0.0) as u32,
            )
        })
}

fn bottom_right_position(
    origin: PhysicalPosition<i32>,
    work: PhysicalSize<u32>,
    pet: PhysicalSize<u32>,
    margin: u32,
) -> PhysicalPosition<i32> {
    let axis = |start: i32, available: u32, occupied: u32| {
        (i64::from(start) + (i64::from(available) - i64::from(occupied) - i64::from(margin)).max(0))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    };
    PhysicalPosition::new(
        axis(origin.x, work.width, pet.width),
        axis(origin.y, work.height, pet.height),
    )
}

/// Restore while the pet is still hidden; publish any notice after its display mode and tray exist.
fn restore_pet_position(app: &AppHandle) -> Option<(&'static str, &'static str)> {
    let window = app.get_webview_window("pet")?;
    // Without the display scale or a size for the pet window, neither whether a saved position
    // is on screen nor the default corner can be worked out. Guessing (scale 1.0, a 0x0 window)
    // could place the pet off screen, so the window stays where it was created and the user is
    // told why it did not move.
    let restore_failed = || {
        Some((
            "host_position_restore_failed",
            code::HOST_POSITION_RESTORE_FAILED,
        ))
    };
    let Ok(scale_factor) = window.scale_factor() else {
        return restore_failed();
    };
    let Some(pet_size) = window
        .outer_size()
        .ok()
        .or_else(|| configured_pet_size(app, scale_factor))
    else {
        return restore_failed();
    };
    let mut notice = None;
    let saved = match position_path(app).map(|path| position::read_position(&path)) {
        Some(position::RestoreResult::Found(point)) => {
            Some(PhysicalPosition::new(point.x, point.y))
        }
        Some(position::RestoreResult::NoFile) | None => None,
        Some(position::RestoreResult::Invalid) => {
            notice = Some(("host_position_read_failed", code::HOST_POSITION_READ_FAILED));
            None
        }
    };
    if let Some(position) = saved {
        let visible = window
            .available_monitors()
            .map(|monitors| {
                monitors.iter().any(|monitor| {
                    let p = monitor.position();
                    let s = monitor.size();
                    i64::from(position.x) + i64::from(pet_size.width) > i64::from(p.x)
                        && i64::from(position.y) + i64::from(pet_size.height) > i64::from(p.y)
                        && i64::from(position.x) < i64::from(p.x) + i64::from(s.width)
                        && i64::from(position.y) < i64::from(p.y) + i64::from(s.height)
                })
            })
            .unwrap_or(true);
        if visible {
            let _ = window.set_position(position);
            return notice;
        }
    }
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.available_monitors().ok()?.into_iter().next());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let margin = (24.0 * monitor.scale_factor()).round().max(0.0) as u32;
        let _ = window.set_position(bottom_right_position(
            area.position,
            area.size,
            pet_size,
            margin,
        ));
    }
    notice
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let bridge = app
        .state::<BridgeState>()
        .get(app.handle())
        .map_err(std::io::Error::other)?;
    let webview_dir = bridge.data_dir().canonicalize()?.join("webview");
    fs::create_dir_all(&webview_dir)?;
    let saved_mode = display_path(app.handle())
        .map(|path| app_visibility::read_mode(&path))
        .unwrap_or(app_visibility::ModeRead::NoFile);
    let pet_visible = saved_mode.start_mode().pet_visible();
    // A page may query while its window builder runs, before the initial visibility event.
    app.manage(app_visibility::PetVisibility::new(saved_mode.start_mode()));
    for config in app.config().app.windows.clone() {
        WebviewWindowBuilder::from_config(app.handle(), &config)?
            .data_directory(webview_dir.clone())
            .build()?;
    }
    let show_setup = !bridge.data_dir().join("pet-settings.json").is_file();
    if let Some(path) = position_path(app.handle()) {
        start_position_store(app.handle(), path);
    }
    let position_notice = restore_pet_position(app.handle());
    // The tray comes first: if it cannot be built, setup fails and the app ends with a startup
    // error, so the pet is never left hidden with no way back and nothing running unseen.
    tray::build(app, pet_visible)?;
    if let Some(pet) = app.get_webview_window("pet") {
        // Hidden too, so a tray-only start also marks the webview hidden; its page then never
        // creates the character until the pet is first shown. Not a reason to stop the app: every
        // step is tried even after one fails (`tray::set_pet_visible`), and the page asks for the
        // state itself when it loads (`get_pet_visible`), so a lost event changes nothing.
        let _ = tray::set_pet_visible(app.handle(), &pet, pet_visible);
    }
    if let Some((request_id, error_code)) = position_notice {
        feedback::notify_host_error(app.handle(), request_id, error_code);
    }
    if saved_mode == app_visibility::ModeRead::Invalid {
        feedback::notify_host_error(
            app.handle(),
            "host_display_mode_read_failed",
            code::HOST_DISPLAY_MODE_READ_FAILED,
        );
    }
    if show_setup {
        tray::show_panel(app.handle());
    }
    // The saved server is started and checked now, whether the pet is shown or only the tray, and
    // whether or not the main window's page loads; that page joins the same check.
    startup::start(app.handle());
    Ok(())
}

/// Exit status after a panic: the same one Rust itself uses when `main` panics.
const PANIC_EXIT_STATUS: i32 = 101;

/// Installs a panic hook so a panic in the GUI subsystem (where stderr has no console to show
/// on) still ends in a visible, Korean dialog instead of a silent exit. The dialog names only
/// the code, never the panic message or a source location: those may quote a path or the
/// exact input that triggered it.
///
/// Once the dialog closes, the hook ends the process, as the dialog says. Without that, a panic
/// on a background thread (a bridge reader thread, a `spawn_blocking` command task) would end
/// only that thread and leave the pet running half-broken behind a dialog that said it quit.
/// Exiting here rather than setting `panic = "abort"` in the release profile, because:
/// - the hook runs on the panicking thread before it unwinds, possibly still holding a bridge
///   lock, so it cannot go through Tauri's orderly shutdown (`AppHandle::exit` ->
///   `RunEvent::Exit` -> `BridgeState::stop`): `stop()` could wait on a lock this thread holds,
///   and when the event-loop thread itself panicked nothing would process the exit request.
///   Tauri itself ends the process with `std::process::exit` after its event loop, and the Bun
///   service with its descendants sits in a kill-on-close Job object (`windows::attach_job`),
///   so they end with this process either way;
/// - `panic = "abort"` would apply only to release builds, leaving dev builds with the same
///   untrue dialog, and ends through the abort fast-fail path, which Windows records as an
///   application crash rather than an ordinary exit.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|_info| {
        windows::startup_error(code::HOST_FATAL_PANIC, None);
        std::process::exit(PANIC_EXIT_STATUS);
    }));
}

fn startup_error(error: &HostError) {
    windows::startup_error(error.code_str(), error.status());
}

fn main() {
    install_panic_hook();
    if let Err(error) = native_host::init() {
        startup_error(&error);
        return;
    }
    let data_dir = match bridge::default_data_dir() {
        Ok(path) => path,
        Err(error) => {
            startup_error(&error);
            return;
        }
    };
    let _instance = match windows::SingleInstance::acquire(&data_dir) {
        Ok(windows::AcquireResult::Acquired(guard)) => guard,
        Ok(windows::AcquireResult::AlreadyRunning) => return,
        Err(error) => {
            startup_error(&error);
            return;
        }
    };
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    let app = tauri::Builder::default()
        .manage(BridgeState::default())
        .manage(feedback::FeedbackState::default())
        .manage(overlay::QuickState::default())
        .manage(PositionState::default())
        .manage(startup::StartupReport::default())
        .setup(setup)
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = overlay::dismiss_quick_on_blur(window.app_handle(), window.label());
            }
            if window.label() == "pet" {
                if let WindowEvent::Moved(position) = event {
                    save_pet_position(window.app_handle(), *position);
                    overlay::reposition_visible(window.app_handle());
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window.label(), "main" | "pet" | "quick" | "bubble") {
                    api.prevent_close();
                    if window.label() == "quick" {
                        let _ = overlay::dismiss_quick(window.app_handle());
                    } else if window.label() == "pet" {
                        let _ = tray::hide_pet_on_close(window.app_handle());
                    } else {
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            request,
            open_panel,
            hide_panel,
            set_autostart,
            get_autostart,
            has_autostart_entry,
            claim_startup_report,
            set_display_mode,
            get_display_mode,
            get_pet_visible,
            open_dashboard,
            open_backup_folder,
            ensure_ssh,
            cancel_ensure_ssh,
            choose_key_file,
            overlay::open_quick,
            overlay::hide_quick,
            overlay::get_quick_mode,
            feedback::publish_feedback,
            feedback::get_feedback,
            feedback::dismiss_feedback,
            feedback::open_feedback,
            feedback::get_last_answer,
            feedback::show_last_feedback
        ])
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(_) => {
            // The Tauri build error itself is never shown: it may embed a filesystem path
            // from window/plugin setup.
            startup_error(&HostError::new(code::HOST_BUILD_FAILED));
            return;
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<BridgeState>().stop();
            // Dropping the store writes a position still waiting for its quiet period and joins
            // the saver thread, so the last move before quitting is kept.
            if let Ok(mut store) = app.state::<PositionState>().0.lock() {
                store.take();
            }
        }
    });
}

#[cfg(test)]
mod position_tests {
    use super::*;
    #[test]
    fn first_position_uses_work_area_and_margin() {
        assert_eq!(
            bottom_right_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 1040),
                PhysicalSize::new(150, 165),
                24
            ),
            PhysicalPosition::new(1746, 851)
        );
        assert_eq!(
            bottom_right_position(
                PhysicalPosition::new(-1920, 0),
                PhysicalSize::new(1920, 1040),
                PhysicalSize::new(150, 165),
                24
            ),
            PhysicalPosition::new(-174, 851)
        );
        assert_eq!(
            bottom_right_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(100, 100),
                PhysicalSize::new(150, 165),
                24
            ),
            PhysicalPosition::new(0, 0)
        );
    }
}
