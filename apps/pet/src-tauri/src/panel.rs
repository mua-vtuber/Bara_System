//! Where the main panel (연결과 설정, the first-run setup, the result view) opens. Windows would
//! put it at its default spot near the top-left corner, far from a pet that usually sits
//! bottom-right and from the tray icon; instead it opens beside the pet, or near the tray icon
//! while only the tray shows, always fully inside that monitor's work area.
//!
//! The panel is placed only when it goes from hidden to shown. An already visible panel is only
//! restored from minimization and focused, so a window the user moved stays where they put it.
//!
//! The geometry is [`panel_position`] (rectangles in, position out); [`show`] gathers the
//! rectangles from the windows and monitors, the same way the quick input does (`overlay.rs`).

use crate::host_error::{code, HostError};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, WebviewWindow};

/// Space kept between the panel and the work area's edges, in logical pixels (as `overlay.rs`).
const MARGIN: f64 = 12.0;
/// Space between the panel and the pet or tray icon it opens next to, in logical pixels.
const GAP: f64 = 8.0;

/// What the panel opens next to.
#[derive(Clone, Copy, Debug)]
pub enum Anchor {
    /// The pet window on screen: the panel goes beside it, never over it when there is room.
    Pet(PhysicalRect<i32, u32>),
    /// The tray icon as of the user's last click on it (`tray::clicked_rect`), used while the pet
    /// is hidden: the panel goes above it (below it for a taskbar at the top of the screen).
    Tray(PhysicalRect<i32, u32>),
    /// Nothing to open next to: the panel is centred in the work area.
    None,
}

/// The positions along one axis where a panel of `size` lies inside `[start, start + length)`:
/// `margin` away from both edges when it fits with them, flush to the edges when it only fits
/// without them, and at `start` when it does not fit at all (so its title bar stays reachable).
fn axis_range(start: i64, length: i64, size: i64, margin: i64) -> (i64, i64) {
    if size + 2 * margin <= length {
        (start + margin, start + length - size - margin)
    } else if size <= length {
        (start, start + length - size)
    } else {
        (start, start)
    }
}

/// Where the panel's top-left corner goes, in physical pixels. `panel` is the panel's outer size
/// on the target monitor, `work` that monitor's work area; `margin` and `gap` are already scaled
/// to it. The result always lies inside `work` as far as the panel's size allows.
///
/// - Beside the pet: on its left if the panel fits there, else above it, else on its right, else
///   below it; with no side wide enough, on the side with the most room (the clamp may then cover
///   part of the pet). Beside means bottom edges aligned; above or below means centred on the pet.
/// - Near the tray icon: centred on it horizontally, above it when that fits, else below it.
/// - No anchor: centred in the work area.
pub fn panel_position(
    anchor: Anchor,
    panel: PhysicalSize<u32>,
    work: PhysicalRect<i32, u32>,
    margin: u32,
    gap: u32,
) -> PhysicalPosition<i32> {
    let (width, height) = (i64::from(panel.width), i64::from(panel.height));
    let (margin, gap) = (i64::from(margin), i64::from(gap));
    let (left, top) = (i64::from(work.position.x), i64::from(work.position.y));
    let (right, bottom) = (
        left + i64::from(work.size.width),
        top + i64::from(work.size.height),
    );
    let (min_x, max_x) = axis_range(left, right - left, width, margin);
    let (min_y, max_y) = axis_range(top, bottom - top, height, margin);
    let clamp_x = |x: i64| x.clamp(min_x, max_x);
    let clamp_y = |y: i64| y.clamp(min_y, max_y);
    let edges = |rect: PhysicalRect<i32, u32>| {
        let (x, y) = (i64::from(rect.position.x), i64::from(rect.position.y));
        (
            x,
            y,
            x + i64::from(rect.size.width),
            y + i64::from(rect.size.height),
        )
    };
    let (x, y) = match anchor {
        Anchor::Pet(pet) => {
            let (pet_left, pet_top, pet_right, pet_bottom) = edges(pet);
            let centre_x = (pet_left + pet_right) / 2 - width / 2;
            let beside_y = clamp_y(pet_bottom - height);
            let on_left = (pet_left - gap - width, beside_y);
            let on_above = (clamp_x(centre_x), pet_top - gap - height);
            let on_right = (pet_right + gap, beside_y);
            let on_below = (clamp_x(centre_x), pet_bottom + gap);
            if on_left.0 >= min_x {
                on_left
            } else if on_above.1 >= min_y {
                on_above
            } else if on_right.0 <= max_x {
                on_right
            } else if on_below.1 <= max_y {
                on_below
            } else {
                // No side is wide enough: take the one with the most room and let the clamp
                // below keep the panel on screen.
                [
                    (pet_left - left, on_left),
                    (pet_top - top, on_above),
                    (right - pet_right, on_right),
                    (bottom - pet_bottom, on_below),
                ]
                .into_iter()
                .reduce(|best, side| if side.0 > best.0 { side } else { best })
                .map_or(on_left, |(_, position)| position)
            }
        }
        Anchor::Tray(icon) => {
            let (icon_left, icon_top, icon_right, icon_bottom) = edges(icon);
            let above = icon_top - gap - height;
            (
                (icon_left + icon_right) / 2 - width / 2,
                if above >= min_y {
                    above
                } else {
                    icon_bottom + gap
                },
            )
        }
        Anchor::None => (
            left + (right - left - width) / 2,
            top + (bottom - top - height) / 2,
        ),
    };
    // Every bound lies inside the work area, which itself holds i32 coordinates.
    PhysicalPosition::new(clamp_x(x) as i32, clamp_y(y) as i32)
}

/// `size` (physical pixels at `from_scale`) as it becomes on a monitor at `to_scale`: Windows
/// keeps a window's logical size when it moves to a monitor with another display scale.
pub fn rescale(size: PhysicalSize<u32>, from_scale: f64, to_scale: f64) -> PhysicalSize<u32> {
    if !(from_scale > 0.0 && to_scale > 0.0) || from_scale == to_scale {
        return size;
    }
    let scale = |length: u32| (f64::from(length) * to_scale / from_scale).round() as u32;
    PhysicalSize::new(scale(size.width), scale(size.height))
}

fn window_failed(_: tauri::Error) -> HostError {
    HostError::new(code::HOST_WINDOW_OPERATION_FAILED)
}

fn outer_rect(window: &WebviewWindow) -> Result<PhysicalRect<i32, u32>, HostError> {
    Ok(PhysicalRect {
        position: window.outer_position().map_err(window_failed)?,
        size: window.outer_size().map_err(window_failed)?,
    })
}

/// Moves the hidden panel next to the pet (when it is on screen) or the tray icon, on the monitor
/// under that anchor; with neither, to the middle of the primary monitor.
fn place(app: &AppHandle, panel: &WebviewWindow) -> Result<(), HostError> {
    let pet = app
        .get_webview_window("pet")
        .filter(|pet| pet.is_visible().unwrap_or(false));
    let anchor = match pet {
        Some(pet) => Anchor::Pet(outer_rect(&pet)?),
        // Unlike the quick input (`overlay::hidden_pet_anchor`), not the mouse pointer: the panel
        // is a large window, and a pointer anywhere on screen is no better than the centre.
        None => crate::tray::clicked_rect(app).map_or(Anchor::None, |(position, size)| {
            Anchor::Tray(PhysicalRect { position, size })
        }),
    };
    let monitor = match anchor {
        Anchor::Pet(rect) | Anchor::Tray(rect) => app
            .monitor_from_point(
                f64::from(rect.position.x) + f64::from(rect.size.width) / 2.0,
                f64::from(rect.position.y) + f64::from(rect.size.height) / 2.0,
            )
            .ok()
            .flatten(),
        Anchor::None => None,
    }
    .or_else(|| app.primary_monitor().ok().flatten())
    .or_else(|| panel.current_monitor().ok().flatten())
    .ok_or(HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    let scale = monitor.scale_factor();
    let work = *monitor.work_area();
    let margin = (MARGIN * scale).round().max(0.0) as u32;
    let gap = (GAP * scale).round().max(0.0) as u32;
    let current = panel.outer_size().map_err(window_failed)?;
    // The panel's size once it is on the target monitor, which may have another display scale
    // than the one it was created or last shown on.
    let size = rescale(current, panel.scale_factor().map_err(window_failed)?, scale);
    panel
        .set_position(panel_position(anchor, size, work, margin, gap))
        .map_err(window_failed)?;
    // If the move resized the panel to something other than the estimate (rounding, a title bar
    // that does not scale exactly), place it again with the size it really has now.
    if let Ok(actual) = panel.outer_size() {
        if actual != current && actual != size {
            panel
                .set_position(panel_position(anchor, actual, work, margin, gap))
                .map_err(window_failed)?;
        }
    }
    Ok(())
}

/// Shows and focuses the main panel, placing it first when it was hidden ([`place`]). Every path
/// that brings the panel up goes through here: `show_panel_mode` (the pet's and the panel's
/// `open_panel`, the tray's "설정"), the first-run setup at startup (`tray::show_panel`) and a
/// click on a feedback bubble (`feedback::open_feedback`).
pub fn show(app: &AppHandle) -> Result<WebviewWindow, HostError> {
    let panel = app
        .get_webview_window("main")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    if !panel.is_visible().map_err(window_failed)? {
        // Placing is a convenience: if it fails, the panel still opens, where it was.
        let _ = place(app, &panel);
    }
    panel.show().map_err(window_failed)?;
    // A minimized panel is still visible to Windows. Showing/focusing alone does not restore it.
    if panel.is_minimized().map_err(window_failed)? {
        panel.unminimize().map_err(window_failed)?;
    }
    panel.set_focus().map_err(window_failed)?;
    Ok(panel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    const PANEL: PhysicalSize<u32> = PhysicalSize::new(480, 700);
    const PET: (u32, u32) = (150, 165);

    fn work() -> PhysicalRect<i32, u32> {
        rect(0, 0, 1920, 1040)
    }

    fn pet_at(x: i32, y: i32) -> Anchor {
        Anchor::Pet(rect(x, y, PET.0, PET.1))
    }

    fn at(x: i32, y: i32) -> PhysicalPosition<i32> {
        PhysicalPosition::new(x, y)
    }

    /// The first-run corner (`bottom_right_position`): plenty of room on the left, so the panel
    /// sits there, its bottom level with the pet's and its right edge a gap short of the pet.
    #[test]
    fn opens_left_of_a_pet_with_room_on_its_left() {
        assert_eq!(
            panel_position(pet_at(1746, 851), PANEL, work(), 12, 8),
            at(1258, 316)
        );
        // A pet high on the screen: still on the left, pushed down to stay inside the work area.
        assert_eq!(
            panel_position(pet_at(1000, 20), PANEL, work(), 12, 8),
            at(512, 12)
        );
    }

    #[test]
    fn opens_above_or_right_of_a_pet_with_no_room_on_its_left() {
        // Bottom-left corner: no room on the left, room above.
        assert_eq!(
            panel_position(pet_at(24, 851), PANEL, work(), 12, 8),
            at(12, 143)
        );
        // Top-left corner: no room on the left or above, so on the right.
        assert_eq!(
            panel_position(pet_at(24, 24), PANEL, work(), 12, 8),
            at(182, 12)
        );
        // Neither left, above nor right fits on a narrow screen: below.
        assert_eq!(
            panel_position(pet_at(300, 24), PANEL, rect(0, 0, 900, 1040), 12, 8),
            at(135, 197)
        );
    }

    /// Never placed over the pet when a side is free: the panel and the pet do not overlap.
    #[test]
    fn never_covers_the_pet_when_a_side_has_room() {
        for (x, y) in [(1746, 851), (24, 851), (24, 24), (1746, 24), (900, 500)] {
            let position = panel_position(pet_at(x, y), PANEL, work(), 12, 8);
            let overlaps_x = position.x < x + PET.0 as i32 && x < position.x + PANEL.width as i32;
            let overlaps_y = position.y < y + PET.1 as i32 && y < position.y + PANEL.height as i32;
            assert!(
                !(overlaps_x && overlaps_y),
                "pet at ({x}, {y}) -> {position:?}"
            );
        }
    }

    /// A tray icon in a bottom taskbar sits below the work area: the panel lands above it, as far
    /// down and right as the margin allows.
    #[test]
    fn opens_above_a_bottom_right_tray_icon() {
        let icon = Anchor::Tray(rect(1800, 1044, 32, 32));
        assert_eq!(panel_position(icon, PANEL, work(), 12, 8), at(1428, 328));
        // A taskbar at the top: below the icon instead.
        let top_icon = Anchor::Tray(rect(1800, 4, 32, 32));
        assert_eq!(
            panel_position(top_icon, PANEL, rect(0, 48, 1920, 1032), 12, 8),
            at(1428, 60)
        );
    }

    #[test]
    fn centres_on_the_work_area_without_an_anchor() {
        assert_eq!(
            panel_position(Anchor::None, PANEL, work(), 12, 8),
            at(720, 170)
        );
    }

    /// Anchors past every edge of the work area: the panel stays inside it, `margin` from the edge.
    #[test]
    fn clamps_at_every_edge() {
        let work = work();
        let cases = [
            (Anchor::Tray(rect(-500, 900, 32, 32)), at(12, 192)), // left
            (Anchor::Tray(rect(3000, 900, 32, 32)), at(1428, 192)), // right
            (Anchor::Tray(rect(900, -900, 32, 32)), at(676, 12)), // top
            (Anchor::Tray(rect(900, 5000, 32, 32)), at(676, 328)), // bottom
            (pet_at(1900, 1000), at(1412, 328)),                  // a pet hanging off the corner
        ];
        for (anchor, expected) in cases {
            let position = panel_position(anchor, PANEL, work, 12, 8);
            assert_eq!(position, expected, "{anchor:?}");
            assert!(position.x >= 0 && position.y >= 0);
            assert!(position.x + PANEL.width as i32 <= 1920);
            assert!(position.y + PANEL.height as i32 <= 1040);
        }
    }

    /// A small screen: a panel taller than the work area goes to its top edge; one that fits only
    /// without the margin goes flush to the edges; one larger both ways goes to the top-left.
    #[test]
    fn a_panel_larger_than_the_work_area_goes_to_its_top_left() {
        let small = rect(0, 0, 1024, 600);
        assert_eq!(
            panel_position(pet_at(850, 411), PANEL, small, 12, 8),
            at(362, 0)
        );
        assert_eq!(
            panel_position(pet_at(850, 435), PhysicalSize::new(480, 590), small, 12, 8),
            at(362, 10)
        );
        let tiny = rect(100, 50, 400, 500);
        for anchor in [
            pet_at(300, 300),
            Anchor::Tray(rect(450, 560, 32, 32)),
            Anchor::None,
        ] {
            assert_eq!(
                panel_position(anchor, PANEL, tiny, 12, 8),
                at(100, 50),
                "{anchor:?}"
            );
        }
    }

    /// A second monitor left of and above the primary one (negative coordinates): the panel stays
    /// on that monitor's work area.
    #[test]
    fn stays_on_a_monitor_with_negative_coordinates() {
        let left = rect(-1920, -200, 1920, 1040);
        assert_eq!(
            panel_position(pet_at(-174, 651), PANEL, left, 12, 8),
            at(-662, 116)
        );
        assert_eq!(
            panel_position(pet_at(-1900, -180), PANEL, left, 12, 8),
            at(-1742, -188)
        );
        assert_eq!(
            panel_position(Anchor::Tray(rect(-120, 844, 32, 32)), PANEL, left, 12, 8),
            at(-492, 128)
        );
        assert_eq!(
            panel_position(Anchor::None, PANEL, left, 12, 8),
            at(-1200, -30)
        );
    }

    #[test]
    fn rescales_between_display_scales() {
        let size = PhysicalSize::new(480, 700);
        assert_eq!(rescale(size, 1.0, 1.5), PhysicalSize::new(720, 1050));
        assert_eq!(rescale(size, 1.5, 1.0), PhysicalSize::new(320, 467));
        assert_eq!(rescale(size, 1.25, 1.25), size);
        assert_eq!(rescale(size, 0.0, 2.0), size);
    }
}
