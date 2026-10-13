use super::contains_sensitive;
use serde_json::{Map, Value};

/// Accepts exactly the two shapes `contracts.ts` `connectionAudience` has produced: the current,
/// version-tagged format and the untagged format written before it (still held by stored
/// receipts and deep links). Both are identities only, never credentials. It refuses what the
/// service refuses (`audienceMatches`): see the remote-mode notes on the two format checks below.
pub(crate) fn valid_audience(value: &str) -> bool {
    if value.is_empty() || value.len() > 4096 || contains_sensitive(value) {
        return false;
    }
    let Ok(decoded) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    let Some(parts) = decoded.as_object() else {
        return false;
    };
    match parts.get("v") {
        None => valid_untagged(parts),
        Some(version)
            if version.as_u64() == Some(crate::native_host::connection_audience_version()) =>
        {
            valid_tagged(parts)
        }
        Some(_) => false,
    }
}

/// `{"mode","origin","ssh"}`: the format used before the version tag. A remote one is accepted
/// only with its SSH settings: the service reads such a value back as the remote server those
/// settings name (`contracts.ts` `legacyAudienceConnection`), and never accepts one without them.
fn valid_untagged(parts: &Map<String, Value>) -> bool {
    has_exactly(parts, &["mode", "origin", "ssh"])
        && valid_mode(parts)
        && valid_origin(parts)
        && parts.get("ssh").is_some_and(valid_ssh_or_null)
        && (!is_remote(parts) || parts.get("ssh").is_some_and(Value::is_object))
}

/// A remote server's identity `{"v","mode":"remote","host","fingerprint","serverPort"}`, or an
/// address identity `{"v","mode","origin","ssh"}` for a local or existing connection. The address
/// identity of a remote connection is refused: `connectionAudience` writes the host identity for
/// every remote connection with SSH settings, and `validateConnection` lets none through without
/// them, so the service never produces that value and `audienceMatches` never accepts it.
fn valid_tagged(parts: &Map<String, Value>) -> bool {
    if parts.contains_key("host") {
        return has_exactly(parts, &["v", "mode", "host", "fingerprint", "serverPort"])
            && is_remote(parts)
            && parts.get("host").is_some_and(valid_text)
            && parts
                .get("fingerprint")
                .is_some_and(|fingerprint| fingerprint.is_null() || valid_text(fingerprint))
            && parts.get("serverPort").is_some_and(valid_port);
    }
    has_exactly(parts, &["v", "mode", "origin", "ssh"])
        && valid_mode(parts)
        && !is_remote(parts)
        && valid_origin(parts)
        && parts.get("ssh").is_some_and(valid_ssh_or_null)
}

fn is_remote(parts: &Map<String, Value>) -> bool {
    parts.get("mode").and_then(Value::as_str) == Some("remote")
}

fn has_exactly(parts: &Map<String, Value>, keys: &[&str]) -> bool {
    parts.len() == keys.len() && keys.iter().all(|key| parts.contains_key(*key))
}

fn valid_mode(parts: &Map<String, Value>) -> bool {
    matches!(
        parts.get("mode").and_then(Value::as_str),
        Some("local" | "remote" | "existing")
    )
}

fn valid_origin(parts: &Map<String, Value>) -> bool {
    parts
        .get("origin")
        .and_then(Value::as_str)
        .is_some_and(|origin| !origin.is_empty() && origin.len() <= 2048)
}

fn valid_text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.len() <= 1024 && !contains_sensitive(text))
}

fn valid_port(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|port| (1..=65535).contains(&port))
}

fn valid_ssh_or_null(ssh: &Value) -> bool {
    if ssh.is_null() {
        return true;
    }
    let Some(ssh) = ssh.as_object() else {
        return false;
    };
    if !["host", "port", "user", "keyPath"]
        .iter()
        .all(|key| ssh.contains_key(*key))
    {
        return false;
    }
    ssh.iter().all(|(key, value)| match key.as_str() {
        "port" | "serverPort" => valid_port(value),
        "host" | "user" | "keyPath" | "fingerprint" | "serverPath" => valid_text(value),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FINGERPRINT: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn version() -> u64 {
        crate::native_host::connection_audience_version()
    }

    fn ssh() -> Value {
        json!({"host":"a.example.org","port":22,"user":"ubuntu","keyPath":r"C:\keys\a",
            "fingerprint":FINGERPRINT,"serverPort":3001})
    }

    /// The remote server's identity, byte for byte what `connectionAudience` writes.
    fn remote_identity() -> Value {
        json!({"v":version(),"mode":"remote","host":"a.example.org","fingerprint":FINGERPRINT,"serverPort":3001})
    }

    fn accepted(value: Value) -> bool {
        valid_audience(&value.to_string())
    }

    #[test]
    fn the_current_identities_are_accepted() {
        assert!(accepted(remote_identity()));
        assert!(accepted(
            json!({"v":version(),"mode":"remote","host":"a.example.org","fingerprint":null,"serverPort":3001})
        ));
        assert!(accepted(
            json!({"v":version(),"mode":"local","origin":"http://127.0.0.1:3001","ssh":null})
        ));
        assert!(accepted(
            json!({"v":version(),"mode":"existing","origin":"http://127.0.0.1:41005","ssh":ssh()})
        ));
    }

    #[test]
    fn the_untagged_identities_of_stored_receipts_are_accepted() {
        assert!(accepted(
            json!({"mode":"local","origin":"http://127.0.0.1:3001","ssh":null})
        ));
        assert!(accepted(
            json!({"mode":"existing","origin":"http://127.0.0.1:41005","ssh":ssh()})
        ));
        // A remote connection written before the tag always carried its SSH settings.
        assert!(accepted(
            json!({"mode":"remote","origin":"http://127.0.0.1:41001","ssh":ssh()})
        ));
    }

    #[test]
    fn an_address_identity_in_remote_mode_is_refused() {
        // The service writes a remote connection's identity as host + fingerprint + server port and
        // never lets a remote connection through without SSH settings, so these name nothing it
        // can have produced (`src/shared/audience-shape.test.ts` pins the service side).
        assert!(!accepted(
            json!({"v":version(),"mode":"remote","origin":"http://127.0.0.1:41001","ssh":ssh()})
        ));
        assert!(!accepted(
            json!({"v":version(),"mode":"remote","origin":"http://127.0.0.1:41001","ssh":null})
        ));
        assert!(!accepted(
            json!({"mode":"remote","origin":"http://127.0.0.1:41001","ssh":null})
        ));
        // The same addresses are fine in the other modes.
        assert!(accepted(
            json!({"v":version(),"mode":"local","origin":"http://127.0.0.1:41001","ssh":null})
        ));
    }

    #[test]
    fn malformed_identities_are_refused() {
        let mut other_version = remote_identity();
        other_version["v"] = json!(version() + 1);
        let mut local_host_identity = remote_identity();
        local_host_identity["mode"] = json!("local");
        let mut port_zero = remote_identity();
        port_zero["serverPort"] = json!(0);
        let mut extra_key = remote_identity();
        extra_key["token"] = json!("x");
        let mut no_host = remote_identity();
        no_host.as_object_mut().unwrap().remove("host");
        for value in [
            other_version,
            local_host_identity,
            port_zero,
            extra_key,
            no_host,
            json!({"mode":"cloud","origin":"http://127.0.0.1:3001","ssh":null}),
            json!({"mode":"local","origin":"","ssh":null}),
            json!({"mode":"local","origin":"http://127.0.0.1:3001"}),
            json!([]),
        ] {
            assert!(!accepted(value.clone()), "{value}");
        }
        for text in ["", "not json", "null"] {
            assert!(!valid_audience(text), "{text}");
        }
        assert!(!valid_audience(&"a".repeat(4097)));
        assert!(!accepted(
            json!({"v":version(),"mode":"remote","host":"bearer abc","fingerprint":null,"serverPort":3001})
        ));
    }
}
