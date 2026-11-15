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

/// CJK characters and runs of Latin letters in `text`.
fn scripts(text: &str) -> (usize, usize) {
    let (mut cjk, mut latin, mut in_word) = (0, 0, false);
    for c in text.chars() {
        if ideograph(c) {
            cjk += 1;
        }
        let letter = c.is_ascii_alphabetic();
        if letter && !in_word {
            latin += 1;
        }
        in_word = letter;
    }
    (cjk, latin)
}

/// Why `reply` is in another language than `asked`, the message it answers, when that message's language is clear:
/// one written mostly in Chinese (or another CJK language, code names and English terms aside) needs a reply with
/// CJK text, and one written in English without any CJK needs a reply that is not mostly CJK.
pub fn language_mismatch(asked: &str, reply: &str) -> Option<&'static str> {
    let (asked_cjk, asked_latin) = scripts(asked);
    let (cjk, latin) = scripts(reply);
    if asked_cjk >= 2 && asked_cjk >= asked_latin && cjk == 0 {
        Some("the person wrote in Chinese, so write it in Chinese (code names and terms may stay as they are), never English, whatever language cards, reports or earlier replies use")
    } else if asked_cjk == 0 && asked_latin >= 3 && cjk > latin {
        Some("the person wrote in English, so write it in English")
    } else {
        None
    }
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

    #[test]
    fn a_reply_follows_the_language_the_person_wrote_in() {
        let asked = "那测试跨不同的cpu 的CCD和相同性能CCD 做对比";
        let english = "On it: comparing the ring buffer's alignment performance across different CPU CCDs.";
        assert!(language_mismatch(asked, english).is_some());
        assert_eq!(language_mismatch(asked, "收到：对比 ring buffer 在跨 CCD 与同 CCD 下的性能。"), None);
        assert_eq!(language_mismatch("[语音转写] C加加的run buffer需要线程安全", "收到：改为线程安全。"), None);
        assert!(language_mismatch("Please fix the save button", "收到：修复保存按钮。").is_some());
        assert_eq!(language_mismatch("Please fix the save button", "On it: fixing the save button."), None);
        assert_eq!(language_mismatch("Please fix the save button", "On it: fixing the “保存” button."), None);
        // Unclear or mixed messages constrain nothing.
        assert_eq!(language_mismatch("ok", "好的"), None);
        assert_eq!(language_mismatch("看下 https://github.com/foo/bar/issues/12", "Looking at it."), None);
    }
}
