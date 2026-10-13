//! Masks sensitive fragments out of a feedback content field (summary, detail, a source's
//! content) instead of rejecting the whole feedback, so a save the server already confirmed
//! still reaches the bubble -- with the sensitive part hidden -- rather than turning into an
//! error (PN-3). Structural validation (id, kind, size, audience, sequence) still rejects; see
//! `feedback::parse_feedback` and `audience::contains_sensitive`.
//!
//! Masking is at least as strict as the rejection it replaced (`feedback::contains_sensitive`):
//! whatever that check found is gone from the masked text. Words are split on any whitespace
//! (line breaks, tabs, runs of spaces), and the whitespace outside a masked span stays as it
//! was, so the rest of the text reads the same.

use crate::native_host;
use std::ops::Range;

/// The word that introduces an HTTP bearer credential; the word after it is the credential.
const BEARER: &str = "bearer";
/// PEM armor, compared against ASCII-lowercased text. Everything from a `-----BEGIN` line to the
/// dashes closing its `-----END ...-----` line is key material.
const PEM_BEGIN: &str = "-----begin";
const PEM_END: &str = "-----end";
const PEM_DASHES: &str = "-----";
const URL_SCHEME_SEPARATOR: &str = "://";
/// Characters that end a URL's authority section.
const AUTHORITY_END: &str = "/?#)]}>,;";
const URL_QUERY_START: char = '?';
const URL_FRAGMENT_START: char = '#';
const URL_QUERY_SEPARATORS: [char; 2] = ['&', ';'];
const ASSIGN: char = '=';

/// Replaces each sensitive fragment of `value` with the shared mask text
/// (`text.feedbackMask.omittedCredential`):
/// - a PEM block, from `-----BEGIN` through its `-----END ...-----` line (to the end of the text
///   when the block is never closed);
/// - a word ending in `Bearer` together with the word after it, whatever whitespace separates them;
/// - a word containing one of `contract.sensitiveMarkers` (`bara-token=`, `access_token=`,
///   `api_key=`), plus the next word when the marker ends the word (`api_key= value`), and the
///   spaced forms `api_key = value` and `api_key =value`;
/// - a URL word whose authority carries `user@`, or whose query names one of
///   `contract.sensitiveQueryKeys` (`?token=...`).
///
/// The screen masks the same shapes on its own side (`feedback-model.ts` `safeFeedbackText`);
/// this host-side pass is what stands between a webview-built feedback and the bubble.
pub fn mask_sensitive(value: &str) -> String {
    let label = native_host::feedback_mask_labels().omitted_credential;
    let without_pem = mask_pem_blocks(value, label);
    mask_words(
        &without_pem,
        label,
        native_host::sensitive_markers(),
        native_host::sensitive_query_keys(),
    )
}

fn mask_pem_blocks(value: &str, label: &str) -> String {
    // ASCII lowercasing keeps every byte offset, so offsets found in `lower` index `value`.
    let lower = value.to_ascii_lowercase();
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(PEM_BEGIN) {
        let begin = cursor + found;
        out.push_str(&value[cursor..begin]);
        out.push_str(label);
        let after_begin = begin + PEM_BEGIN.len();
        cursor = lower[after_begin..]
            .find(PEM_END)
            .map(|end| after_begin + end + PEM_END.len())
            .and_then(|end_word| {
                lower[end_word..]
                    .find(PEM_DASHES)
                    .map(|dashes| end_word + dashes + PEM_DASHES.len())
            })
            .unwrap_or(value.len());
    }
    out.push_str(&value[cursor..]);
    out
}

/// Byte ranges of the whitespace-separated words of `value`.
fn words(value: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = None;
    for (index, c) in value.char_indices() {
        match (c.is_whitespace(), start) {
            (true, Some(from)) => {
                out.push(from..index);
                start = None;
            }
            (false, None) => start = Some(index),
            _ => {}
        }
    }
    if let Some(from) = start {
        out.push(from..value.len());
    }
    out
}

fn mask_words(value: &str, label: &str, markers: &[String], query_keys: &[String]) -> String {
    // Same offsets as `value` (ASCII lowercasing), so word ranges index both.
    let lower = value.to_ascii_lowercase();
    let words = words(value);
    let mut out = String::with_capacity(value.len());
    let mut copied = 0;
    let mut index = 0;
    while index < words.len() {
        let word = &lower[words[index].clone()];
        let next = words.get(index + 1).map(|range| &lower[range.clone()]);
        let Some(extra) = masked_extent(word, next, markers, query_keys) else {
            index += 1;
            continue;
        };
        let through = (index + extra).min(words.len() - 1);
        out.push_str(&value[copied..words[index].start]);
        out.push_str(label);
        copied = words[through].end;
        index = through + 1;
    }
    out.push_str(&value[copied..]);
    out
}

/// How many words after `word` belong to the same masked span, or `None` when `word` is not
/// sensitive. `next` is the word after it, if any. Both are ASCII-lowercased.
fn masked_extent(
    word: &str,
    next: Option<&str>,
    markers: &[String],
    query_keys: &[String],
) -> Option<usize> {
    if word.ends_with(BEARER) {
        return Some(1);
    }
    for marker in markers {
        if word.ends_with(marker.as_str()) {
            // `api_key= value`: the value is the next word.
            return Some(1);
        }
        if word.contains(marker.as_str()) {
            return Some(0);
        }
        let spaced = marker
            .strip_suffix(ASSIGN)
            .filter(|key| word.ends_with(key))
            .and(next)
            .and_then(|next| next.strip_prefix(ASSIGN));
        match spaced {
            // `api_key = value`: the `=` and the value are the next two words.
            Some("") => return Some(2),
            // `api_key =value`
            Some(_) => return Some(1),
            None => {}
        }
    }
    if has_credential_authority(word) || has_sensitive_query(word, query_keys) {
        return Some(0);
    }
    None
}

/// Whether `lower` (already ASCII-lowercased) contains a `scheme://user@host` fragment: an
/// authority section, up to the first delimiter, that itself contains `@`.
fn has_credential_authority(lower: &str) -> bool {
    lower.match_indices(URL_SCHEME_SEPARATOR).any(|(index, _)| {
        let authority = lower[index + URL_SCHEME_SEPARATOR.len()..]
            .split(|c: char| c.is_whitespace() || AUTHORITY_END.contains(c))
            .next()
            .unwrap_or("");
        authority.contains('@')
    })
}

/// Whether a URL in `lower` (one ASCII-lowercased word) has a query parameter named one of
/// `query_keys`, such as `https://host/path?token=...`.
fn has_sensitive_query(lower: &str, query_keys: &[String]) -> bool {
    lower.match_indices(URL_SCHEME_SEPARATOR).any(|(index, _)| {
        let rest = &lower[index + URL_SCHEME_SEPARATOR.len()..];
        let Some(query_start) = rest.find(URL_QUERY_START) else {
            return false;
        };
        let query = rest[query_start + 1..]
            .split(URL_FRAGMENT_START)
            .next()
            .unwrap_or("");
        query.split(URL_QUERY_SEPARATORS).any(|pair| {
            let name = pair.split(ASSIGN).next().unwrap_or("");
            query_keys.iter().any(|key| key == name)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feedback::contains_sensitive;

    const MASK: &str = "[인증정보 생략]";

    #[test]
    fn masks_bearer_pair_and_marker_equals_and_credential_authority() {
        assert_eq!(
            mask_sensitive("token is Bearer abc123 today"),
            "token is [인증정보 생략] today"
        );
        assert_eq!(
            mask_sensitive("see api_key=secret please"),
            "see [인증정보 생략] please"
        );
        assert_eq!(
            mask_sensitive("clone ssh://git@github.com/x/y please"),
            "clone [인증정보 생략] please"
        );
        assert_eq!(
            mask_sensitive("visit ://user@host now"),
            "visit [인증정보 생략] now"
        );
    }

    #[test]
    fn leaves_plain_urls_and_trailing_bearer_alone() {
        assert_eq!(
            mask_sensitive("see https://example.com/docs"),
            "see https://example.com/docs"
        );
        assert_eq!(
            mask_sensitive("see https://example.com/docs?page=2&tokens=3#top"),
            "see https://example.com/docs?page=2&tokens=3#top"
        );
        // A `Bearer` with nothing after it still gets masked (the word itself is the marker);
        // no following token exists to also consume.
        assert_eq!(
            mask_sensitive("ends with Bearer"),
            "ends with [인증정보 생략]"
        );
    }

    /// PFIX-3 Medium 2: the shapes a single-space split missed.
    #[test]
    fn masks_across_line_breaks_and_repeated_spaces_keeping_the_other_separators() {
        assert_eq!(
            mask_sensitive("first line\nBearer\nabc123\nlast  line"),
            "first line\n[인증정보 생략]\nlast  line"
        );
        assert_eq!(
            mask_sensitive("header:  Bearer   abc123  done"),
            "header:  [인증정보 생략]  done"
        );
        assert_eq!(
            mask_sensitive("Authorization:\tbearer\tabc123"),
            "Authorization:\t[인증정보 생략]"
        );
        assert_eq!(
            mask_sensitive("config\n  api_key = s3cret\n  model = x"),
            "config\n  [인증정보 생략]\n  model = x"
        );
        assert_eq!(mask_sensitive("API_KEY =s3cret ok"), "[인증정보 생략] ok");
        assert_eq!(mask_sensitive("api_key= s3cret ok"), "[인증정보 생략] ok");
        assert_eq!(
            mask_sensitive("값은\u{3000}bara-token=abc\u{3000}입니다"),
            "값은\u{3000}[인증정보 생략]\u{3000}입니다"
        );
    }

    #[test]
    fn masks_a_whole_pem_block_and_an_unclosed_one_to_the_end() {
        let pem = "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY\nNOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----\nsaved";
        assert_eq!(mask_sensitive(pem), "key:\n[인증정보 생략]\nsaved");
        assert_eq!(
            mask_sensitive("a -----BEGIN RSA PRIVATE KEY----- MIIEow b\nc"),
            "a [인증정보 생략]"
        );
        assert_eq!(
            mask_sensitive("x-----begin-----y-----end-----z"),
            "x[인증정보 생략]z"
        );
    }

    #[test]
    fn masks_sensitive_query_keys_in_a_url() {
        assert_eq!(
            mask_sensitive("open https://example.com/cb?state=1&token=abc#done now"),
            "open [인증정보 생략] now"
        );
        assert_eq!(
            mask_sensitive("open HTTPS://EXAMPLE.COM/?Token=abc"),
            "open [인증정보 생략]"
        );
        assert_eq!(mask_sensitive("https://example.com/?a=1;api_key=x"), MASK);
    }

    /// Masking replaced an outright rejection (`contains_sensitive`), so it must be at least as
    /// strict for the same markers: every text that check rejected comes out clean.
    #[test]
    fn masked_text_never_trips_the_old_rejection() {
        for text in [
            "Bearer abc",
            "xBearer abc",
            "a bearer \n",
            "bearer ",
            "BARA-TOKEN=abc",
            "https://example.com/#bara-token=abc",
            "?access_token=abc&x=1",
            "api_key=",
            "api_key=abc api_key=def",
            "-----BEGIN",
            "text -----begin never closed\nmore",
            "-----BEGIN EC PRIVATE KEY-----\nAAA\n-----END EC PRIVATE KEY-----",
            "https://user:pass@example.com/x",
            "see (https://git@host.example)",
            "ssh://git@github.com\nBearer\n\nz",
        ] {
            assert!(
                contains_sensitive(text),
                "{text:?} is not an old-rejection case"
            );
            let masked = mask_sensitive(text);
            assert!(!contains_sensitive(&masked), "{text:?} -> {masked:?}");
            assert!(masked.contains(MASK), "{text:?} -> {masked:?}");
        }
    }
}
