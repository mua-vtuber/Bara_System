mod audience;
mod mask;

use crate::host_error::{code, HostError};
use crate::overlay;
pub(crate) use audience::valid_audience;
pub(crate) use mask::mask_sensitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Mutex, thread, time::Duration};
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

fn pet_visible(app: &AppHandle) -> bool {
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
struct Store {
    current: Option<Feedback>,
    last_answer: Option<Feedback>,
    /// A background result that arrived while the pet was hidden, shown by "최근 결과". Kept
    /// apart from `current` so a bubble already on screen keeps the result its buttons refer to.
    held: Option<Feedback>,
    generation: u64,
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
    fn should_hide(&self, generation: u64) -> bool {
        self.generation == generation
    }
}

#[derive(Default)]
pub struct FeedbackState {
    inner: Mutex<Store>,
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
    let mut store = state.inner.lock().map_err(lock_failed)?;
    let (feedback, generation) = store.present(feedback);
    let bubble = app
        .get_webview_window("bubble")
        .ok_or(HostError::new(code::HOST_WINDOW_MISSING))?;
    app.emit("pet-feedback", feedback.clone())
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    overlay::position_near_pet(app, "bubble")?;
    bubble
        .show()
        .map_err(|_| HostError::new(code::HOST_WINDOW_OPERATION_FAILED))?;
    drop(store);
    if let Some(delay) = duration(feedback.kind) {
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
    Ok(())
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
/// last answer. Shared by the pet's command and the tray's "최근 결과".
pub fn show_last(app: &AppHandle) -> Result<(), HostError> {
    let state = app.state::<FeedbackState>();
    let mut store = state.inner.lock().map_err(lock_failed)?;
    let feedback = store
        .held
        .take()
        .or_else(|| store.current.clone())
        .or_else(|| store.last_answer.clone())
        .ok_or(HostError::new(code::HOST_FEEDBACK_UNAVAILABLE))?;
    drop(store);
    crate::tray::set_attention(app, false);
    show(app, feedback)
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_hidden_pet_only_pops_up_results_the_user_asked_for() {
        assert!(shows_bubble(None, false));
        assert!(shows_bubble(Some(Origin::User), false));
        assert!(!shows_bubble(Some(Origin::Background), false));
        for origin in [None, Some(Origin::User), Some(Origin::Background)] {
            assert!(shows_bubble(origin, true));
        }
    }

    #[test]
    fn origin_is_optional_and_limited_to_user_or_background() {
        let base = json!({"id":"s","kind":"error","mode":"input","summary":"x","detail":"x"});
        assert_eq!(parse_feedback(base.clone()).unwrap().origin, None);
        for (value, expected) in [("user", Origin::User), ("background", Origin::Background)] {
            let mut feedback = base.clone();
            feedback["origin"] = json!(value);
            assert_eq!(parse_feedback(feedback).unwrap().origin, Some(expected));
        }
        let mut unknown = base;
        unknown["origin"] = json!("ai");
        assert!(parse_feedback(unknown).is_err());
    }
    #[test]
    fn feedback_keeps_plain_urls_and_rejects_structurally_invalid_shapes() {
        let audience = r#"{"mode":"existing","origin":"https://example.com","ssh":null}"#;
        let valid = json!({"id":"a_1","kind":"answer","mode":"question","summary":"링크 https://github.com/openai/codex",
            "detail":"문서 https://example.com/docs 를 저장했어요","sources":[{"id":1,"content":"https://example.com/docs"}],"generated":true,
            "audience":audience,"answerOutcome":"found"});
        let parsed = parse_feedback(valid).unwrap();
        assert!(parsed.summary.contains("https://github.com/openai/codex"));
        assert!(parsed.detail.contains("https://example.com/docs"));

        for value in [
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x","memoryId":1}),
            json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":"x","sources":[{"id":1,"content":"x"}],"answerOutcome":"found"}),
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x","memoryId":1,"audience":"x"}),
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x","memoryId":1,"audience":"a".repeat(4097)}),
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x","memoryId":1,
                "audience":r#"{"mode":"existing","origin":"https://example.com","ssh":null,"token":"secret"}"#}),
            json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":"x","action":{"url":"https://example.com"},"answerOutcome":"found"}),
            json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":"x","sources":[{"id":0,"content":"x"}],"answerOutcome":"found"}),
            json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":"x","sequence":null,"answerOutcome":"found"}),
            json!({"id":"a","kind":"answer","mode":"question","summary":" ","detail":"x","answerOutcome":"found"}),
            json!({"id":"a","kind":"answer","mode":"input","summary":"x","detail":"x","answerOutcome":"found"}),
            json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":"x","sources":vec![json!({"id":1,"content":"x"});11],"answerOutcome":"found"}),
        ] {
            assert!(parse_feedback(value).is_err());
        }
    }

    /// PN-3: boundary cases the screen's own masking (`feedback-model.ts` `safeFeedbackText`)
    /// already lets through must not turn a confirmed save into a rejected feedback here; the
    /// content is masked instead of the whole feedback being rejected. Structural rejects
    /// (audience, id, size, sequence) are unaffected, see the test above.
    #[test]
    fn boundary_credential_shapes_are_masked_not_rejected() {
        let mask = "[인증정보 생략]";
        for (detail, expect_masked) in [
            ("trailing Bearer ", true),
            ("api_key= with no value", true),
            ("scheme missing ://user@host here", true),
            ("ssh://git@github.com/openai/codex", true),
            ("https://example.com/#bara-token=secret", true),
            ("https://example.com/?access_token=secret", true),
            ("Bearer token", true),
            ("https://u:p@example.com", true),
        ] {
            let parsed = parse_feedback(
                json!({"id":"a","kind":"answer","mode":"question","summary":"x","detail":detail,"answerOutcome":"found"}),
            )
            .unwrap_or_else(|error| panic!("expected Ok for {detail:?}, got {error}"));
            assert!(
                expect_masked == parsed.detail.contains(mask),
                "detail {detail:?} -> {:?}",
                parsed.detail
            );
        }
    }

    /// PFIX-3 Medium 2: every content field is masked, not only `detail`.
    #[test]
    fn summary_and_source_contents_are_masked_too() {
        let audience = r#"{"mode":"existing","origin":"https://example.com","ssh":null}"#;
        let parsed = parse_feedback(json!({"id":"a","kind":"answer","mode":"question",
            "summary":"키는\napi_key = s3cret 이에요","detail":"x",
            "sources":[{"id":1,"content":"Bearer\n\nabc123 끝"},{"id":2,"content":"https://h.example/?token=t 링크"}],
            "audience":audience,"answerOutcome":"found"}))
        .unwrap();
        assert_eq!(parsed.summary, "키는\n[인증정보 생략] 이에요");
        let sources = parsed.sources.unwrap();
        assert_eq!(sources[0].content, "[인증정보 생략] 끝");
        assert_eq!(sources[1].content, "[인증정보 생략] 링크");
    }

    /// A save the server confirmed whose AI classification failed carries
    /// `classificationFailureReason` (`feedback-model.ts` `savedFeedback`). The host must accept it
    /// and hand it to the bubble unchanged; `deny_unknown_fields` still turns away anything else.
    #[test]
    fn saved_feedback_with_classification_failure_reason_round_trips() {
        let audience = r#"{"mode":"existing","origin":"https://example.com","ssh":null}"#;
        let reason = "저장은 완료됐지만 분류에 실패했습니다: AI 서버에 연결할 수 없습니다.";
        let saved = json!({"id":"a_1","kind":"saved","mode":"input","summary":reason,"detail":"x",
            "memoryId":7,"requestId":"r_1","audience":audience,"classificationFailureReason":reason});
        let parsed = parse_feedback(saved).expect("a saved feedback with a failure reason parses");
        let emitted = serde_json::to_value(&parsed).unwrap();
        assert_eq!(emitted["classificationFailureReason"], json!(reason));

        let plain = parse_feedback(
            json!({"id":"a_2","kind":"saved","mode":"input","summary":"저장했어요","detail":"x"}),
        )
        .unwrap();
        assert!(serde_json::to_value(&plain)
            .unwrap()
            .get("classificationFailureReason")
            .is_none());

        let with_unknown = json!({"id":"a_3","kind":"saved","mode":"input","summary":reason,"detail":"x",
            "classificationFailureReason":reason,"unexpected":true});
        assert!(parse_feedback(with_unknown).is_err());
    }

    /// The failure reason is a content field like `summary`: masked, and bounded to the summary's
    /// length, so it cannot carry what the other content fields may not.
    #[test]
    fn classification_failure_reason_is_masked_and_bounded_like_summary() {
        let masked = parse_feedback(
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x",
            "classificationFailureReason":"분류 실패: api_key = s3cret 이에요"}),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&masked).unwrap()["classificationFailureReason"],
            json!("분류 실패: [인증정보 생략] 이에요")
        );

        let longest = "a".repeat(SUMMARY_MAX_BYTES);
        assert!(parse_feedback(
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x",
            "classificationFailureReason":longest})
        )
        .is_ok());
        let too_long = "a".repeat(SUMMARY_MAX_BYTES + 1);
        assert!(parse_feedback(
            json!({"id":"a","kind":"saved","mode":"input","summary":"x","detail":"x",
            "classificationFailureReason":too_long})
        )
        .is_err());
    }

    /// `answerOutcome` is decided where the answer is built; the host takes each listed value as it
    /// comes and hands it on unchanged, also when a stored answer is shown again (`Store::present`).
    #[test]
    fn answer_feedback_with_each_listed_outcome_is_accepted_and_kept() {
        for outcome in ["found", "notFound", "aiFailed"] {
            let parsed = parse_feedback(
                json!({"id":"a_1","kind":"answer","mode":"question","summary":"x","detail":"x",
                "answerOutcome":outcome}),
            )
            .unwrap_or_else(|error| panic!("expected Ok for {outcome}, got {error}"));
            assert_eq!(
                serde_json::to_value(&parsed).unwrap()["answerOutcome"],
                json!(outcome)
            );
            let mut store = Store::default();
            store.present(parsed);
            let again = serde_json::to_value(store.last_answer.as_ref().unwrap()).unwrap();
            assert_eq!(again["answerOutcome"], json!(outcome));
        }
    }

    /// An `answer` without a listed outcome is a contract violation and is rejected, never guessed:
    /// missing, empty, wrongly spelled, padded, or not a string.
    #[test]
    fn answer_feedback_without_a_listed_outcome_is_rejected() {
        let answer =
            json!({"id":"a_1","kind":"answer","mode":"question","summary":"x","detail":"x"});
        assert!(parse_feedback(answer.clone()).is_err());
        for bad in [
            json!(null),
            json!(""),
            json!("Found"),
            json!("found "),
            json!("not_found"),
            json!("success"),
            json!(1),
            json!(true),
        ] {
            let mut value = answer.clone();
            value["answerOutcome"] = bad.clone();
            assert!(parse_feedback(value).is_err(), "{bad}");
        }
    }

    /// Only an `answer` has an outcome; any other kind that carries one is rejected.
    #[test]
    fn a_feedback_that_is_not_an_answer_cannot_carry_an_outcome() {
        for (kind, mode) in [
            ("working", "input"),
            ("working", "question"),
            ("saved", "input"),
            ("error", "input"),
            ("error", "question"),
        ] {
            let plain = json!({"id":"a_1","kind":kind,"mode":mode,"summary":"x","detail":"x"});
            assert!(parse_feedback(plain.clone()).is_ok(), "{kind}/{mode}");
            for outcome in ["found", "notFound", "aiFailed"] {
                let mut value = plain.clone();
                value["answerOutcome"] = json!(outcome);
                assert!(
                    parse_feedback(value).is_err(),
                    "{kind}/{mode} with {outcome}"
                );
            }
        }
    }

    #[test]
    fn old_timer_cannot_hide_new_feedback() {
        let mut store = Store::default();
        let first = parse_feedback(
            json!({"id":"one","kind":"saved","mode":"input","summary":"Saved","detail":"x"}),
        )
        .unwrap();
        let second = parse_feedback(
            json!({"id":"two","kind":"answer","mode":"question","summary":"Answer","detail":"y","answerOutcome":"notFound"}),
        )
        .unwrap();
        let (first, old) = store.present(first);
        let (second, newest) = store.present(second);
        assert_eq!(first.sequence, Some(old));
        assert_eq!(second.sequence, Some(newest));
        assert!(!store.should_hide(old));
        assert!(store.should_hide(newest));
        store.invalidate();
        assert!(!store.should_hide(newest));
        assert_eq!(store.last_answer.as_ref().unwrap().id, "two");
    }
}
