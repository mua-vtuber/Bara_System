mod audience;
mod mask;

use crate::host_error::{code, HostError};
use crate::overlay;
use crate::update_bubble::{self, UpdateBubble};
pub(crate) use audience::valid_audience;
pub(crate) use mask::mask_sensitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::{Mutex, MutexGuard},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// The longest `summary` the bubble accepts, in bytes. `classificationFailureReason` repeats the
/// summary on the screen side (`feedback-model.ts` `savedFeedback`), so it shares this limit.
const SUMMARY_MAX_BYTES: usize = 240;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Working,
    Saved,
    Answer,
    Error,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: u64,
    content: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feedback {
    id: String,
    kind: Kind,
    mode: Mode,
    summary: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sources: Option<Vec<Source>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audience: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence: Option<u64>,
    /// Set by the screen on a `saved` feedback whose classification step failed
    /// (`feedback-model.ts` `savedFeedback`); handed on to the bubble unchanged apart from masking.
    #[serde(skip_serializing_if = "Option::is_none")]
    classification_failure_reason: Option<String>,
    /// How an `answer` came out (`contract.answerOutcomes`: `found`, `notFound`, `aiFailed`),
    /// decided where the answer is built (`assistant.ts`) and carried by `feedback-model.ts`
    /// `answerFeedback`. Required on an `answer`, absent on every other kind (`answer_outcome_is_valid`).
    #[serde(skip_serializing_if = "Option::is_none")]
    answer_outcome: Option<String>,
    /// Who started the work this result belongs to, set where it starts (never read from an AI
    /// answer or a server message). Absent means the user did.
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
}

/// `user`: the user asked for this (a save, a question, a tray command). `background`: the app
/// did it by itself (the startup check, a position restore).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Origin {
    User,
    Background,
}

/// While the pet is hidden only results the user asked for pop up a bubble; a background result
/// waits in "최근 결과" and marks the tray status instead. With the pet shown every result
/// shows as before.
fn shows_bubble(origin: Option<Origin>, pet_visible: bool) -> bool {
    pet_visible || origin != Some(Origin::Background)
}

pub(crate) fn pet_visible(app: &AppHandle) -> bool {
    app.get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok())
        .unwrap_or(true)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Input,
    Question,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether `value` carries a credential-shaped fragment: a `Bearer ` pair, one of
/// `contract.sensitiveMarkers` (`bara-token=`, `access_token=`, `api_key=`), a PEM private-key
/// header, or a `scheme://user@host` authority. Used for structural fields that are still
/// rejected outright (`audience`, and formerly a feedback's content fields); a feedback's content
/// fields now mask these fragments instead (`mask::mask_sensitive`) rather than rejecting the
/// whole feedback, see PN-3 in the audit-fix plan.
pub(crate) fn contains_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("bearer ")
        || lower.contains("bara-token=")
        || lower.contains("access_token=")
        || lower.contains("api_key=")
        || lower.contains("-----begin")
    {
        return true;
    }
    for (index, _) in lower.match_indices("://") {
        let authority = lower[index + 3..]
            .split(|c: char| c.is_whitespace() || "/?#)]}>,;".contains(c))
            .next()
            .unwrap_or("");
        if authority.contains('@') {
            return true;
        }
    }
    false
}

/// An `answer` must say how it came out, and no other kind may carry that value. The value is
/// decided where the answer is built, so a missing, foreign or unknown one is a contract violation
/// the host turns away; it is never guessed from the text or the sources.
fn answer_outcome_is_valid(kind: Kind, outcome: Option<&str>) -> bool {
    match (kind, outcome) {
        (Kind::Answer, Some(outcome)) => crate::native_host::is_answer_outcome(outcome),
        (Kind::Answer, None) => false,
        (_, None) => true,
        (_, Some(_)) => false,
    }
}

fn parse_feedback(value: Value) -> Result<Feedback, String> {
    if value
        .as_object()
        .is_some_and(|object| object.contains_key("sequence"))
    {
        return Err("Feedback sequence is native-owned".into());
    }
    if serde_json::to_vec(&value)
        .map_err(|_| "Invalid feedback")?
        .len()
        > 100_000
    {
        return Err("Feedback is too large".into());
    }
    let mut feedback: Feedback =
        serde_json::from_value(value).map_err(|_| "Invalid feedback shape")?;
    if !valid_id(&feedback.id)
        || feedback.sequence.is_some()
        || feedback.summary.trim().is_empty()
        || feedback.summary.len() > SUMMARY_MAX_BYTES
        || feedback
            .classification_failure_reason
            .as_deref()
            .is_some_and(|reason| reason.len() > SUMMARY_MAX_BYTES)
        || feedback.detail.len() > 30_000
        || !answer_outcome_is_valid(feedback.kind, feedback.answer_outcome.as_deref())
        || matches!(
            (feedback.kind, feedback.mode),
            (Kind::Saved, Mode::Question) | (Kind::Answer, Mode::Input)
        )
        || feedback
            .request_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
        || feedback.memory_id.is_some_and(|id| id == 0)
        || feedback
            .audience
            .as_deref()
            .is_some_and(|audience| !valid_audience(audience))
        || ((feedback.kind == Kind::Saved && feedback.memory_id.is_some())
            || (feedback.kind == Kind::Answer
                && feedback
                    .sources
                    .as_ref()
                    .is_some_and(|sources| !sources.is_empty())))
            && feedback.audience.is_none()
        || feedback.sources.as_ref().is_some_and(|items| {
            items.len() > 10
                || items
                    .iter()
                    .any(|item| item.id == 0 || item.content.len() > 10_000)
        })
    {
        return Err("Feedback contains unsupported content".into());
    }
    // Structural checks above reject; content fields are masked instead (PN-3) so a save the
    // server already confirmed still reaches the bubble with the sensitive part hidden.
    feedback.summary = mask_sensitive(&feedback.summary);
    feedback.detail = mask_sensitive(&feedback.detail);
    if let Some(reason) = feedback.classification_failure_reason.as_mut() {
        *reason = mask_sensitive(reason);
    }
    if let Some(sources) = feedback.sources.as_mut() {
        for source in sources {
            source.content = mask_sensitive(&source.content);
        }
    }
    Ok(feedback)
}

#[derive(Default)]
pub(crate) struct Store {
    current: Option<Feedback>,
    last_answer: Option<Feedback>,
    /// A background result that arrived while the pet was hidden, or a result that arrived while
    /// an update downloads (`update_bubble.rs`), shown by "최근 결과". Kept apart from `current`
    /// so a bubble already on screen keeps the result its buttons refer to.
    held: Option<Feedback>,
    generation: u64,
    /// The bubble's update phase (`update_bubble.rs`); `None` when the bubble shows results.
    pub(crate) update: Option<UpdateBubble>,
}

/// What "최근 결과" brings back (`show_last`).
enum Recall {
    /// The running download's progress bubble; a held result keeps waiting until it ends.
    Download,
    Result(Box<Feedback>),
}

impl Store {
    fn present(&mut self, mut feedback: Feedback) -> (Feedback, u64) {
        self.generation = self.generation.wrapping_add(1);
        feedback.sequence = Some(self.generation);
        if feedback.kind == Kind::Answer {
            self.last_answer = Some(feedback.clone());
        }
        self.current = Some(feedback.clone());
        (feedback, self.generation)
    }
    fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
    /// The next value of the counter results are numbered with: an update event takes it, which
    /// also stops any earlier hide timer.
    pub(crate) fn next_sequence(&mut self) -> u64 {
        self.invalidate();
        self.generation
    }
    fn should_hide(&self, generation: u64) -> bool {
        self.generation == generation
    }
    /// While an update downloads, "최근 결과" shows the download again and leaves a held result
    /// where it is (it would only be held again); otherwise the held result first, then the
    /// current one, then the last answer.
    fn recall(&mut self) -> Option<Recall> {
        if update_bubble::holds_feedback(self.update.as_ref()) {
            return Some(Recall::Download);
        }
        self.held
            .take()
            .or_else(|| self.current.clone())
            .or_else(|| self.last_answer.clone())
            .map(|feedback| Recall::Result(Box::new(feedback)))
    }
}

#[derive(Default)]
pub struct FeedbackState {
    inner: Mutex<Store>,
}

impl FeedbackState {
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Store>, HostError> {
        self.inner.lock().map_err(lock_failed)
    }
}

fn duration(kind: Kind) -> Option<Duration> {
    match kind {
        Kind::Working => None,
        Kind::Saved => Some(Duration::from_secs(8)),
        Kind::Answer => Some(Duration::from_secs(15)),
        Kind::Error => Some(Duration::from_secs(12)),
    }
}

fn lock_failed<T>(_: T) -> HostError {
    HostError::new(code::HOST_STATE_LOCK_FAILED)
}

fn present(app: &AppHandle, feedback: Feedback) -> Result<(), HostError> {
    if !shows_bubble(feedback.origin, pet_visible(app)) {
        let state = app.state::<FeedbackState>();
        state.inner.lock().map_err(lock_failed)?.held = Some(feedback);
        crate::tray::set_attention(app, true);
        return Ok(());
    }
    show(app, feedback)
}

fn show(app: &AppHandle, feedback: Feedback) -> Result<(), HostError> {
    let state = app.state::<FeedbackState>();
    let mut store = state.lock()?;
    if update_bubble::holds_feedback(store.update.as_ref()) {
        // An update downloading or starting keeps the bubble (spec 6.1); the result waits in
        // "최근 결과" like a background result while the pet is hidden.
        store.held = Some(feedback);
        drop(store);
        crate::tray::set_attention(app, true);
        return Ok(());
    }
    // A result takes the bubble from an update notice, question or failure (spec 6.1); the update
    // starts again from the pet's update button.
    store.update = None;
    let (feedback, generation) = store.present(feedback);
    let bubble = bubble_window(app)?;
    app.emit("pet-feedback", feedback.clone())
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    overlay::position_near_pet(app, "bubble")?;
    bubble
        .show()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    drop(store);
    if let Some(delay) = duration(feedback.kind) {
        hide_later(app, generation, delay);
    }
    Ok(())
}

pub(crate) fn bubble_window(app: &AppHandle) -> Result<WebviewWindow, HostError> {
    app.get_webview_window("bubble")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))
}

/// Shows the bubble next to the pet, or next to the quick input while it is open.
pub(crate) fn reveal(app: &AppHandle) -> Result<(), HostError> {
    let bubble = bubble_window(app)?;
    overlay::position_near_pet(app, "bubble")?;
    bubble
        .show()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))
}

/// Hides the bubble after `delay` unless something newer was shown, or it was dismissed, meanwhile
/// (`generation` is the counter value it was shown with).
pub(crate) fn hide_later(app: &AppHandle, generation: u64, delay: Duration) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(delay);
        let state = app.state::<FeedbackState>();
        if let Ok(store) = state.inner.lock() {
            if store.should_hide(generation) {
                if let Some(bubble) = app.get_webview_window("bubble") {
                    let _ = bubble.hide();
                }
            }
        };
    });
}

#[tauri::command]
pub fn publish_feedback(
    window: WebviewWindow,
    app: AppHandle,
    feedback: Value,
) -> Result<(), HostError> {
    if !matches!(window.label(), "quick" | "main") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let feedback =
        parse_feedback(feedback).map_err(|_| HostError::new(code::HOST_INVALID_REQUEST))?;
    present(&app, feedback)
}

#[tauri::command]
pub fn get_feedback(
    window: WebviewWindow,
    state: State<'_, FeedbackState>,
) -> Result<Option<Feedback>, HostError> {
    if !matches!(window.label(), "bubble" | "main" | "pet") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    Ok(state.inner.lock().map_err(lock_failed)?.current.clone())
}

#[tauri::command]
pub fn get_last_answer(
    window: WebviewWindow,
    state: State<'_, FeedbackState>,
) -> Result<Option<Feedback>, HostError> {
    if window.label() != "main" {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    Ok(state.inner.lock().map_err(lock_failed)?.last_answer.clone())
}

#[tauri::command]
pub fn dismiss_feedback(window: WebviewWindow, app: AppHandle) -> Result<(), HostError> {
    if !matches!(window.label(), "bubble" | "main" | "pet") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let state = app.state::<FeedbackState>();
    let mut store = state.inner.lock().map_err(lock_failed)?;
    store.invalidate();
    // Closing the bubble during an update's download only hides it: the download goes on and the
    // pet's update button shows it again (spec 6.1). Any other update bubble ends here.
    if !update_bubble::holds_feedback(store.update.as_ref()) {
        store.update = None;
    }
    app.get_webview_window("bubble")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?
        .hide()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    if window.label() == "bubble" {
        // The bubble cannot take focus, so its close button does not emit a blur.
        overlay::dismiss_quick(&app)?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_feedback(
    window: WebviewWindow,
    app: AppHandle,
    id: Option<String>,
) -> Result<(), HostError> {
    if !matches!(window.label(), "bubble" | "main" | "pet") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    if id.as_deref().is_some_and(|value| !valid_id(value)) {
        return Err(HostError::new(code::HOST_INVALID_REQUEST));
    }
    let state = app.state::<FeedbackState>();
    let mut store = state.inner.lock().map_err(lock_failed)?;
    let selected = [store.current.as_ref(), store.last_answer.as_ref()]
        .into_iter()
        .flatten()
        .find(|feedback| id.as_deref().is_none_or(|target| feedback.id == target))
        .cloned()
        .ok_or(HostError::new(code::HOST_FEEDBACK_UNAVAILABLE))?;
    store.current = Some(selected);
    store.invalidate();
    let _ = app
        .get_webview_window("bubble")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?
        .hide();
    drop(store);
    crate::panel::show(&app)?
        .emit("pet-panel", "result")
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))
}

#[tauri::command]
pub fn show_last_feedback(window: WebviewWindow, app: AppHandle) -> Result<(), HostError> {
    if !matches!(window.label(), "pet" | "main") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    show_last(&app)
}

/// Shows the latest result again in the bubble, because the user asked for it: a background
/// result held while the pet was hidden first, then the current one (a save, an error), then the
/// last answer. While an update downloads it shows the download's progress instead and keeps a
/// held result (and the tray mark) for later (`Store::recall`). Shared by the pet's command and
/// the tray's "최근 결과".
pub fn show_last(app: &AppHandle) -> Result<(), HostError> {
    let state = app.state::<FeedbackState>();
    let recalled = state
        .lock()?
        .recall()
        .ok_or(HostError::new(code::HOST_FEEDBACK_UNAVAILABLE))?;
    match recalled {
        Recall::Download => reveal(app),
        Recall::Result(feedback) => {
            crate::tray::set_attention(app, false);
            show(app, *feedback)
        }
    }
}

/// Presents a host-raised notice bubble (a position save/read failure) without going through
/// `parse_feedback`'s webview-input validation: the id and text come from the host itself, not
/// an untrusted request. `kind` is always `Error`, so it needs no `audience`/`memoryId`.
fn host_notice(id: &str, host_error_code: &str, origin: Origin) -> Feedback {
    let text = crate::native_host::host_notice_text(host_error_code).to_string();
    Feedback {
        id: id.to_string(),
        kind: Kind::Error,
        mode: Mode::Input,
        summary: text.clone(),
        detail: text,
        memory_id: None,
        sources: None,
        generated: None,
        request_id: None,
        audience: None,
        sequence: None,
        classification_failure_reason: None,
        answer_outcome: None,
        origin: Some(origin),
    }
}

/// A notice the host raises by itself (a position restore at startup): held in "최근 결과"
/// rather than popped up while the pet is hidden.
pub fn notify_host_error(app: &AppHandle, id: &str, host_error_code: &str) {
    let _ = present(app, host_notice(id, host_error_code, Origin::Background));
}

/// Shows a bubble the service made for work the app did by itself (the startup check's failure,
/// `startup.rs`), checked and masked like a bubble from a webview and always marked `background`.
pub fn publish_background(app: &AppHandle, feedback: Value) -> Result<(), HostError> {
    let mut feedback =
        parse_feedback(feedback).map_err(|_| HostError::new(code::HOST_INVALID_REQUEST))?;
    feedback.origin = Some(Origin::Background);
    present(app, feedback)
}

/// A notice about something the user just did (a tray command), shown even with the pet hidden.
pub fn notify_user_host_error(app: &AppHandle, id: &str, host_error_code: &str) {
    let _ = present(app, host_notice(id, host_error_code, Origin::User));
}

#[cfg(test)]
mod tests;
