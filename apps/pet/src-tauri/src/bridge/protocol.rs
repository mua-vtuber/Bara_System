use crate::host_error::{code, HostError};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::BufRead,
    sync::{mpsc, Mutex},
};

const MAX_LINE: usize = 1024 * 1024;
const MAX_SERVICE_MESSAGE: usize = 1_000;
pub type Pending = Mutex<HashMap<String, mpsc::Sender<Result<Value, HostError>>>>;

pub fn read_line_bounded<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if out.is_empty() {
                Ok(None)
            } else {
                Ok(Some(out))
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if out.len() + count > MAX_LINE {
            return Err(std::io::Error::other("Protocol line too long"));
        }
        let done = available[count - 1] == b'\n';
        out.extend_from_slice(&available[..count]);
        reader.consume(count);
        if done {
            return Ok(Some(out));
        }
    }
}

fn safe_service_code(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.starts_with(|c: char| c.is_ascii_uppercase())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.starts_with(code::HOST_PREFIX)
}

fn safe_service_message(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    !(value.len() > MAX_SERVICE_MESSAGE
        || lower.contains("bearer ")
        || lower.contains("bara-token=")
        || lower.contains("-----begin")
        || lower.contains("://") && lower.contains('@'))
}

/// Keeps a service error's code and public text apart. An error whose code or text fails the
/// safety checks is replaced as a whole by the host's redaction code.
fn service_error(error: &Value) -> HostError {
    let redacted = HostError::new(code::HOST_SERVICE_ERROR_REDACTED);
    let Some(service_code) = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| safe_service_code(value))
    else {
        return redacted;
    };
    match error.get("message") {
        None | Some(Value::Null) => HostError::service(service_code, None),
        Some(Value::String(message)) if message.is_empty() => {
            HostError::service(service_code, None)
        }
        Some(Value::String(message)) if safe_service_message(message) => {
            HostError::service(service_code, Some(message.clone()))
        }
        Some(_) => redacted,
    }
}

pub fn dispatch_response(pending: &Pending, frame: &Value) -> bool {
    let Some(id) = frame.get("id").and_then(Value::as_str) else {
        return false;
    };
    let outcome = if let Some(error) = frame.get("error") {
        Err(service_error(error))
    } else if let Some(result) = frame.get("result") {
        Ok(result.clone())
    } else {
        return false;
    };
    let Ok(mut pending) = pending.lock() else {
        return false;
    };
    if let Some(sender) = pending.remove(id) {
        let _ = sender.send(outcome);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_line_is_bounded() {
        assert_eq!(
            read_line_bounded(&mut &b"{\"id\":\"1\"}\n"[..])
                .unwrap()
                .unwrap(),
            b"{\"id\":\"1\"}\n"
        );
        let long = vec![b'x'; MAX_LINE + 1];
        assert!(read_line_bounded(&mut &long[..]).is_err());
    }

    #[test]
    fn replies_route_by_id_out_of_order_and_errors_propagate() {
        let pending = Pending::new(HashMap::new());
        let (a_tx, a_rx) = mpsc::channel();
        let (b_tx, b_rx) = mpsc::channel();
        pending.lock().unwrap().insert("a".into(), a_tx);
        pending.lock().unwrap().insert("b".into(), b_tx);
        assert!(dispatch_response(
            &pending,
            &json!({"id":"b","result":{"saved":true}})
        ));
        assert!(dispatch_response(
            &pending,
            &json!({"id":"a","error":{"code":"FAILED","message":"retry"}})
        ));
        assert_eq!(b_rx.recv().unwrap().unwrap(), json!({"saved":true}));
        assert_eq!(
            a_rx.recv().unwrap().unwrap_err(),
            HostError::service("FAILED", Some("retry".into()))
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    fn outcome(error: Value) -> Result<Value, HostError> {
        let pending = Pending::new(HashMap::new());
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert("a".into(), tx);
        assert!(dispatch_response(
            &pending,
            &json!({"id":"a","error":error})
        ));
        rx.recv().unwrap()
    }

    #[test]
    fn service_error_keeps_code_and_public_text_apart() {
        let error = outcome(json!({"code":"INVALID_INPUT","message":"검색어를 확인해 주세요."}))
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({"code":"INVALID_INPUT","message":"검색어를 확인해 주세요."})
        );
        for message in [json!(null), json!("")] {
            assert_eq!(
                serde_json::to_value(
                    outcome(json!({"code":"EDIT_CONFLICT","message":message})).unwrap_err()
                )
                .unwrap(),
                json!({"code":"EDIT_CONFLICT"})
            );
        }
        assert_eq!(
            outcome(json!({"code":"EDIT_CONFLICT"})).unwrap_err(),
            HostError::service("EDIT_CONFLICT", None)
        );
    }

    #[test]
    fn token_bearing_error_is_not_forwarded() {
        let redacted = HostError::new(code::HOST_SERVICE_ERROR_REDACTED);
        for error in [
            json!({"code":"FAILED","message":"Bearer secret-token"}),
            json!({"code":"FAILED","message":"see https://user:pass@example.com"}),
            json!({"code":"FAILED","message":"x".repeat(MAX_SERVICE_MESSAGE + 1)}),
            json!({"code":"FAILED","message":{"text":"nested"}}),
            json!({"code":"lower_case","message":"retry"}),
            json!({"code":"HOST_TASK_FAILED","message":"spoofed host code"}),
            json!({"message":"no code"}),
            json!("SERVICE_ERROR: flat string"),
        ] {
            assert_eq!(outcome(error.clone()).unwrap_err(), redacted, "{error}");
        }
        assert_eq!(
            serde_json::to_value(&redacted).unwrap(),
            json!({"code":"HOST_SERVICE_ERROR_REDACTED"})
        );
    }
}
