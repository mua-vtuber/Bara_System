//! Tray icon and its menu. Split out of `main.rs` to keep that file's setup path short; the
//! menu labels come from `native_host::tray_labels()` (`src/shared/native-host.json`
//! `text.tray`), never a literal here.
//!
//! Left and right click both open the menu and nothing else, so a click never also pops up a
//! window. A failed command is sent to the `main` window (`contract.trayErrorEvent`), which shows
//! its text in a bubble; the host itself has no text for most host or service errors.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Wry,
};

use crate::app_visibility::{self, DisplayMode, PetVisibility};
use crate::host_error::{code, HostError};
use crate::{feedback, native_host, overlay};

/// The menu items that change after the menu is built, and where the tray icon was when the user
/// last clicked it. Managed once the tray exists, so it is absent if building the tray failed.
pub struct TrayMenu {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    clicked: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
}

/// The tray icon's rectangle as of the user's last click on it, which is when a tray command
/// starts. Read when the menu runs, so no global mouse watcher is needed.
pub fn clicked_rect(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    *app.try_state::<TrayMenu>()?.clicked.lock().ok()?
}

/// Marks the tray status line when a background result is waiting in "최근 결과" (`true`), and
/// clears it once the user opened it (`false`).
pub fn set_attention(app: &AppHandle, attention: bool) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let labels = native_host::tray_labels();
        let _ = menu.status.set_text(if attention {
            labels.status_attention
        } else {
            labels.status
        });
    }
}

/// One tray menu command. The menu item id is [`TrayAction::id`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    Input,
    Search,
    Dashboard,
    Settings,
    RecentResult,
    TogglePet,
    Quit,
}

impl TrayAction {
    pub const ALL: [TrayAction; 7] = [
        TrayAction::Input,
        TrayAction::Search,
        TrayAction::Dashboard,
        TrayAction::Settings,
        TrayAction::RecentResult,
        TrayAction::TogglePet,
        TrayAction::Quit,
    ];

    pub fn id(self) -> &'static str {
        match self {
            TrayAction::Input => "input",
            TrayAction::Search => "search",
            TrayAction::Dashboard => "dashboard",
            TrayAction::Settings => "settings",
            TrayAction::RecentResult => "recent-result",
            TrayAction::TogglePet => "toggle-pet",
            TrayAction::Quit => "quit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }
}

/// The opener name [`overlay::quick_action`] sees for a tray command: never a toggle.
const TRAY_OPENER: &str = "tray";

/// Brings up the main panel for the first-run setup at startup, next to the pet (`panel::show`).
pub fn show_panel(app: &AppHandle) {
    let _ = crate::panel::show(app);
}

/// Set once "바라 종료" starts; later tray commands are ignored while the quit runs.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Whether "바라 종료" has started, so work that ends because of it reports nothing.
pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Quits gracefully: the service stops taking new work, running work gets up to
/// `contract.serviceDrainMs` to finish (a save the server confirms in that time reaches the screen
/// as saved), what is left is cancelled with its draft and request id kept for the next start, and
/// only then are the owned processes ended. The tray stays, marked as quitting, until the end; the
/// host's own wait is bounded too, so a stuck service cannot keep the app alive.
pub fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu
            .status
            .set_text(native_host::tray_labels().status_quitting);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        drain_service(&app);
        app.state::<crate::bridge::BridgeState>().stop();
        app.exit(0);
    });
}

/// Asks a running service to drain and waits for its answer, at most the drain limit plus a
/// margin for closing what it started. Any failure only means the processes are ended without it.
fn drain_service(app: &AppHandle) {
    let Some(bridge) = app.state::<crate::bridge::BridgeState>().running() else {
        return;
    };
    let limit = native_host::service_drain();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let timeout = u64::try_from(limit.as_millis()).unwrap_or(u64::MAX);
        let _ = sender.send(bridge.request(
            None,
            "service.drain",
            serde_json::json!({ "timeoutMs": timeout }),
        ));
    });
    let _ = receiver.recv_timeout(limit + DRAIN_CLOSE_MARGIN);
}

/// Time on top of the drain limit for cancelled work to answer and for the service to close the
/// local server and tunnel it started.
const DRAIN_CLOSE_MARGIN: std::time::Duration = std::time::Duration::from_secs(5);

/// Hands a failed tray command to the `main` window, which turns the code into text. If even
/// that fails there is nothing left to show it with.
fn report(app: &AppHandle, error: HostError) {
    let _ = app.emit_to("main", native_host::tray_error_event(), error);
}

fn window_failed(_: tauri::Error) -> HostError {
    HostError::new(code::HOST_WINDOW_OPERATION_FAILED)
}

/// Shows or hides the pet, saves the choice for the next run and names the tray's toggle after it.
/// Hiding only hides the character: the quick input, its draft and the memory server stay. An open
/// quick input or bubble moves to the new anchor. Used by the tray toggle and by the first-run
/// setup's last step (`set_display_mode`).
pub fn apply_display_mode(app: &AppHandle, mode: DisplayMode) -> Result<(), HostError> {
    let pet = app
        .get_webview_window("pet")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    set_pet_visible(app, &pet, mode.pet_visible())?;
    overlay::reposition_visible(app);
    let saved = crate::display_path(app)
        .is_some_and(|path| app_visibility::write_mode(&path, mode).is_ok());
    if !saved {
        // The switch itself worked; only the next run may start the other way. The user just
        // asked for it, so the notice pops up even with the pet hidden.
        feedback::notify_user_host_error(
            app,
            "host_display_mode_save_failed",
            code::HOST_DISPLAY_MODE_SAVE_FAILED,
        );
    }
    name_toggle(app, mode.pet_visible())
}

/// Closing the pet window (Alt+F4) hides it for this run only, as before, without saving a
/// display mode; the character stops drawing like any other hide, and the tray's toggle offers
/// to show it again.
pub fn hide_pet_on_close(app: &AppHandle) -> Result<(), HostError> {
    let pet = app
        .get_webview_window("pet")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    set_pet_visible(app, &pet, false)?;
    overlay::reposition_visible(app);
    name_toggle(app, false)
}

fn name_toggle(app: &AppHandle, pet_visible: bool) -> Result<(), HostError> {
    match app.try_state::<TrayMenu>() {
        Some(menu) => menu
            .toggle
            .set_text(toggle_label(pet_visible))
            .map_err(window_failed),
        None => Ok(()),
    }
}

/// Shows or hides the pet window and tells its page, so the character stops drawing while hidden
/// and is drawn again from where it stopped (design 1C). Every show and hide of the pet goes
/// through here.
///
/// Hiding a Tauri window does not hide its WebView2 to the page: `document.visibilityState`
/// stays "visible" and animation frames may keep running. So the host also hides the webview
/// itself (WebView2 `IsVisible`, which lets it stop rendering) and sends the pet window
/// `contract.petVisibilityEvent`, which the page treats as the authority; the page asks for the
/// current state when it loads (`get_pet_visible`). The webview is shown before the window, and
/// hidden after it, so the window never shows an empty webview.
///
/// Every step is tried even when one before it fails, and the first failure is returned: the window
/// itself always ends up shown or hidden as asked (the tray toggle and the setup report the failure;
/// the app's start goes on regardless).
pub fn set_pet_visible(
    app: &AppHandle,
    pet: &tauri::WebviewWindow,
    visible: bool,
) -> Result<(), HostError> {
    let webview: &tauri::Webview = pet.as_ref();
    apply_visibility(&app.state::<PetVisibility>(), visible, |step| {
        match step {
            VisibilityStep::Webview if visible => webview.show(),
            VisibilityStep::Webview => webview.hide(),
            VisibilityStep::Window if visible => pet.show(),
            VisibilityStep::Window => pet.hide(),
            VisibilityStep::Event => {
                app.emit_to("pet", native_host::pet_visibility_event(), visible)
            }
        }
        .map_err(window_failed)
    })
}

/// One step of showing or hiding the pet (`set_pet_visible`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VisibilityStep {
    Webview,
    Window,
    Event,
}

/// Runs the steps of a show (webview, window, event) or a hide (window, webview, event) in order,
/// each one even after a failure, and returns the first failure.
fn apply_visibility(
    state: &PetVisibility,
    visible: bool,
    mut run: impl FnMut(VisibilityStep) -> Result<(), HostError>,
) -> Result<(), HostError> {
    // Window operations may let the page query reentrantly; publish the requested state first.
    state.set_visible(visible);
    let order = if visible {
        [
            VisibilityStep::Webview,
            VisibilityStep::Window,
            VisibilityStep::Event,
        ]
    } else {
        [
            VisibilityStep::Window,
            VisibilityStep::Webview,
            VisibilityStep::Event,
        ]
    };
    let mut outcome = Ok(());
    for step in order {
        if let Err(error) = run(step) {
            if outcome.is_ok() {
                outcome = Err(error);
            }
        }
    }
    outcome
}

/// The mode the pet is in now, read from the pet window itself.
pub fn current_display_mode(app: &AppHandle) -> Result<DisplayMode, HostError> {
    let pet = app
        .get_webview_window("pet")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    Ok(if pet.is_visible().map_err(window_failed)? {
        DisplayMode::Pet
    } else {
        DisplayMode::Tray
    })
}

fn toggle_label(pet_visible: bool) -> &'static str {
    let labels = native_host::tray_labels();
    if pet_visible {
        labels.hide_pet
    } else {
        labels.show_pet
    }
}

fn open_dashboard(app: &AppHandle) {
    let bridge = match app.state::<crate::bridge::BridgeState>().get(app) {
        Ok(bridge) => bridge,
        Err(error) => return report(app, error),
    };
    let app = app.clone();
    // The service call blocks; keep it off the event loop that delivered the menu click.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = crate::open_dashboard_with(&bridge, None, false, None) {
            report(&app, error);
        }
    });
}

fn run(app: &AppHandle, action: TrayAction) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let result = match action {
        TrayAction::Input => overlay::open_quick_from(app, TRAY_OPENER, "input"),
        TrayAction::Search => overlay::open_quick_from(app, TRAY_OPENER, "question"),
        TrayAction::Dashboard => {
            open_dashboard(app);
            Ok(())
        }
        TrayAction::Settings => crate::show_panel_mode(app, "settings"),
        TrayAction::RecentResult => feedback::show_last(app),
        TrayAction::TogglePet => current_display_mode(app).and_then(|mode| {
            apply_display_mode(
                app,
                if mode.pet_visible() {
                    DisplayMode::Tray
                } else {
                    DisplayMode::Pet
                },
            )
        }),
        TrayAction::Quit => {
            quit(app);
            Ok(())
        }
    };
    if let Err(error) = result {
        report(app, error);
    }
}

/// Builds the tray. `pet_visible` is how the pet will start, which names the toggle item; the
/// caller shows or keeps hiding the pet only after this succeeded, so the pet is never hidden
/// without a tray to bring it back.
pub fn build(app: &tauri::App, pet_visible: bool) -> tauri::Result<()> {
    let labels = native_host::tray_labels();
    let item = |action: TrayAction, label: &str| {
        MenuItem::with_id(app, action.id(), label, true, None::<&str>)
    };
    // A description of the app's state, not a command.
    let status = MenuItem::with_id(app, "status", labels.status, false, None::<&str>)?;
    let input = item(TrayAction::Input, labels.input)?;
    let search = item(TrayAction::Search, labels.search)?;
    let dashboard = item(TrayAction::Dashboard, labels.dashboard)?;
    let settings = item(TrayAction::Settings, labels.settings)?;
    let recent_result = item(TrayAction::RecentResult, labels.recent_result)?;
    let toggle = item(TrayAction::TogglePet, toggle_label(pet_visible))?;
    let quit_item = item(TrayAction::Quit, labels.quit)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &input,
            &search,
            &dashboard,
            &settings,
            &recent_result,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &quit_item,
        ],
    )?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if let Some(action) = TrayAction::from_id(event.id().as_ref()) {
                run(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { rect, .. } = event {
                if let Some(menu) = tray.app_handle().try_state::<TrayMenu>() {
                    if let Ok(mut clicked) = menu.clicked.lock() {
                        // The tray reports physical pixels on Windows; the scale is unused then.
                        *clicked =
                            Some((rect.position.to_physical(1.0), rect.size.to_physical(1.0)));
                    }
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let tray = tray.build(app)?;
    app.manage(TrayMenu {
        status,
        toggle,
        clicked: Mutex::new(None),
    });
    #[cfg(windows)]
    let _ = tray.with_inner_tray_icon(|inner| arrow_cursor_for_tray_window(inner.window_handle()));
    #[cfg(not(windows))]
    let _ = tray;
    Ok(())
}

/// `tray-icon` registers the hidden window that owns the menu with no class cursor. On Windows
/// the pointer vanished over this app's tray menu only (other apps' menus were fine, with the pet
/// hidden too); the likely cause is that window answering the cursor request while the menu is
/// open, which with no class cursor shows none. Giving the class the standard arrow is meant to
/// fix it; the class belongs to `tray-icon`'s windows only. A failure leaves the old behavior and
/// nothing else, so it is not reported.
#[cfg(windows)]
fn arrow_cursor_for_tray_window(hwnd: *mut std::ffi::c_void) {
    #[link(name = "User32")]
    unsafe extern "system" {
        fn LoadCursorW(instance: *mut std::ffi::c_void, name: *const u16) -> *mut std::ffi::c_void;
        fn SetClassLongPtrW(hwnd: *mut std::ffi::c_void, index: i32, value: isize) -> usize;
    }
    const IDC_ARROW: usize = 32512;
    const GCLP_HCURSOR: i32 = -12;
    if hwnd.is_null() {
        return;
    }
    // SAFETY: a null instance with a MAKEINTRESOURCE id loads a shared system cursor, which is
    // never freed; `hwnd` is the live tray window `tray-icon` just created on this thread.
    unsafe {
        let arrow = LoadCursorW(std::ptr::null_mut(), IDC_ARROW as *const u16);
        if !arrow.is_null() {
            SetClassLongPtrW(hwnd, GCLP_HCURSOR, arrow as isize);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_round_trips_through_its_menu_id() {
        for action in TrayAction::ALL {
            assert_eq!(TrayAction::from_id(action.id()), Some(action));
        }
        let ids: std::collections::HashSet<_> = TrayAction::ALL.iter().map(|a| a.id()).collect();
        assert_eq!(ids.len(), TrayAction::ALL.len(), "duplicate menu id");
        // The status line is not a command.
        assert_eq!(TrayAction::from_id("status"), None);
        assert_eq!(TrayAction::from_id(""), None);
    }

    #[test]
    fn a_failed_visibility_step_still_shows_or_hides_the_window() {
        for visible in [true, false] {
            for failing in [
                VisibilityStep::Webview,
                VisibilityStep::Window,
                VisibilityStep::Event,
            ] {
                let mut ran = Vec::new();
                let state = PetVisibility::new(if visible {
                    DisplayMode::Tray
                } else {
                    DisplayMode::Pet
                });
                let outcome = apply_visibility(&state, visible, |step| {
                    assert_eq!(state.is_visible(), visible);
                    ran.push(step);
                    if step == failing {
                        Err(HostError::new(code::HOST_WINDOW_OPERATION_FAILED))
                    } else {
                        Ok(())
                    }
                });
                // Every step ran, in the order that never shows an empty webview, and the failure
                // is still reported to the caller (the start ignores it).
                let expected = if visible {
                    [
                        VisibilityStep::Webview,
                        VisibilityStep::Window,
                        VisibilityStep::Event,
                    ]
                } else {
                    [
                        VisibilityStep::Window,
                        VisibilityStep::Webview,
                        VisibilityStep::Event,
                    ]
                };
                assert_eq!(ran, expected);
                assert_eq!(state.is_visible(), visible);
                assert_eq!(
                    outcome.map_err(|error| error.code().to_owned()),
                    Err(code::HOST_WINDOW_OPERATION_FAILED.to_owned())
                );
            }
            let state = PetVisibility::new(DisplayMode::Pet);
            assert!(apply_visibility(&state, visible, |_| Ok(())).is_ok());
        }
    }

    #[test]
    fn tray_input_and_search_never_close_an_open_quick_input() {
        assert_eq!(
            overlay::quick_action(TRAY_OPENER, true),
            overlay::QuickAction::Show
        );
    }
}
