use crate::host_error::{code, HostError};
use crate::native_host;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

pub struct QuickState(Mutex<String>);
impl Default for QuickState {
    fn default() -> Self {
        Self(Mutex::new("input".into()))
    }
}

fn allowed(label: &str) -> bool {
    matches!(label, "pet" | "quick" | "main")
}

fn near_anchor(
    anchor: PhysicalPosition<i32>,
    anchor_size: PhysicalSize<u32>,
    overlay_size: PhysicalSize<u32>,
    work: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    margin: u32,
    gap: u32,
) -> PhysicalPosition<i32> {
    let (margin, gap) = (i64::from(margin), i64::from(gap));
    let (left, top) = (i64::from(work.x) + margin, i64::from(work.y) + margin);
    let right =
        (i64::from(work.x) + i64::from(work_size.width) - i64::from(overlay_size.width) - margin)
            .max(left);
    let bottom =
        (i64::from(work.y) + i64::from(work_size.height) - i64::from(overlay_size.height) - margin)
            .max(top);
    let preferred_x =
        i64::from(anchor.x) + i64::from(anchor_size.width) / 2 - i64::from(overlay_size.width) / 2;
    let above = i64::from(anchor.y) - i64::from(overlay_size.height) - gap;
    let below = i64::from(anchor.y) + i64::from(anchor_size.height) + gap;
    let preferred_y = if above >= top { above } else { below };
    PhysicalPosition::new(
        preferred_x.clamp(left, right) as i32,
        preferred_y.clamp(top, bottom) as i32,
    )
}

/// Where the quick input and the bubble go while the pet is hidden: the tray icon as it was when
/// the user last clicked it (`tray::clicked_rect`), else the mouse pointer, else the bottom-right
/// corner of the primary monitor's work area. Never the hidden pet's old position.
fn hidden_pet_anchor(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    if let Some(rect) = crate::tray::clicked_rect(app) {
        return Some(rect);
    }
    if let Ok(cursor) = app.cursor_position() {
        return Some((
            PhysicalPosition::new(cursor.x.round() as i32, cursor.y.round() as i32),
            PhysicalSize::new(0, 0),
        ));
    }
    let area = *app.primary_monitor().ok().flatten()?.work_area();
    let corner = |start: i32, length: u32| {
        (i64::from(start) + i64::from(length)).clamp(i64::from(i32::MIN), i64::from(i32::MAX))
            as i32
    };
    Some((
        PhysicalPosition::new(
            corner(area.position.x, area.size.width),
            corner(area.position.y, area.size.height),
        ),
        PhysicalSize::new(0, 0),
    ))
}

pub fn position_near_pet(app: &AppHandle, label: &str) -> Result<(), HostError> {
    let window_failed = |_: tauri::Error| HostError::new(code::HOST_WINDOW_OPERATION_FAILED);
    let pet = app
        .get_webview_window("pet")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    let overlay = app
        .get_webview_window(label)
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    let quick = if label == "bubble" {
        app.get_webview_window("quick")
            .filter(|window| window.is_visible().unwrap_or(false))
    } else {
        None
    };
    let (anchor, anchor_size) = match quick {
        Some(quick) => (
            quick.outer_position().map_err(window_failed)?,
            quick.outer_size().map_err(window_failed)?,
        ),
        None if pet.is_visible().map_err(window_failed)? => (
            pet.outer_position().map_err(window_failed)?,
            pet.outer_size().map_err(window_failed)?,
        ),
        None => hidden_pet_anchor(app).ok_or(HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?,
    };
    // The monitor under the anchor's centre; a hidden pet may sit on another monitor entirely.
    let centre_x = f64::from(anchor.x) + f64::from(anchor_size.width) / 2.0;
    let centre_y = f64::from(anchor.y) + f64::from(anchor_size.height) / 2.0;
    let monitor = app
        .monitor_from_point(centre_x, centre_y)
        .ok()
        .flatten()
        .or_else(|| pet.current_monitor().ok().flatten())
        .or_else(|| pet.primary_monitor().ok().flatten())
        .ok_or(HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    let area = monitor.work_area();
    let margin = (12.0 * monitor.scale_factor()).round().max(0.0) as u32;
    let gap = (8.0 * monitor.scale_factor()).round().max(0.0) as u32;
    let position = near_anchor(
        anchor,
        anchor_size,
        overlay.outer_size().map_err(window_failed)?,
        area.position,
        area.size,
        margin,
        gap,
    );
    overlay.set_position(position).map_err(window_failed)
}

pub fn reposition_visible(app: &AppHandle) {
    for label in ["quick", "bubble"] {
        if app
            .get_webview_window(label)
            .is_some_and(|window| window.is_visible().unwrap_or(false))
        {
            let _ = position_near_pet(app, label);
        }
    }
}

/// Tells the pet window whether the quick input is open, so it can pause its idle motion while
/// the user types. Addressed to the `pet` window (a window that listens with the default target
/// receives it too); the payload is `true` once the input is shown and `false` once it is hidden.
pub fn announce_quick_visibility(app: &AppHandle, visible: bool) -> Result<(), HostError> {
    app.emit_to("pet", native_host::quick_visibility_event(), visible)
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))
}

#[cfg(windows)]
fn quick_or_pet_focused(app: &AppHandle) -> Result<bool, HostError> {
    // WebView2 owns a child HWND, so Tauri's top-level is_focused() can be false even
    // while the user types. Compare the foreground top-level window instead.
    #[link(name = "User32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
    }
    // SAFETY: GetForegroundWindow takes no pointers and does not transfer ownership.
    let foreground = unsafe { GetForegroundWindow() };
    for label in ["quick", "pet"] {
        if let Some(window) = app.get_webview_window(label) {
            let hwnd = window
                .hwnd()
                .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
            if hwnd.0 == foreground {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(not(windows))]
fn quick_or_pet_focused(app: &AppHandle) -> Result<bool, HostError> {
    for label in ["quick", "pet"] {
        if let Some(window) = app.get_webview_window(label) {
            if window
                .is_focused()
                .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn dismiss_quick_on_blur(app: &AppHandle, label: &str) -> Result<(), HostError> {
    if !matches!(label, "quick" | "pet") {
        return Ok(());
    }
    let quick = app
        .get_webview_window("quick")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    if quick
        .is_visible()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?
        && !quick_or_pet_focused(app)?
    {
        // Moving to the pet must wait for its click to toggle. Otherwise the blur
        // would hide the input first and that same click would immediately reopen it.
        dismiss_quick(app)?;
    }
    Ok(())
}

/// What a request to open the quick input does, given who asked and whether it is already open.
#[derive(Debug, PartialEq, Eq)]
pub enum QuickAction {
    /// Show it (or keep it shown), switch to the requested mode and focus it.
    Show,
    /// Hide it; drafts stay in the quick window.
    Dismiss,
}

/// Clicking the pet toggles the quick input. Every other opener -- a tray menu command, a button
/// in the main window -- only ever opens and focuses it, so choosing "입력" from the tray while
/// the input is already open never closes it.
pub fn quick_action(opener: &str, visible: bool) -> QuickAction {
    if opener == "pet" && visible {
        QuickAction::Dismiss
    } else {
        QuickAction::Show
    }
}

#[tauri::command]
pub fn open_quick(window: WebviewWindow, app: AppHandle, mode: String) -> Result<(), HostError> {
    if !allowed(window.label()) {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    if !matches!(mode.as_str(), "input" | "question") {
        return Err(HostError::new(code::HOST_INVALID_REQUEST));
    }
    open_quick_from(&app, window.label(), &mode)
}

/// Opens the quick input in `mode` ("input" or "question") on behalf of `opener` (a window label
/// or `"tray"`), following [`quick_action`].
pub fn open_quick_from(app: &AppHandle, opener: &str, mode: &str) -> Result<(), HostError> {
    let quick = app
        .get_webview_window("quick")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    let window_failed = |_: tauri::Error| HostError::new(code::HOST_WINDOW_OPERATION_FAILED);
    if quick_action(opener, quick.is_visible().map_err(window_failed)?) == QuickAction::Dismiss {
        return dismiss_quick(app);
    }
    *app.state::<QuickState>()
        .0
        .lock()
        .map_err(|_| HostError::new(code::HOST_STATE_LOCK_FAILED))? = mode.to_owned();
    position_near_pet(app, "quick")?;
    quick.show().map_err(window_failed)?;
    quick.set_focus().map_err(window_failed)?;
    quick.emit("pet-quick", mode).map_err(window_failed)?;
    announce_quick_visibility(app, true)
}

#[tauri::command]
pub fn get_quick_mode(
    window: WebviewWindow,
    state: State<'_, QuickState>,
) -> Result<String, HostError> {
    if window.label() != "quick" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    Ok(state
        .0
        .lock()
        .map_err(|_| HostError::new(code::HOST_STATE_LOCK_FAILED))?
        .clone())
}

#[tauri::command]
pub fn hide_quick(window: WebviewWindow, app: AppHandle) -> Result<(), HostError> {
    if !allowed(window.label()) {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    dismiss_quick(&app)
}

pub fn dismiss_quick(app: &AppHandle) -> Result<(), HostError> {
    app.get_webview_window("quick")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?
        .hide()
        .map_err(|_: tauri::Error| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    // Both always run, so a failed bubble move cannot leave the pet believing the input is still open.
    let moved = if app
        .get_webview_window("bubble")
        .is_some_and(|bubble| bubble.is_visible().unwrap_or(false))
    {
        position_near_pet(app, "bubble")
    } else {
        Ok(())
    };
    let announced = announce_quick_visibility(app, false);
    moved.and(announced)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_pet_click_closes_an_open_quick_input() {
        assert_eq!(quick_action("pet", true), QuickAction::Dismiss);
        assert_eq!(quick_action("pet", false), QuickAction::Show);
        for opener in ["tray", "main", "quick"] {
            assert_eq!(quick_action(opener, true), QuickAction::Show, "{opener}");
            assert_eq!(quick_action(opener, false), QuickAction::Show, "{opener}");
        }
    }
    #[test]
    fn strip_stays_in_work_area_and_prefers_above_pet() {
        let work = PhysicalPosition::new(0, 0);
        let area = PhysicalSize::new(1920, 1040);
        let pet = PhysicalSize::new(150, 165);
        let strip = PhysicalSize::new(480, 82);
        assert_eq!(
            near_anchor(
                PhysicalPosition::new(1746, 851),
                pet,
                strip,
                work,
                area,
                12,
                8
            ),
            PhysicalPosition::new(1428, 761)
        );
        assert_eq!(
            near_anchor(PhysicalPosition::new(4, 4), pet, strip, work, area, 12, 8),
            PhysicalPosition::new(12, 177)
        );
    }

    /// A tray icon sits in the taskbar, below the work area: the strip lands above it, inside the
    /// work area, as far right as the icon allows.
    #[test]
    fn strip_anchored_to_a_tray_icon_stays_in_the_work_area() {
        let work = PhysicalPosition::new(0, 0);
        let area = PhysicalSize::new(1920, 1040);
        let strip = PhysicalSize::new(480, 82);
        let icon = PhysicalSize::new(32, 32);
        assert_eq!(
            near_anchor(
                PhysicalPosition::new(1800, 1044),
                icon,
                strip,
                work,
                area,
                12,
                8
            ),
            PhysicalPosition::new(1428, 946)
        );
        // A second monitor to the left (negative x) keeps the strip on that monitor.
        assert_eq!(
            near_anchor(
                PhysicalPosition::new(-200, 1044),
                icon,
                strip,
                PhysicalPosition::new(-1920, 0),
                area,
                12,
                8
            ),
            PhysicalPosition::new(-492, 946)
        );
    }
}
