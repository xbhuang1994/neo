//! Timestamps as canonical ISO-8601 strings (`YYYY-MM-DDTHH:mm:ss.sssZ`), which compare lexicographically.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The current time in canonical form.
pub fn now_iso() -> String {
    format_iso(now_ms())
}

/// Formats epoch milliseconds in canonical form.
pub fn format_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// Parses an RFC 3339 style timestamp (`Z`, a numeric offset, or none, which reads as UTC) to epoch milliseconds.
pub fn parse_iso(value: &str) -> Option<i64> {
    let b = value.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * 86_400_000;
    if b.len() == 10 {
        return Some(ms);
    }
    if !matches!(b[10], b'T' | b't' | b' ') || b.get(13) != Some(&b':') {
        return None;
    }
    let (hour, minute) = (num(11, 2)?, num(14, 2)?);
    if hour > 23 || minute > 59 {
        return None;
    }
    ms += hour * 3_600_000 + minute * 60_000;
    let mut at = 16;
    if b.get(at) == Some(&b':') {
        let second = num(at + 1, 2)?;
        if second > 60 {
            return None;
        }
        ms += second * 1000;
        at += 3;
        if b.get(at) == Some(&b'.') {
            at += 1;
            let start = at;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return None;
            }
            let digits = std::str::from_utf8(&b[start..at.min(start + 3)]).ok()?;
            let mut frac: i64 = digits.parse().ok()?;
            for _ in digits.len()..3 {
                frac *= 10;
            }
            ms += frac;
        }
    }
    match b.get(at) {
        None => Some(ms),
        Some(b'Z' | b'z') if at + 1 == b.len() => Some(ms),
        Some(sign @ (b'+' | b'-')) => {
            let hours = num(at + 1, 2)?;
            let minutes = match b.len() - at {
                3 => 0,
                5 => num(at + 3, 2)?,
                6 if b[at + 3] == b':' => num(at + 4, 2)?,
                _ => return None,
            };
            let offset = hours * 3_600_000 + minutes * 60_000;
            Some(if *sign == b'+' { ms - offset } else { ms + offset })
        }
        _ => None,
    }
}

/// Normalizes a valid timestamp to canonical form; a value that does not parse is returned unchanged.
pub fn iso_time(value: &str) -> String {
    parse_iso(value).map(format_iso).unwrap_or_else(|| value.to_string())
}

/// A canonical timestamp shifted by `delta_ms`; unchanged when it does not parse.
pub fn shift(value: &str, delta_ms: i64) -> String {
    parse_iso(value).map(|ms| format_iso(ms + delta_ms)).unwrap_or_else(|| value.to_string())
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_round_trip() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso(1_794_664_026_268), "2026-11-14T13:47:06.268Z");
        assert_eq!(parse_iso("2026-11-14T13:47:06.268Z"), Some(1_794_664_026_268));
        assert_eq!(parse_iso("2024-02-29T00:00:00Z").map(format_iso).as_deref(), Some("2024-02-29T00:00:00.000Z"));
    }

    #[test]
    fn normalizes_offsets_and_whole_seconds() {
        assert_eq!(iso_time("2026-01-02T03:04:05Z"), "2026-01-02T03:04:05.000Z");
        assert_eq!(iso_time("2026-01-02T03:04:05+08:00"), "2026-01-01T19:04:05.000Z");
        assert_eq!(iso_time("2026-01-02T03:04:05.5-0130"), "2026-01-02T04:34:05.500Z");
        assert_eq!(iso_time("not a time"), "not a time");
        assert_eq!(shift("2026-01-02T03:04:05.000Z", 1500), "2026-01-02T03:04:06.500Z");
    }
}
