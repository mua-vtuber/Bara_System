//! The bubble's update phase (docs/decisions/2026-10-14-pet-self-update-spec.md 6.1): instead of a result,
//! the bubble shows a new version's notice, the "install now?" question, the download's progress or its
//! failure. The phase lives in the feedback store (`feedback::Store::update`), so one lock orders it with
//! results, and every update event carries a sequence from the same counter as a result's:
//!
//! - A result that arrives while the update downloads or starts (`Busy`) does not take the bubble; it
//!   waits in "최근 결과" and marks the tray (`feedback::show`).
//! - A result that arrives during the notice, the question or a failure takes the bubble; the update
//!   starts again from the pet's update button.
//! - The update button's question replaces whatever the bubble shows, except a running download, which
//!   is shown again instead. The notice shows only on a visible pet with nothing in the bubble.

use crate::{
    feedback::{self, FeedbackState},
    host_error::{code, HostError},
    native_host,
};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// How long the new-version notice stays before it hides by itself; the update button stays.
const NOTICE_VISIBLE: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdatePhase {
    Notice,
    Confirm,
    Busy,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UpdateBubble {
    pub(crate) phase: UpdatePhase,
    pub(crate) version: String,
}

/// The payload of `contract.updateBubbleEvent` (`src/shared/contracts.ts` `UpdateBubbleEvent`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBubbleEvent<'a> {
    phase: UpdatePhase,
    version: &'a str,
    sequence: u64,
}

/// Whether a result that arrives now must wait instead of taking the bubble (spec 6.1).
pub(crate) fn holds_feedback(update: Option<&UpdateBubble>) -> bool {
    update.is_some_and(|update| update.phase == UpdatePhase::Busy)
}

/// A release version as the service reports it: MAJOR.MINOR.PATCH, each 1 to 6 digits
/// (`src/service/install/release-record.ts` `isReleaseVersion`).
pub(crate) fn valid_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            (1..=6).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// What `show_update_bubble` does.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Opening {
    /// Not now: the pet window asks again later (a notice only).
    Refused,
    /// Shows this phase.
    Show(UpdateBubble),
    /// Shows the running download again without changing it.
    Reshow,
}

pub(crate) fn decide_open(
    current: Option<&UpdateBubble>,
    requested: &str,
    version: &str,
    bubble_visible: bool,
    pet_visible: bool,
) -> Result<Opening, HostError> {
    if !valid_version(version) {
        return Err(HostError::new(code::HOST_INVALID_REQUEST));
    }
    let shown = |phase: UpdatePhase| {
        Opening::Show(UpdateBubble {
            phase,
            version: version.to_owned(),
        })
    };
    match requested {
        "notice" if !pet_visible || bubble_visible || holds_feedback(current) => {
            Ok(Opening::Refused)
        }
        "notice" => Ok(shown(UpdatePhase::Notice)),
        "confirm" if holds_feedback(current) => Ok(Opening::Reshow),
        "confirm" => Ok(shown(UpdatePhase::Confirm)),
        _ => Err(HostError::new(code::HOST_INVALID_REQUEST)),
    }
}

/// The phase after the bubble's own step: "yes" (`busy`) only from the question, a failure only from
/// a running download, and `closed` from anything but a running download.
pub(crate) fn next_phase(
    current: Option<&UpdateBubble>,
    requested: &str,
) -> Result<Option<UpdateBubble>, HostError> {
    let stale = || HostError::new(code::HOST_UPDATE_BUBBLE_STATE);
    let moved = |phase: UpdatePhase| {
        current.map(|update| UpdateBubble {
            phase,
            version: update.version.clone(),
        })
    };
    match (requested, current.map(|update| update.phase)) {
        ("busy", Some(UpdatePhase::Confirm)) => Ok(moved(UpdatePhase::Busy)),
        ("failed", Some(UpdatePhase::Busy)) => Ok(moved(UpdatePhase::Failed)),
        ("closed", Some(UpdatePhase::Busy)) => Err(stale()),
        ("closed", _) => Ok(None),
        ("busy" | "failed", _) => Err(stale()),
        _ => Err(HostError::new(code::HOST_INVALID_REQUEST)),
    }
}

/// What `set_update_bubble` does with the bubble window.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Shows this phase.
    Show(UpdateBubble),
    /// Ends the update bubble and hides the window.
    Hide,
    /// Leaves the window alone: a result already took the bubble from the update (`feedback::show`),
    /// so a late "no" must not hide that result or stop its hide timer.
    Stay,
}

pub(crate) fn decide_step(
    current: Option<&UpdateBubble>,
    requested: &str,
) -> Result<Step, HostError> {
    Ok(match (current, next_phase(current, requested)?) {
        (_, Some(update)) => Step::Show(update),
        (Some(_), None) => Step::Hide,
        (None, None) => Step::Stay,
    })
}

fn emit(app: &AppHandle, update: &UpdateBubble, sequence: u64) -> Result<(), HostError> {
    app.emit(
        native_host::update_bubble_event(),
        UpdateBubbleEvent {
            phase: update.phase,
            version: &update.version,
            sequence,
        },
    )
    .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))
}

/// The pet window's notice (`phase` = `notice`, by itself) or the update button's question
/// (`confirm`); the bubble window asks for the question when its notice is clicked. True when the
/// bubble now shows it; false when a notice must wait (see `decide_open`).
#[tauri::command]
pub fn show_update_bubble(
    window: WebviewWindow,
    app: AppHandle,
    phase: String,
    version: String,
) -> Result<bool, HostError> {
    if !matches!(window.label(), "pet" | "bubble") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let state = app.state::<FeedbackState>();
    let mut store = state.lock()?;
    // Read under the lock: a result shown meanwhile (`feedback::show` takes the same lock) then
    // counts as a full bubble, and the notice does not cover it.
    let bubble_visible = feedback::bubble_window(&app)?
        .is_visible()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    let pet_visible = feedback::pet_visible(&app);
    match decide_open(
        store.update.as_ref(),
        &phase,
        &version,
        bubble_visible,
        pet_visible,
    )? {
        Opening::Refused => Ok(false),
        Opening::Reshow => {
            drop(store);
            feedback::reveal(&app)?;
            Ok(true)
        }
        Opening::Show(update) => {
            let sequence = store.next_sequence();
            emit(&app, &update, sequence)?;
            let notice = update.phase == UpdatePhase::Notice;
            store.update = Some(update);
            drop(store);
            feedback::reveal(&app)?;
            if notice {
                feedback::hide_later(&app, sequence, NOTICE_VISIBLE);
            }
            Ok(true)
        }
    }
}

/// The bubble's own steps: `busy` after "yes", `failed` when the download or the launch failed, and
/// `closed` for "no". A failure shows the bubble again even when it was closed during the download,
/// so the failure is never silent (spec 6.2).
#[tauri::command]
pub fn set_update_bubble(
    window: WebviewWindow,
    app: AppHandle,
    phase: String,
) -> Result<(), HostError> {
    if window.label() != "bubble" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let state = app.state::<FeedbackState>();
    let mut store = state.lock()?;
    let step = decide_step(store.update.as_ref(), &phase)?;
    if step == Step::Stay {
        return Ok(());
    }
    let sequence = store.next_sequence();
    if let Step::Show(update) = &step {
        emit(&app, update, sequence)?;
    }
    store.update = match &step {
        Step::Show(update) => Some(update.clone()),
        _ => None,
    };
    drop(store);
    match step {
        Step::Show(_) => feedback::reveal(&app),
        _ => feedback::bubble_window(&app)?
            .hide()
            .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bubble(phase: UpdatePhase) -> UpdateBubble {
        UpdateBubble {
            phase,
            version: "0.1.9".into(),
        }
    }

    #[test]
    fn only_a_running_download_holds_results_back() {
        assert!(!holds_feedback(None));
        for phase in [
            UpdatePhase::Notice,
            UpdatePhase::Confirm,
            UpdatePhase::Failed,
        ] {
            assert!(!holds_feedback(Some(&bubble(phase))), "{phase:?}");
        }
        assert!(holds_feedback(Some(&bubble(UpdatePhase::Busy))));
    }

    #[test]
    fn the_notice_shows_only_on_a_visible_pet_with_an_empty_bubble() {
        let shown = Opening::Show(bubble(UpdatePhase::Notice));
        assert_eq!(
            decide_open(None, "notice", "0.1.9", false, true).unwrap(),
            shown
        );
        assert_eq!(
            decide_open(None, "notice", "0.1.9", true, true).unwrap(),
            Opening::Refused
        );
        assert_eq!(
            decide_open(None, "notice", "0.1.9", false, false).unwrap(),
            Opening::Refused
        );
        assert_eq!(
            decide_open(
                Some(&bubble(UpdatePhase::Busy)),
                "notice",
                "0.1.9",
                false,
                true
            )
            .unwrap(),
            Opening::Refused
        );
        // A notice that hid by itself leaves its phase behind; a later notice still shows.
        assert_eq!(
            decide_open(
                Some(&bubble(UpdatePhase::Notice)),
                "notice",
                "0.1.9",
                false,
                true
            )
            .unwrap(),
            shown
        );
    }

    #[test]
    fn the_question_replaces_anything_but_a_running_download() {
        let shown = Opening::Show(bubble(UpdatePhase::Confirm));
        for current in [
            None,
            Some(bubble(UpdatePhase::Notice)),
            Some(bubble(UpdatePhase::Failed)),
        ] {
            assert_eq!(
                decide_open(current.as_ref(), "confirm", "0.1.9", true, true).unwrap(),
                shown
            );
        }
        assert_eq!(
            decide_open(
                Some(&bubble(UpdatePhase::Busy)),
                "confirm",
                "0.1.9",
                false,
                true
            )
            .unwrap(),
            Opening::Reshow
        );
        for (phase, version) in [
            ("busy", "0.1.9"),
            ("confirm", "v0.1.9"),
            ("confirm", "0.1"),
            ("notice", ""),
        ] {
            assert_eq!(
                decide_open(None, phase, version, false, true)
                    .unwrap_err()
                    .code(),
                code::HOST_INVALID_REQUEST,
                "{phase} {version}"
            );
        }
    }

    #[test]
    fn the_bubble_moves_from_question_to_download_to_failure_only() {
        let confirm = bubble(UpdatePhase::Confirm);
        let busy = bubble(UpdatePhase::Busy);
        assert_eq!(
            next_phase(Some(&confirm), "busy").unwrap(),
            Some(busy.clone())
        );
        assert_eq!(
            next_phase(Some(&busy), "failed").unwrap(),
            Some(bubble(UpdatePhase::Failed))
        );
        // A second "yes" while the download runs is refused: there is no second download.
        assert_eq!(
            next_phase(Some(&busy), "busy").unwrap_err().code(),
            code::HOST_UPDATE_BUBBLE_STATE
        );
        assert_eq!(
            next_phase(Some(&busy), "closed").unwrap_err().code(),
            code::HOST_UPDATE_BUBBLE_STATE
        );
        for current in [
            None,
            Some(bubble(UpdatePhase::Notice)),
            Some(bubble(UpdatePhase::Failed)),
        ] {
            assert_eq!(
                next_phase(current.as_ref(), "busy").unwrap_err().code(),
                code::HOST_UPDATE_BUBBLE_STATE
            );
            assert_eq!(
                next_phase(current.as_ref(), "failed").unwrap_err().code(),
                code::HOST_UPDATE_BUBBLE_STATE
            );
            assert_eq!(next_phase(current.as_ref(), "closed").unwrap(), None);
        }
        assert_eq!(
            next_phase(Some(&confirm), "notice").unwrap_err().code(),
            code::HOST_INVALID_REQUEST
        );
    }

    #[test]
    fn a_late_no_after_a_result_took_the_bubble_leaves_it_alone() {
        // `feedback::show` cleared the question when a result took the bubble; the stale "no" from
        // the question still on screen must not hide that result.
        assert_eq!(decide_step(None, "closed").unwrap(), Step::Stay);
        for phase in [
            UpdatePhase::Notice,
            UpdatePhase::Confirm,
            UpdatePhase::Failed,
        ] {
            assert_eq!(
                decide_step(Some(&bubble(phase)), "closed").unwrap(),
                Step::Hide
            );
        }
        assert_eq!(
            decide_step(Some(&bubble(UpdatePhase::Confirm)), "busy").unwrap(),
            Step::Show(bubble(UpdatePhase::Busy))
        );
        assert_eq!(
            decide_step(None, "busy").unwrap_err().code(),
            code::HOST_UPDATE_BUBBLE_STATE
        );
    }

    #[test]
    fn versions_are_three_short_numbers() {
        for good in ["0.1.9", "10.20.30", "999999.0.1"] {
            assert!(valid_version(good), "{good}");
        }
        for bad in [
            "",
            "0.1",
            "0.1.9.1",
            "v0.1.9",
            "0.1.9-rc.1",
            "0..9",
            "1234567.0.0",
            " 0.1.9",
        ] {
            assert!(!valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn the_event_carries_the_phase_the_version_and_the_shared_sequence() {
        let event = UpdateBubbleEvent {
            phase: UpdatePhase::Busy,
            version: "0.1.9",
            sequence: 7,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({"phase":"busy","version":"0.1.9","sequence":7})
        );
    }
}
