//! Word counting for instant-message limits.

/// The most words a message to an instant-messaging conversation may have.
pub const IM_WORDS: usize = 100;

fn ideograph(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x323AF // Han
        | 0x3040..=0x30FF | 0x31F0..=0x31FF // kana
        | 0xAC00..=0xD7AF) // hangul syllables
}

/// Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation and symbols: each CJK
/// character is a word, and so is each run of other letters and digits (with `'`, `’`, `.`, `_` or `-` inside it).
/// It approximates dictionary segmentation, which counts a multi-character Chinese word once, so it never undercounts.
pub fn word_count(text: &str) -> usize {
    let mut count = 0;
    let mut in_word = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if ideograph(c) {
            count += 1;
            in_word = false;
        } else if c.is_alphanumeric() {
            if !in_word {
                count += 1;
            }
            in_word = true;
        } else if in_word && matches!(c, '\'' | '’' | '.' | '_' | '-') && chars.peek().is_some_and(|next| next.is_alphanumeric() && !ideograph(*next)) {
            // Joins "don't", "v1.2", "snake_case" and "well-known" into one word.
        } else {
            in_word = false;
        }
    }
    count
}

/// Checks that an outgoing instant message does not exceed [`IM_WORDS`].
pub fn checked_im_text(text: &str) -> Result<&str, String> {
    let count = word_count(text);
    if count > IM_WORDS {
        return Err(format!(
            "IM message has {count} words; maximum is {IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages."
        ));
    }
    Ok(text)
}

/// The first `limit` characters of `text`.
pub fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_words_in_chinese_english_and_mixed_text() {
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("Hello, world!"), 2);
        assert_eq!(word_count("修复 README 的错别字。"), 7);
        assert_eq!(word_count("don't use v1.2 of snake_case — it's well-known"), 7);
        assert_eq!(word_count("...!!! ——"), 0);
        assert_eq!(word_count("こんにちは"), 5);
        assert_eq!(word_count("a.b. c"), 2);
    }

    #[test]
    fn refuses_a_message_over_the_limit() {
        let fits = "字".repeat(IM_WORDS);
        assert_eq!(checked_im_text(&fits), Ok(fits.as_str()));
        let long = "word ".repeat(IM_WORDS + 1);
        assert!(checked_im_text(&long).unwrap_err().contains("101 words"));
        assert_eq!(clip("你好世界", 2), "你好");
    }
}
