//! The bytes that cross the process boundary.
//!
//! On Windows `nvim -l` reads stdin in text mode: CRLF becomes LF and a
//! byte 0x1A ends the input without a word (concept 3.5). The hub therefore
//! sends JSON that is plain printable ASCII on one line: every other
//! character is a `\uXXXX` escape, so there is nothing left for text mode to
//! change. The answer is read as bytes and the line ending is cut off.

use std::io;

use serde::Serialize;
use serde_json::ser::{Formatter, Serializer};
use serde_json::Value;

/// A compact formatter that writes every non-ASCII character as `\uXXXX`
/// (a surrogate pair above the BMP). Control characters are already escaped
/// by the serializer itself.
struct AsciiFormatter;

impl Formatter for AsciiFormatter {
    fn write_string_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
    where
        W: ?Sized + io::Write,
    {
        let bytes = fragment.as_bytes();
        let mut start = 0;
        for (i, ch) in fragment.char_indices() {
            // DEL is ASCII but not printable: it is escaped like the rest.
            if ch.is_ascii() && ch != '\u{7f}' {
                continue;
            }
            writer.write_all(&bytes[start..i])?;
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                write!(writer, "\\u{unit:04x}")?;
            }
            start = i + ch.len_utf8();
        }
        writer.write_all(&bytes[start..])
    }
}

/// Serialize `value` as one line of printable ASCII.
///
/// # Errors
///
/// Only when the value cannot be serialized (it always can for a
/// [`Value`]), reported as the serializer's error.
pub fn ascii_json(value: &Value) -> Result<String, serde_json::Error> {
    let mut buf = Vec::new();
    let mut ser = Serializer::with_formatter(&mut buf, AsciiFormatter);
    value.serialize(&mut ser)?;
    // The serializer writes valid UTF-8, and the formatter only adds ASCII.
    String::from_utf8(buf)
        .map_err(|e| <serde_json::Error as serde::ser::Error>::custom(format!("not UTF-8: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn output_is_printable_ascii_on_one_line() {
        let v = json!({
            "title": "Käse \u{1f600} \r\n \u{1a} tab\t end",
            "k\u{e4}y": ["\u{7f}", "ok"],
        });
        let text = ascii_json(&v).unwrap();
        assert!(text.bytes().all(|b| (0x20..0x7f).contains(&b)), "{text}");
        assert!(!text.contains('\n') && !text.contains('\r') && !text.contains('\u{1a}'));
    }

    #[test]
    fn it_round_trips_and_uses_surrogate_pairs() {
        let v = json!({"s": "\u{1f600}\u{e4}", "n": 1, "a": [null, true]});
        let text = ascii_json(&v).unwrap();
        assert!(text.contains("\\ud83d\\ude00"));
        assert!(text.contains("\\u00e4"));
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, v);
    }
}
