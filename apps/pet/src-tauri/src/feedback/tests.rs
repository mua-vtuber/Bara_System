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
    let answer = json!({"id":"a_1","kind":"answer","mode":"question","summary":"x","detail":"x"});
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

/// Ruling F1: "최근 결과" during a running download shows the download again and leaves the
/// held result in place; once the download is over, the held result comes back.
#[test]
fn recent_result_during_a_download_keeps_the_held_result() {
    let mut store = Store {
        held: Some(
            parse_feedback(
                json!({"id":"held","kind":"saved","mode":"input","summary":"Saved","detail":"x"}),
            )
            .unwrap(),
        ),
        update: Some(UpdateBubble {
            phase: crate::update_bubble::UpdatePhase::Busy,
            version: "0.1.9".into(),
        }),
        ..Store::default()
    };
    assert!(matches!(store.recall(), Some(Recall::Download)));
    assert_eq!(
        store.held.as_ref().map(|held| held.id.as_str()),
        Some("held")
    );

    store.update = None;
    assert!(matches!(store.recall(), Some(Recall::Result(feedback)) if feedback.id == "held"));
    assert!(store.held.is_none());
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
