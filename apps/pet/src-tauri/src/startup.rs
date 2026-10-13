//! The startup check, started by the host (plan 1C②). The memory server of a complete install, the SSH
//! tunnel or the existing server used to be checked, and started, only once the main window's page had
//! loaded and asked for it, so a page that failed to load left the server down until the user did
//! something. Now the host asks the service for the check (`startup.check`) right after the app starts,
//! with the pet shown or kept in the tray alike, and the main window joins that same run instead of
//! starting its own (`src/ui/main.ts`). The service runs it once per start (`src/service/router.ts`
//! `startupCheck`, `InstallManager.ensureConnection`'s rules: it never installs or creates a database).
//!
//! The outcome is shown once per start. The main window shows it as before (status line, backup bubble,
//! failure bubble) when it takes the report (`claim_startup_report`) before the check ends; otherwise the
//! host shows a failure itself as a background bubble, which with the pet hidden waits in "최근 결과" and
//! marks the tray. A main page loaded again after the check ended (a reload, WebView2 recovering from a
//! crash) only updates its status line: the outcome was already reported. A quit in progress shows nothing.

use crate::{bridge::BridgeState, feedback, host_error::code, tray};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Who shows the startup outcome. `Open` until the main window or the host takes it; then fixed.
/// `Reported` is the main window's report once the check has ended: its page published (or was
/// publishing) the outcome, so a page loaded later does not publish it again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Reporter {
    #[default]
    Open,
    Screen,
    Reported,
    Host,
}

#[derive(Default)]
pub struct StartupReport(Mutex<Reporter>);

impl StartupReport {
    fn with<T>(&self, change: impl FnOnce(&mut Reporter) -> T) -> T {
        change(
            &mut self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// The main window asks before it joins the check. The first to ask takes the report, and a
    /// page loaded again while the check still runs keeps it (the page before it showed nothing
    /// yet). False once the check has ended: the host showed its outcome, or a page showed it.
    pub fn claim_for_screen(&self) -> bool {
        self.with(|current| {
            if *current == Reporter::Open {
                *current = Reporter::Screen;
            }
            *current == Reporter::Screen
        })
    }

    /// The host calls this once the check ended, whatever its outcome: true when nobody took the
    /// report, so the host shows it; from then on no page claims it.
    fn settle_for_host(&self) -> bool {
        self.with(|current| match *current {
            Reporter::Open => {
                *current = Reporter::Host;
                true
            }
            Reporter::Screen => {
                *current = Reporter::Reported;
                false
            }
            Reporter::Reported | Reporter::Host => false,
        })
    }
}

/// What the host shows for a finished check when it has the report.
#[derive(Debug, PartialEq)]
enum Shown {
    Nothing,
    /// The failure bubble the service made for it (`StartupCheckResult.feedback`).
    Bubble(Value),
    /// The check could not be followed to its end (the service did not start or stopped answering)
    /// or answered in a shape this host does not know: the host's own notice.
    Notice,
}

/// Service codes a request ends with only because the app is quitting (`service.drain`).
const QUIT_CODES: &[&str] = &["SHUTTING_DOWN", "CANCELLED"];

fn shown(outcome: &Result<Value, crate::host_error::HostError>, quitting: bool) -> Shown {
    if quitting {
        return Shown::Nothing;
    }
    match outcome {
        Ok(result) => match result.get("kind").and_then(Value::as_str) {
            Some("firstRun" | "connected") => Shown::Nothing,
            Some("failed") => result
                .get("feedback")
                .filter(|feedback| feedback.is_object())
                .cloned()
                .map_or(Shown::Notice, Shown::Bubble),
            _ => Shown::Notice,
        },
        Err(error) if QUIT_CODES.contains(&error.code_str()) => Shown::Nothing,
        Err(_) => Shown::Notice,
    }
}

/// Starts the check on its own thread; called once from `setup`, after the tray exists and the pet
/// was shown or kept hidden, so a bubble or the tray mark lands where it should.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = app
            .state::<BridgeState>()
            .get(&app)
            .and_then(|bridge| bridge.request(None, "startup.check", json!({})));
        let shown = shown(&outcome, tray::is_quitting());
        // Settled for every outcome, so a page loaded after the check ended never reports it again.
        if !app.state::<StartupReport>().settle_for_host() || shown == Shown::Nothing {
            return;
        }
        let published = match shown {
            Shown::Bubble(feedback) => feedback::publish_background(&app, feedback).is_ok(),
            _ => false,
        };
        if !published {
            feedback::notify_host_error(
                &app,
                "host_startup_check_failed",
                code::HOST_STARTUP_CHECK_FAILED,
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_error::HostError;

    #[test]
    fn the_first_to_ask_shows_the_outcome_and_keeps_it() {
        let screen_first = StartupReport::default();
        assert!(screen_first.claim_for_screen());
        // A page loaded again while the check still runs keeps the report: nothing was shown yet.
        assert!(screen_first.claim_for_screen());
        assert!(!screen_first.settle_for_host());

        let host_first = StartupReport::default();
        assert!(host_first.settle_for_host());
        assert!(!host_first.claim_for_screen());
        assert!(!host_first.claim_for_screen());
    }

    #[test]
    fn a_main_page_loaded_again_after_the_check_ended_does_not_report_it_again() {
        let report = StartupReport::default();
        assert!(report.claim_for_screen());
        // The check ends; the page that claimed the report publishes the outcome.
        assert!(!report.settle_for_host());
        // WebView2 reloads the main page (crash recovery, reload): it joins the settled check, but
        // the failure bubble is not published a second time.
        assert!(!report.claim_for_screen());
        assert!(!report.claim_for_screen());
        assert!(!report.settle_for_host());
    }

    #[test]
    fn a_failed_check_shows_the_services_bubble_and_nothing_else_shows_one() {
        let bubble = json!({"id":"a","kind":"error","mode":"input","summary":"x","detail":"y","origin":"background"});
        let failed =
            json!({"kind":"failed","stage":"connection","reason":"r","text":"r","feedback":bubble});
        assert_eq!(shown(&Ok(failed), false), Shown::Bubble(bubble));
        for result in [
            json!({"kind":"firstRun"}),
            json!({"kind":"connected","message":"ok"}),
        ] {
            assert_eq!(shown(&Ok(result), false), Shown::Nothing);
        }
    }

    #[test]
    fn a_check_that_could_not_be_followed_shows_the_hosts_notice() {
        assert_eq!(
            shown(&Err(HostError::new(code::HOST_SERVICE_START_FAILED)), false),
            Shown::Notice
        );
        assert_eq!(
            shown(&Err(HostError::service("INTERNAL", None)), false),
            Shown::Notice
        );
        for odd in [
            json!({"kind":"failed","stage":"connection","reason":"r","text":"r"}),
            json!({"kind":"failed","feedback":"text"}),
            json!({"kind":"other"}),
            json!(null),
        ] {
            assert_eq!(shown(&Ok(odd), false), Shown::Notice);
        }
    }

    #[test]
    fn a_quit_shows_nothing() {
        for code in QUIT_CODES {
            assert_eq!(
                shown(&Err(HostError::service(*code, None)), false),
                Shown::Nothing
            );
        }
        let failed = json!({"kind":"failed","feedback":{"id":"a"}});
        assert_eq!(shown(&Ok(failed), true), Shown::Nothing);
        assert_eq!(
            shown(&Err(HostError::new(code::HOST_SERVICE_STOPPED)), true),
            Shown::Nothing
        );
    }
}
