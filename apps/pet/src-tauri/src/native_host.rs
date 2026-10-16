//! The text the host draws by itself, before or outside the screen: the tray menu, the
//! startup-error dialog, and the product title used as a dialog caption. The single source
//! is `src/shared/native-host.json` (`text`), embedded at build time so the host never reads
//! a file at runtime; `src/ui/messages.ts` (`messages.nativeHost`) re-exports the same values
//! for anything the screen itself needs to show.

use serde::Deserialize;
use std::{collections::HashMap, sync::LazyLock, time::Duration};

use crate::host_error::{code, HostError};

const RAW: &str = include_str!("../../src/shared/native-host.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    contract: Contract,
    text: Text,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contract {
    progress_stages: Vec<String>,
    /// The most download parts a progress `detail` may name (`policy::progress_detail`); the
    /// service's parser (`src/service/install/progress-line.ts`) holds lines to the same bound.
    progress_detail_max_parts: u64,
    /// What an `answer` feedback says about how the answer came out (`contracts.ts`
    /// `ANSWER_OUTCOMES`); `feedback::parse_feedback` accepts no other value.
    answer_outcomes: Vec<String>,
    /// The `HostError` codes the screen may receive; the host only checks in its tests that this
    /// list equals `code::ALL`. Declared because `deny_unknown_fields` refuses an unknown key.
    #[cfg_attr(not(test), allow(dead_code))]
    host_error_codes: Vec<String>,
    /// How often the service sends `{"event":"alive"}` while it has work in progress. The service
    /// reads it; the host only checks in its tests that `service_silence_limit_ms` covers it.
    #[cfg_attr(not(test), allow(dead_code))]
    service_heartbeat_ms: u64,
    /// How long the host lets a waiting request go without any line from the service before it
    /// stops the service as unresponsive.
    service_silence_limit_ms: u64,
    /// How long the host's quit lets the service finish running work before it is cancelled
    /// (`service.drain`); the service reads the same value.
    service_drain_ms: u64,
    sensitive_markers: Vec<String>,
    /// URL query parameter names whose value is a credential (`?token=...`).
    sensitive_query_keys: Vec<String>,
    /// The `v` tag of the current connection audience format (`contracts.ts`
    /// `CONNECTION_AUDIENCE_VERSION`); an audience without a tag is the older format.
    connection_audience_version: u64,
    /// The event the host sends the pet window when the quick input opens (`true`) or closes
    /// (`false`); the screen listens by the same name (`src/ui/bridge.ts` `onQuickVisibility`).
    quick_visibility_event: String,
    /// The event the host sends the pet window when the pet is shown (`true`) or hidden
    /// (`false`), so the character stops drawing while hidden (`src/ui/bridge.ts`
    /// `onPetVisibility`). WebView2 keeps a hidden window's page "visible" to scripts.
    pet_visibility_event: String,
    /// The event the host sends the `main` window when a tray command fails, carrying the
    /// `HostError`; the screen turns it into text (`src/ui/bridge.ts` `onTrayError`).
    tray_error_event: String,
    /// The folder under the user's Documents that holds backups (`bridge::backup_root`); the
    /// screen names it in its result line, so the name lives here rather than in Rust.
    backup_folder_name: String,
    /// The folder under the pet data folder the service downloads its own installer into
    /// (`src/shared/self-update.ts`); `self_update::verified_installer` runs only a file in it.
    updates_dir_name: String,
    /// The ending of the one installer name a release carries (spec 5.2); the host runs no other file.
    installer_suffix: String,
    /// The event the host sends when the bubble's update phase changes (`update_bubble.rs`); the
    /// bubble listens by the same name (`src/ui/bridge.ts` `onUpdateBubble`).
    update_bubble_event: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Text {
    product_title: String,
    tray: Tray,
    ssh_key_picker: SshKeyPicker,
    startup: HashMap<String, String>,
    /// A `{status}`-templated suffix appended to a startup error's text when the error
    /// carries an OS error number, so that number never appears via a Rust format literal.
    startup_status_suffix: String,
    /// Korean text for a bubble the host itself raises outside any webview request (a position
    /// save or read failure), keyed by the `HostError` code that triggers it.
    host_notice: HashMap<String, String>,
    feedback_mask: FeedbackMask,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeedbackMask {
    /// The screen's text for a link it drops (`src/ui/feedback-model.ts`); the host masks only
    /// credentials, so it reads this one only in its tests.
    #[cfg_attr(not(test), allow(dead_code))]
    omitted_link: String,
    omitted_credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SshKeyPicker {
    title: String,
    filter: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tray {
    status: String,
    status_attention: String,
    status_quitting: String,
    input: String,
    search: String,
    dashboard: String,
    settings: String,
    guide: String,
    recent_result: String,
    hide_pet: String,
    show_pet: String,
    quit: String,
}

static CATALOG: LazyLock<Result<Catalog, String>> =
    LazyLock::new(|| serde_json::from_str::<Catalog>(RAW).map_err(|error| error.to_string()));

/// Confirms the embedded catalog parses and that every `startup` key is a known host code.
/// Call once at process start, before anything reads [`product_title`] or [`tray`]: a build
/// whose JSON and `host_error::code::ALL` drifted apart fails here instead of showing a blank
/// or missing label at runtime.
pub fn init() -> Result<(), HostError> {
    let catalog = CATALOG.as_ref().map_err(|_| {
        // The serde error may quote catalog text; only the code crosses the IPC-adjacent
        // dialog boundary here too, consistent with every other HostError.
        HostError::new(code::HOST_TEXT_CATALOG_INVALID)
    })?;
    let known: std::collections::HashSet<&str> = code::ALL.iter().copied().collect();
    if catalog
        .text
        .startup
        .keys()
        .any(|key| !known.contains(key.as_str()))
        || catalog
            .text
            .host_notice
            .keys()
            .any(|key| !known.contains(key.as_str()))
    {
        return Err(HostError::new(code::HOST_TEXT_CATALOG_INVALID));
    }
    Ok(())
}

fn catalog() -> &'static Catalog {
    // `init()` runs first in `main()` and returns early on failure, so by the time any of
    // these are called the catalog is known to have parsed.
    CATALOG
        .as_ref()
        .expect("native_host::init() must succeed before the catalog is read")
}

/// The product title (`text.productTitle`). When the catalog failed to parse, no host text exists
/// at all, so it names the package instead (`Cargo.toml` `name`, a build-time value rather than
/// text of this file's own) and the dialog body shows the error code ([`startup_text`]); the
/// panic hook calls this before `init()` is known to have succeeded, so it must never panic.
pub fn product_title() -> &'static str {
    CATALOG
        .as_ref()
        .map(|catalog| catalog.text.product_title.as_str())
        .unwrap_or(env!("CARGO_PKG_NAME"))
}

pub struct TrayLabels {
    pub status: &'static str,
    pub status_attention: &'static str,
    pub status_quitting: &'static str,
    pub input: &'static str,
    pub search: &'static str,
    pub dashboard: &'static str,
    pub settings: &'static str,
    pub guide: &'static str,
    pub recent_result: &'static str,
    pub hide_pet: &'static str,
    pub show_pet: &'static str,
    pub quit: &'static str,
}

pub fn tray_labels() -> TrayLabels {
    let tray = &catalog().text.tray;
    TrayLabels {
        status: &tray.status,
        status_attention: &tray.status_attention,
        status_quitting: &tray.status_quitting,
        input: &tray.input,
        search: &tray.search,
        dashboard: &tray.dashboard,
        settings: &tray.settings,
        guide: &tray.guide,
        recent_result: &tray.recent_result,
        hide_pet: &tray.hide_pet,
        show_pet: &tray.show_pet,
        quit: &tray.quit,
    }
}

pub struct SshKeyPickerLabels {
    pub title: &'static str,
    pub filter: &'static str,
}

/// The window title and file-type filter for the key-picker dialog (`windows::ssh::choose_key_file`),
/// owned here so the Korean text is never a literal in the process-launching Rust code.
pub fn ssh_key_picker_labels() -> SshKeyPickerLabels {
    let picker = &catalog().text.ssh_key_picker;
    SshKeyPickerLabels {
        title: &picker.title,
        filter: &picker.filter,
    }
}

/// Whether `stage` is one of `contract.progressStages` -- the only stages the host forwards to
/// the screen (`policy::progress_stage`). Falls back to rejecting everything when the catalog
/// failed to parse, the same fail-closed behavior as every other catalog reader here.
pub fn is_progress_stage(stage: &str) -> bool {
    CATALOG
        .as_ref()
        .map(|catalog| catalog.contract.progress_stages.iter().any(|s| s == stage))
        .unwrap_or(false)
}

/// `contract.progressDetailMaxParts`, or 0 when the catalog failed to parse, which lets no
/// progress detail through (fail-closed like [`is_progress_stage`]).
pub fn progress_detail_max_parts() -> u64 {
    CATALOG
        .as_ref()
        .map(|catalog| catalog.contract.progress_detail_max_parts)
        .unwrap_or(0)
}

/// Whether `outcome` is one of `contract.answerOutcomes` -- the only values an `answer` feedback may
/// carry in `answerOutcome` (`feedback::parse_feedback`). Rejects everything when the catalog
/// failed to parse, the same fail-closed behavior as [`is_progress_stage`].
pub fn is_answer_outcome(outcome: &str) -> bool {
    CATALOG
        .as_ref()
        .map(|catalog| {
            catalog
                .contract
                .answer_outcomes
                .iter()
                .any(|o| o == outcome)
        })
        .unwrap_or(false)
}

/// The Korean text for a startup-failure code, or the code itself when the catalog has none for
/// it, or failed to parse at all (the panic hook calls this before `init()` is known to have
/// succeeded, so this must never panic itself).
pub fn startup_text(error_code: &str) -> &str {
    CATALOG
        .as_ref()
        .ok()
        .and_then(|catalog| catalog.text.startup.get(error_code))
        .map(String::as_str)
        .unwrap_or(error_code)
}

/// Appends the OS error number to a startup-error body using the JSON-owned suffix template
/// (`text.startupStatusSuffix`), so the number's surrounding words are never a Rust literal.
/// Falls back to a plain space-separated number if the catalog failed to parse.
pub fn append_status(body: &mut String, status: i64) {
    match CATALOG.as_ref() {
        Ok(catalog) => body.push_str(
            &catalog
                .text
                .startup_status_suffix
                .replace("{status}", &status.to_string()),
        ),
        Err(_) => body.push_str(&format!(" {status}")),
    }
}

/// Korean text for a host-raised bubble (`text.hostNotice`), keyed by the `HostError` code that
/// triggers it (`code::HOST_POSITION_SAVE_FAILED`, `code::HOST_POSITION_READ_FAILED`). Falls back
/// to the bare code, the same fail-closed behavior as [`startup_text`].
pub fn host_notice_text(error_code: &str) -> &str {
    CATALOG
        .as_ref()
        .ok()
        .and_then(|catalog| catalog.text.host_notice.get(error_code))
        .map(String::as_str)
        .unwrap_or(error_code)
}

pub struct FeedbackMaskLabels {
    pub omitted_credential: &'static str,
}

/// The mask text `feedback::mask::mask_sensitive` substitutes in place of a matched fragment
/// (`text.feedbackMask`), the same values `src/ui/messages.ts` re-exports for the screen side.
pub fn feedback_mask_labels() -> FeedbackMaskLabels {
    let mask = &catalog().text.feedback_mask;
    FeedbackMaskLabels {
        omitted_credential: &mask.omitted_credential,
    }
}

/// The markers a word of feedback content is checked against (`contract.sensitiveMarkers`),
/// e.g. `bara-token=`, so the list lives in one place instead of a Rust literal.
pub fn sensitive_markers() -> &'static [String] {
    &catalog().contract.sensitive_markers
}

/// The URL query parameter names that mark a link in feedback content as carrying a credential
/// (`contract.sensitiveQueryKeys`), e.g. `token` in `https://host/?token=...`.
pub fn sensitive_query_keys() -> &'static [String] {
    &catalog().contract.sensitive_query_keys
}

/// The `v` tag a current-format connection audience carries (`contract.connectionAudienceVersion`).
pub fn connection_audience_version() -> u64 {
    catalog().contract.connection_audience_version
}

/// The event name the pet window receives when the quick input opens or closes
/// (`contract.quickVisibilityEvent`); the payload is a boolean, `true` while the input is open.
pub fn quick_visibility_event() -> &'static str {
    &catalog().contract.quick_visibility_event
}

/// The event name the pet window receives when the pet is shown or hidden
/// (`contract.petVisibilityEvent`); the payload is a boolean, `true` while the pet is on screen.
pub fn pet_visibility_event() -> &'static str {
    &catalog().contract.pet_visibility_event
}

/// The event name the `main` window receives when a tray command fails
/// (`contract.trayErrorEvent`); the payload is the serialized `HostError`.
pub fn tray_error_event() -> &'static str {
    &catalog().contract.tray_error_event
}

/// The event name the bubble receives when its update phase changes (`contract.updateBubbleEvent`);
/// the payload is `{ phase, version, sequence }` (`update_bubble.rs`).
pub fn update_bubble_event() -> &'static str {
    &catalog().contract.update_bubble_event
}

/// The folder under the pet data folder that holds the downloaded installer
/// (`contract.updatesDirName`); `self_update::verified_installer` runs nothing outside it.
pub fn updates_dir_name() -> &'static str {
    &catalog().contract.updates_dir_name
}

/// The ending of the release installer's name (`contract.installerSuffix`).
pub fn installer_suffix() -> &'static str {
    &catalog().contract.installer_suffix
}

/// The backup folder's name under Documents (`contract.backupFolderName`).
pub fn backup_folder_name() -> &'static str {
    &catalog().contract.backup_folder_name
}

/// How long a waiting request may go without any line from the service
/// (`contract.serviceSilenceLimitMs`). The service owns every per-operation time limit; the host
/// only watches that the service is still alive (`contract.serviceHeartbeatMs`).
pub fn service_silence_limit() -> Duration {
    Duration::from_millis(catalog().contract.service_silence_limit_ms)
}

/// How long a quit lets running work finish (`contract.serviceDrainMs`).
pub fn service_drain() -> Duration {
    Duration::from_millis(catalog().contract.service_drain_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        path::{Path, PathBuf},
    };

    #[test]
    fn embedded_catalog_parses() {
        assert!(CATALOG.is_ok(), "{:?}", CATALOG.as_ref().err());
    }

    #[test]
    fn contract_codes_match_host_error_list() {
        let catalog = catalog();
        let json_set: BTreeSet<&str> = catalog
            .contract
            .host_error_codes
            .iter()
            .map(String::as_str)
            .collect();
        let native_set: BTreeSet<&str> = code::ALL.iter().copied().collect();
        assert_eq!(json_set, native_set);
    }

    #[test]
    fn progress_stages_are_not_empty_and_known() {
        let catalog = catalog();
        assert!(!catalog.contract.progress_stages.is_empty());
        for stage in &catalog.contract.progress_stages {
            assert!(is_progress_stage(stage), "{stage}");
        }
        assert!(!is_progress_stage("starting"));
        assert!(!is_progress_stage(""));
    }

    #[test]
    fn answer_outcomes_are_not_empty_and_known() {
        let catalog = catalog();
        assert!(!catalog.contract.answer_outcomes.is_empty());
        for outcome in &catalog.contract.answer_outcomes {
            assert!(is_answer_outcome(outcome), "{outcome}");
        }
        assert!(!is_answer_outcome("found "));
        assert!(!is_answer_outcome("Found"));
        assert!(!is_answer_outcome("success"));
        assert!(!is_answer_outcome(""));
    }

    #[test]
    fn tray_and_startup_labels_are_not_empty() {
        let tray = tray_labels();
        let picker = ssh_key_picker_labels();
        for label in [
            tray.status,
            tray.status_attention,
            tray.status_quitting,
            tray.input,
            tray.search,
            tray.dashboard,
            tray.settings,
            tray.guide,
            tray.recent_result,
            tray.hide_pet,
            tray.show_pet,
            tray.quit,
            product_title(),
            picker.title,
            picker.filter,
        ] {
            assert!(!label.is_empty());
        }
        assert!(!catalog().text.startup.is_empty());
        for text in catalog().text.startup.values() {
            assert!(!text.is_empty());
        }
    }

    #[test]
    fn every_startup_key_is_a_known_host_code() {
        let known: BTreeSet<&str> = code::ALL.iter().copied().collect();
        for key in catalog().text.startup.keys() {
            assert!(known.contains(key.as_str()), "unknown startup code: {key}");
        }
        assert!(init().is_ok());
    }

    #[test]
    fn startup_text_falls_back_to_the_code_when_missing() {
        assert_eq!(startup_text("HOST_NOT_A_REAL_CODE"), "HOST_NOT_A_REAL_CODE");
    }

    #[test]
    fn host_notice_text_falls_back_to_the_code_when_missing() {
        assert_eq!(
            host_notice_text("HOST_NOT_A_REAL_CODE"),
            "HOST_NOT_A_REAL_CODE"
        );
        assert!(!host_notice_text(code::HOST_POSITION_SAVE_FAILED).is_empty());
        assert!(!host_notice_text(code::HOST_POSITION_READ_FAILED).is_empty());
    }

    #[test]
    fn feedback_mask_labels_and_sensitive_markers_are_not_empty() {
        assert!(!catalog().text.feedback_mask.omitted_link.is_empty());
        assert!(!feedback_mask_labels().omitted_credential.is_empty());
        assert!(!sensitive_markers().is_empty());
        assert!(!sensitive_query_keys().is_empty());
    }

    #[test]
    fn window_events_are_valid_distinct_tauri_event_names() {
        let events = [
            quick_visibility_event(),
            pet_visibility_event(),
            tray_error_event(),
            update_bubble_event(),
        ];
        for event in events {
            assert!(!event.is_empty());
            assert!(
                event
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "{event}"
            );
        }
        let distinct: std::collections::HashSet<_> = events.iter().collect();
        assert_eq!(distinct.len(), events.len());
    }

    #[test]
    fn backup_folder_name_is_one_plain_path_component() {
        let name = backup_folder_name();
        assert!(!name.trim().is_empty());
        assert_eq!(
            name,
            name.trim(),
            "Windows drops a trailing space from a folder name"
        );
        assert!(
            !name.ends_with('.')
                && !name
                    .chars()
                    .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c)),
            "{name}"
        );
        assert!(!matches!(name, "." | ".."));
        assert_eq!(Path::new(name).components().count(), 1);
    }

    #[test]
    fn self_update_contract_values_are_plain() {
        let contract = &catalog().contract;
        assert_eq!(
            Path::new(&contract.updates_dir_name).components().count(),
            1
        );
        assert!(!contract.updates_dir_name.trim().is_empty());
        assert!(
            contract.installer_suffix.starts_with('_')
                && contract.installer_suffix.ends_with(".exe")
        );
        assert!(!contract.update_bubble_event.is_empty());
    }

    #[test]
    fn silence_limit_allows_several_missed_heartbeats() {
        let contract = &catalog().contract;
        assert!(contract.service_heartbeat_ms > 0);
        assert!(contract.service_drain_ms > 0);
        assert!(
            contract.service_silence_limit_ms >= 3 * contract.service_heartbeat_ms,
            "a silence limit under three heartbeats stops a healthy service after one late beat"
        );
        assert_eq!(
            service_silence_limit(),
            Duration::from_millis(contract.service_silence_limit_ms)
        );
    }

    #[test]
    fn every_host_notice_key_is_a_known_host_code() {
        let known: BTreeSet<&str> = code::ALL.iter().copied().collect();
        for key in catalog().text.host_notice.keys() {
            assert!(
                known.contains(key.as_str()),
                "unknown host notice code: {key}"
            );
        }
    }

    #[test]
    fn product_title_and_status_suffix_come_from_the_catalog() {
        assert_eq!(product_title(), catalog().text.product_title);
        let template = &catalog().text.startup_status_suffix;
        assert!(template.contains("{status}"), "{template}");
        let mut body = String::from("본문");
        append_status(&mut body, 5);
        assert_eq!(body, format!("본문{}", template.replace("{status}", "5")));
    }

    fn is_hangul(c: char) -> bool {
        matches!(c, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7A3}')
    }

    /// The 1-based lines of `source` that ship in the binary and hold text the host would show a
    /// user on its own: Korean (that text lives in `native-host.json`) or the English product
    /// name that used to be a fallback caption here. Comment lines, an inline `mod tests { .. }`
    /// and everything after it are skipped; a `#[cfg(test)] mod tests;` declaration only points
    /// at a separate test file, which the walk below leaves out by name.
    fn text_literal_lines(source: &str) -> Vec<usize> {
        let lines: Vec<&str> = source.lines().collect();
        let mut hits = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            let inline_tests = trimmed == "#[cfg(test)]"
                && lines
                    .get(index + 1)
                    .is_some_and(|next| next.trim_start().starts_with("mod tests {"));
            if inline_tests {
                break;
            }
            if trimmed.starts_with("//") {
                continue;
            }
            if line.chars().any(is_hangul) || line.to_ascii_lowercase().contains("bara pet") {
                hits.push(index + 1);
            }
        }
        hits
    }

    fn rust_sources(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("src folder is readable") {
            let path = entry.expect("src entry is readable").path();
            if path.is_dir() {
                rust_sources(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && path.file_name().is_some_and(|name| name != "tests.rs")
            {
                found.push(path);
            }
        }
    }

    #[test]
    fn the_text_literal_scan_flags_korean_and_the_product_name_but_not_comments_or_tests() {
        let source = "fn a() -> &'static str { \"바라\" }\n\
            // 한글 주석\n\
            fn b() -> &'static str { \"Bara Pet\" }\n\
            /// Bara Pet in a doc comment\n\
            fn c() {}\n\
            #[cfg(test)]\n\
            mod tests;\n\
            fn d() -> &'static str { \"BARA PET\" }\n\
            #[cfg(test)]\n\
            mod tests {\n\
                const T: &str = \"한글\";\n\
            }\n";
        assert_eq!(text_literal_lines(source), vec![1, 3, 8]);
    }

    #[test]
    fn shipped_rust_code_holds_no_korean_or_product_name_literal() {
        let mut files = Vec::new();
        rust_sources(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        assert!(files.len() >= 10, "the source walk found {files:?}");
        let offenders: Vec<String> = files
            .iter()
            .flat_map(|path| {
                let source = std::fs::read_to_string(path).expect("source file is UTF-8");
                text_literal_lines(&source)
                    .into_iter()
                    .map(|line| format!("{}:{line}", path.display()))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "user-visible text belongs in src/shared/native-host.json: {offenders:?}"
        );
    }
}
