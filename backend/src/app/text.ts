//! Word counting for instant-message limits.

/** The most words a message to an instant-messaging conversation may have. */
export const IM_WORDS = 100;

/** Discriminated check result for text validation. */
export type TextResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

const UNICODE_ALNUM = /^[\p{Alphabetic}\p{Number}]$/u;

/** Whether a Unicode code point is a CJK ideograph, kana, or Hangul syllable. */
export function isIdeograph(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x323af) || // Han
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) || // kana
    (codePoint >= 0xac00 && codePoint <= 0xd7af) // hangul syllables
  );
}

function isAsciiAlphanumeric(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) // a-z
  );
}

function isAsciiAlphabetic(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isAlphanumeric(cp: number): boolean {
  if (cp <= 0x7f) {
    return isAsciiAlphanumeric(cp);
  }
  return UNICODE_ALNUM.test(String.fromCodePoint(cp));
}

function isWordJoiner(cp: number): boolean {
  return (
    cp === 0x27 || // '
    cp === 0x2019 || // ’
    cp === 0x2e || // .
    cp === 0x5f || // _
    cp === 0x2d // -
  );
}

/**
 * Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation and symbols: each CJK
 * character is a word, and so is each run of other letters and digits (with `'`, `’`, `.`, `_` or `-` inside it).
 * It approximates dictionary segmentation, which counts a multi-character Chinese word once, so it never undercounts.
 */
export function wordCount(text: string): number {
  let count = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; ) {
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    if (isIdeograph(cp)) {
      count += 1;
      inWord = false;
    } else if (isAlphanumeric(cp)) {
      if (!inWord) {
        count += 1;
      }
      inWord = true;
    } else if (inWord && isWordJoiner(cp) && i + step < len) {
      const next = text.codePointAt(i + step)!;
      if (!isIdeograph(next) && isAlphanumeric(next)) {
        // Joins "don't", "v1.2", "snake_case" and "well-known" into one word.
      } else {
        inWord = false;
      }
    } else {
      inWord = false;
    }
    i += step;
  }
  return count;
}

/** Checks that an outgoing instant message does not exceed {@link IM_WORDS}. */
export function checkedImText(text: string): TextResult<string> {
  const count = wordCount(text);
  if (count > IM_WORDS) {
    return {
      ok: false,
      error: `IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`,
    };
  }
  return { ok: true, value: text };
}

/** CJK characters and runs of Latin letters in `text`. */
function scripts(text: string): [number, number] {
  let cjk = 0;
  let latin = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; ) {
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    if (isIdeograph(cp)) {
      cjk += 1;
    }
    const letter = isAsciiAlphabetic(cp);
    if (letter && !inWord) {
      latin += 1;
    }
    inWord = letter;
    i += step;
  }
  return [cjk, latin];
}

/**
 * Why `reply` is in another language than `asked`, the message it answers, when that message's language is clear:
 * one written mostly in Chinese (or another CJK language, code names and English terms aside) needs a reply with
 * CJK text, and one written in English without any CJK needs a reply that is not mostly CJK.
 */
export function languageMismatch(asked: string, reply: string): string | null {
  const [askedCjk, askedLatin] = scripts(asked);
  const [cjk, latin] = scripts(reply);
  if (askedCjk >= 2 && askedCjk >= askedLatin && cjk === 0) {
    return "the person wrote in Chinese, so write it in Chinese (code names and terms may stay as they are), never English, whatever language cards, reports or earlier replies use";
  }
  if (askedCjk === 0 && askedLatin >= 3 && cjk > latin) {
    return "the person wrote in English, so write it in English";
  }
  return null;
}

/** The first `limit` Unicode scalar values (characters) of `text`. */
export function clip(text: string, limit: number): string {
  if (limit <= 0 || text.length === 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  let count = 0;
  let i = 0;
  const len = text.length;
  while (i < len && count < limit) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        count += 1;
        continue;
      }
    }
    i += 1;
    count += 1;
  }
  return i === len ? text : text.slice(0, i);
}
