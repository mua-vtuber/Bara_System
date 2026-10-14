use crate::host_error::{code, HostError};
use serde_json::Value;

pub const METHODS: &[&str] = &[
    "status",
    "settings.get",
    "settings.save",
    "connection.test",
    "startup.check",
    "enrollment.start",
    "enrollment.poll",
    "memory.save",
    "memory.status",
    "memory.search",
    "memory.get",
    "memory.update",
    "assistant.ask",
    "ai.probe",
    "ai.discover",
    "cleanup.run",
    "cleanup.list",
    "cleanup.onSaveStatus",
    "install.local",
    "install.remote",
    "ssh.inspect",
    "backup.export",
    "backup.list",
    "backup.restore",
    "backup.status",
    "backup.join",
    "backup.cancel",
    "selfUpdate.status",
    "selfUpdate.acknowledge",
    "selfUpdate.install",
    "operation.cancel",
];

const MAX_REQUEST_BYTES: usize = 256 * 1024;

pub fn validate_request<'a>(
    label: &str,
    payload: &'a Value,
) -> Result<(&'a str, &'a str, &'a Value), HostError> {
    let invalid = || HostError::new(code::HOST_INVALID_REQUEST);
    if !matches!(label, "main" | "pet" | "quick" | "bubble") {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    let obj = payload.as_object().ok_or_else(invalid)?;
    if obj.len() != 3 {
        return Err(invalid());
    }
    let id = obj.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || id.starts_with(crate::bridge::NATIVE_REQUEST_PREFIX)
    {
        return Err(invalid());
    }
    let method = obj
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let params = obj
        .get("params")
        .filter(|v| v.is_object())
        .ok_or_else(invalid)?;
    const QUICK_METHODS: &[&str] = &[
        "status",
        "settings.get",
        "memory.save",
        "memory.status",
        "memory.search",
        "assistant.ask",
        "operation.cancel",
    ];
    if !METHODS.contains(&method) {
        return Err(invalid());
    }
    /// The pet window reads the app's state and its own update check, and records that the
    /// update notice it asked for showed (spec 5.3).
    const PET_METHODS: &[&str] = &["status", "selfUpdate.status", "selfUpdate.acknowledge"];
    /// The bubble only downloads the update the user agreed to in it (spec 6.1).
    const BUBBLE_METHODS: &[&str] = &["selfUpdate.install"];
    if (label == "pet" && !PET_METHODS.contains(&method))
        || (label == "quick" && !QUICK_METHODS.contains(&method))
        || (label == "bubble" && !BUBBLE_METHODS.contains(&method))
    {
        return Err(HostError::new(code::HOST_WINDOW_NOT_ALLOWED));
    }
    // A webview cancels only requests it started itself, under ids it chose (the check above
    // already refuses a webview id with the `native_` prefix). The host's own `native_` ids,
    // which `Bridge::request` assigns when no id is given, are never sent to a webview, so a
    // `native_`-prefixed `requestId` here is forged: reject it rather than let a webview cancel
    // a request the host started for itself.
    if method == "operation.cancel"
        && params
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|request_id| request_id.starts_with(crate::bridge::NATIVE_REQUEST_PREFIX))
    {
        return Err(invalid());
    }
    if serde_json::to_vec(params).map_err(|_| invalid())?.len() > MAX_REQUEST_BYTES {
        return Err(HostError::new(code::HOST_REQUEST_TOO_LARGE));
    }
    Ok((id, method, params))
}

pub fn validate_dashboard_link(link: &str) -> Result<(), HostError> {
    let invalid = HostError::new(code::HOST_DASHBOARD_LINK_INVALID);
    let url = tauri::Url::parse(link).map_err(|_| invalid.clone())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid);
    }
    let host = url.host_str().ok_or_else(|| invalid.clone())?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1") => Ok(()),
        _ => Err(invalid),
    }
}

/// Checks `open_dashboard`'s inputs: a memory id must be positive and name the connection it
/// belongs to (`audience`), and an audience must have the connection audience's shape.
pub fn validate_dashboard_request(
    memory_id: Option<i64>,
    audience: Option<&str>,
) -> Result<(), HostError> {
    if matches!(memory_id, Some(id) if id <= 0)
        || (memory_id.is_some() && audience.is_none())
        || audience.is_some_and(|value| !crate::feedback::valid_audience(value))
    {
        return Err(HostError::new(code::HOST_INVALID_REQUEST));
    }
    Ok(())
}

/// Filters a service-reported stage against `native-host.json` `contract.progressStages`
/// (the same list as `contracts.ts` `PROGRESS_STAGES`), so the screen only ever learns of a
/// stage this host's contract has named. A stage outside the list -- an alias the service no
/// longer sends, or any future or arbitrary string -- is dropped entirely rather than mapped
/// to a generic fallback, since forwarding an unlisted value would let the child process's own
/// text choose what appears on screen.
pub fn progress_stage(stage: &str) -> Option<String> {
    crate::native_host::is_progress_stage(stage).then(|| stage.to_owned())
}

/// The largest byte count a progress detail may carry: 2^53, the last integer the screen's
/// JavaScript numbers hold exactly.
const PROGRESS_DETAIL_MAX_BYTES: u64 = 1 << 53;

/// Rebuilds a service-reported progress `detail` from its four counts, or `None` when it is
/// anything but an object of exactly `part`, `parts`, `loaded` and `total` as unsigned integers
/// with `1 <= part <= parts <= contract.progressDetailMaxParts` and both byte counts at most
/// 2^53. Only numbers reach the screen; a near miss is dropped rather than repaired, and the
/// stage still goes through without it.
pub fn progress_detail(detail: &Value) -> Option<Value> {
    let fields = detail.as_object()?;
    if fields.len() != 4 {
        return None;
    }
    let count = |name: &str| fields.get(name).and_then(Value::as_u64);
    let (part, parts) = (count("part")?, count("parts")?);
    let (loaded, total) = (count("loaded")?, count("total")?);
    let parts_ok =
        part >= 1 && part <= parts && parts <= crate::native_host::progress_detail_max_parts();
    let bytes_ok = loaded <= PROGRESS_DETAIL_MAX_BYTES && total <= PROGRESS_DETAIL_MAX_BYTES;
    (parts_ok && bytes_ok).then(
        || serde_json::json!({"part": part, "parts": parts, "loaded": loaded, "total": total}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rejection(label: &str, payload: Value) -> String {
        validate_request(label, &payload)
            .unwrap_err()
            .code()
            .to_owned()
    }

    #[test]
    fn pet_cannot_call_write_methods() {
        assert!(validate_request("pet", &json!({"id":"a","method":"status","params":{}})).is_ok());
        assert_eq!(
            rejection("pet", json!({"id":"a","method":"memory.save","params":{}})),
            code::HOST_WINDOW_NOT_ALLOWED
        );
        assert_eq!(
            rejection("foreign", json!({"id":"a","method":"status","params":{}})),
            code::HOST_WINDOW_NOT_ALLOWED
        );
        assert!(validate_request(
            "main",
            &json!({"id":"a","method":"memory.status","params":{"requestId":"receipt"}})
        )
        .is_ok());
        assert!(validate_request(
            "quick",
            &json!({"id":"a","method":"memory.save","params":{}})
        )
        .is_ok());
        assert_eq!(
            rejection(
                "quick",
                json!({"id":"a","method":"settings.save","params":{}})
            ),
            code::HOST_WINDOW_NOT_ALLOWED
        );
        assert_eq!(
            rejection("bubble", json!({"id":"a","method":"status","params":{}})),
            code::HOST_WINDOW_NOT_ALLOWED
        );
    }

    #[test]
    fn only_the_main_window_joins_the_startup_check() {
        let check = json!({"id":"s","method":"startup.check","params":{}});
        assert!(validate_request("main", &check).is_ok());
        for label in ["pet", "quick"] {
            assert_eq!(
                rejection(label, check.clone()),
                code::HOST_WINDOW_NOT_ALLOWED
            );
        }
    }

    #[test]
    fn a_backup_is_started_only_from_the_main_window() {
        let backup = json!({"id":"b","method":"backup.export","params":{}});
        assert!(METHODS.contains(&"backup.export"));
        assert!(validate_request("main", &backup).is_ok());
        for label in ["pet", "quick"] {
            assert_eq!(
                rejection(label, backup.clone()),
                code::HOST_WINDOW_NOT_ALLOWED
            );
        }
    }

    #[test]
    fn a_restore_is_listed_and_started_only_from_the_main_window() {
        for payload in [
            json!({"id":"l","method":"backup.list","params":{}}),
            json!({"id":"r","method":"backup.restore","params":{"id":"0123456789abcdef0123456789abcdef"}}),
        ] {
            assert!(validate_request("main", &payload).is_ok());
            for label in ["pet", "quick"] {
                assert_eq!(
                    rejection(label, payload.clone()),
                    code::HOST_WINDOW_NOT_ALLOWED
                );
            }
        }
    }

    #[test]
    fn a_running_backup_or_restore_is_followed_and_stopped_only_from_the_main_window() {
        for payload in [
            json!({"id":"s","method":"backup.status","params":{}}),
            json!({"id":"j","method":"backup.join","params":{"kind":"restore"}}),
            json!({"id":"c","method":"backup.cancel","params":{"kind":"export"}}),
        ] {
            assert!(validate_request("main", &payload).is_ok());
            for label in ["pet", "quick"] {
                assert_eq!(
                    rejection(label, payload.clone()),
                    code::HOST_WINDOW_NOT_ALLOWED
                );
            }
        }
    }

    #[test]
    fn private_method_cannot_be_invoked() {
        for method in [
            "vault.get",
            "dashboard.link",
            "service.drain",
            "shutdown",
            "__proto__",
        ] {
            assert_eq!(
                rejection("main", json!({"id":"a","method":method,"params":{}})),
                code::HOST_INVALID_REQUEST
            );
        }
        for payload in [
            json!({"id":"a","method":"status","params":{},"host":{}}),
            json!({"id":"bad.id","method":"status","params":{}}),
            json!({"id":"a","method":"status","params":[]}),
            json!({"id":"a","method":7,"params":{}}),
            json!(["a", "status", {}]),
        ] {
            assert_eq!(rejection("main", payload), code::HOST_INVALID_REQUEST);
        }
    }

    #[test]
    fn oversized_request_is_named() {
        let text = "x".repeat(MAX_REQUEST_BYTES);
        assert_eq!(
            rejection(
                "main",
                json!({"id":"a","method":"memory.save","params":{"content":text}})
            ),
            code::HOST_REQUEST_TOO_LARGE
        );
    }

    #[test]
    fn dashboard_url_policy() {
        for url in [
            "http://localhost:1234/#token",
            "http://127.0.0.1:1/",
            "https://example.com/",
        ] {
            assert!(validate_dashboard_link(url).is_ok(), "{url}");
        }
        for url in [
            "file:///C:/x",
            "javascript:alert(1)",
            "http://example.com",
            "https://u:p@example.com",
            "not a url",
        ] {
            assert_eq!(
                validate_dashboard_link(url).unwrap_err(),
                HostError::new(code::HOST_DASHBOARD_LINK_INVALID),
                "{url}"
            );
        }
    }

    #[test]
    fn native_request_prefix_is_rejected_from_a_webview() {
        assert_eq!(
            rejection(
                "main",
                json!({"id":"native_1","method":"status","params":{}})
            ),
            code::HOST_INVALID_REQUEST
        );
        assert_eq!(
            rejection(
                "main",
                json!({
                    "id":"a",
                    "method":"operation.cancel",
                    "params":{"requestId":"native_1"}
                })
            ),
            code::HOST_INVALID_REQUEST
        );
        // A non-prefixed requestId, and requestId-shaped fields on other methods, are untouched.
        assert!(validate_request(
            "main",
            &json!({
                "id":"a",
                "method":"operation.cancel",
                "params":{"requestId":"receipt"}
            })
        )
        .is_ok());
    }

    #[test]
    fn dashboard_request_needs_a_positive_id_with_a_valid_audience() {
        let audience = r#"{"mode":"local","origin":"http://127.0.0.1:3001","ssh":null}"#;
        assert!(validate_dashboard_request(None, None).is_ok());
        assert!(validate_dashboard_request(None, Some(audience)).is_ok());
        assert!(validate_dashboard_request(Some(7), Some(audience)).is_ok());
        for (memory_id, audience) in [
            (Some(0), Some(audience)),
            (Some(-3), Some(audience)),
            (Some(7), None),
            (Some(7), Some("not json")),
            (
                None,
                Some(r#"{"mode":"cloud","origin":"https://x","ssh":null}"#),
            ),
            (None, Some("")),
        ] {
            assert_eq!(
                validate_dashboard_request(memory_id, audience).unwrap_err(),
                HostError::new(code::HOST_INVALID_REQUEST),
                "{memory_id:?} {audience:?}"
            );
        }
    }

    /// The current format (`contracts.ts` `connectionAudience`, tagged with
    /// `contract.connectionAudienceVersion`) and the untagged format before it are both accepted;
    /// another version or a mixed shape is not.
    #[test]
    fn dashboard_request_accepts_the_current_and_the_untagged_audience_format() {
        let v = crate::native_host::connection_audience_version();
        let remote = format!(
            r#"{{"v":{v},"mode":"remote","host":"a.example.org","fingerprint":"SHA256:abc","serverPort":3001}}"#
        );
        let remote_unpinned = format!(
            r#"{{"v":{v},"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":3001}}"#
        );
        let local =
            format!(r#"{{"v":{v},"mode":"local","origin":"http://127.0.0.1:3001","ssh":null}}"#);
        let untagged_remote = r#"{"mode":"remote","origin":"http://127.0.0.1:41001","ssh":{"host":"a.example.org","port":22,"user":"ubuntu","keyPath":"C:\\key","serverPort":3001}}"#;
        for audience in [
            remote.as_str(),
            remote_unpinned.as_str(),
            local.as_str(),
            untagged_remote,
        ] {
            assert!(
                validate_dashboard_request(Some(7), Some(audience)).is_ok(),
                "{audience}"
            );
        }
        let other_version = format!(
            r#"{{"v":{},"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":3001}}"#,
            v + 1
        );
        let extra_key = format!(
            r#"{{"v":{v},"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":3001,"user":"ubuntu"}}"#
        );
        let host_shape_not_remote = format!(
            r#"{{"v":{v},"mode":"local","host":"a.example.org","fingerprint":null,"serverPort":3001}}"#
        );
        let bad_server_port = format!(
            r#"{{"v":{v},"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":0}}"#
        );
        let untagged_with_host =
            r#"{"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":3001}"#;
        for audience in [
            other_version.as_str(),
            extra_key.as_str(),
            host_shape_not_remote.as_str(),
            bad_server_port.as_str(),
            untagged_with_host,
        ] {
            assert_eq!(
                validate_dashboard_request(Some(7), Some(audience)).unwrap_err(),
                HostError::new(code::HOST_INVALID_REQUEST),
                "{audience}"
            );
        }
    }

    #[test]
    fn progress_stage_passes_listed_stages_and_blocks_arbitrary_values() {
        for stage in [
            "prepare",
            "models",
            "server",
            "service",
            "cleanup",
            "update-backup",
            "restore-verify",
            "restore-data",
            "restore-switch",
        ] {
            assert_eq!(progress_stage(stage).as_deref(), Some(stage));
        }
        assert_eq!(progress_stage("restore"), None);
        // Only the exact name passes: the update gate's stage is not a prefix rule.
        assert_eq!(progress_stage("update"), None);
        assert_eq!(progress_stage("update-backup "), None);
        assert_eq!(progress_stage("secret=/path/token"), None);
        assert_eq!(progress_stage("starting"), None);
        assert_eq!(progress_stage(""), None);
    }

    #[test]
    fn progress_detail_passes_exactly_four_bounded_counts() {
        let detail = json!({"part": 2, "parts": 5, "loaded": 312_000_000u64, "total": 0});
        assert_eq!(progress_detail(&detail), Some(detail.clone()));
        let edge = json!({"part": 10, "parts": 10, "loaded": 1u64 << 53, "total": 1u64 << 53});
        assert_eq!(progress_detail(&edge), Some(edge.clone()));
        assert_eq!(
            progress_detail(&json!({"part": 1, "parts": 1, "loaded": 0, "total": 0})),
            Some(json!({"part": 1, "parts": 1, "loaded": 0, "total": 0}))
        );
    }

    #[test]
    fn progress_detail_drops_every_other_shape() {
        for detail in [
            json!(null),
            json!("2/5"),
            json!([2, 5, 1, 1]),
            json!({}),
            json!({"part": 2, "parts": 5, "loaded": 1}),
            json!({"part": 2, "parts": 5, "loaded": 1, "total": 1, "label": "x"}),
            json!({"part": 2, "parts": 5, "loaded": 1, "size": 1}),
            json!({"part": 0, "parts": 5, "loaded": 1, "total": 1}),
            json!({"part": 6, "parts": 5, "loaded": 1, "total": 1}),
            json!({"part": 1, "parts": 11, "loaded": 1, "total": 1}),
            json!({"part": -1, "parts": 5, "loaded": 1, "total": 1}),
            json!({"part": 1.5, "parts": 5, "loaded": 1, "total": 1}),
            json!({"part": 1, "parts": 5, "loaded": 1.0, "total": 1}),
            json!({"part": "1", "parts": 5, "loaded": 1, "total": 1}),
            json!({"part": 1, "parts": 5, "loaded": (1u64 << 53) + 1, "total": 1}),
            json!({"part": 1, "parts": 5, "loaded": 1, "total": u64::MAX}),
        ] {
            assert_eq!(progress_detail(&detail), None, "{detail}");
        }
    }

    #[test]
    fn only_the_pet_and_the_bubble_reach_their_own_update_methods() {
        for method in ["selfUpdate.status", "selfUpdate.acknowledge"] {
            let payload = json!({"id":"u","method":method,"params":{}});
            assert!(validate_request("pet", &payload).is_ok(), "{method}");
            assert!(validate_request("main", &payload).is_ok(), "{method}");
            for label in ["quick", "bubble"] {
                assert_eq!(
                    rejection(label, payload.clone()),
                    code::HOST_WINDOW_NOT_ALLOWED,
                    "{label} {method}"
                );
            }
        }
        let install = json!({"id":"i","method":"selfUpdate.install","params":{"version":"0.1.9"}});
        assert!(validate_request("bubble", &install).is_ok());
        assert!(validate_request("main", &install).is_ok());
        for label in ["pet", "quick"] {
            assert_eq!(
                rejection(label, install.clone()),
                code::HOST_WINDOW_NOT_ALLOWED
            );
        }
        assert_eq!(
            rejection(
                "bubble",
                json!({"id":"c","method":"operation.cancel","params":{"requestId":"i"}})
            ),
            code::HOST_WINDOW_NOT_ALLOWED
        );
    }
}
