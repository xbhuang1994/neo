/**
 * Timestamps as canonical ISO-8601 strings (`YYYY-MM-DDTHH:mm:ss.sssZ`), which compare lexicographically.
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/** Milliseconds since the Unix epoch. */
export function nowMs(): number {
  return Date.now();
}

/** The current time in canonical form. */
export function nowIso(): string {
  return formatIso(nowMs());
}

/** Formats epoch milliseconds in canonical form (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
export function formatIso(ms: number): string {
  const whole = Math.trunc(ms);
  const days = Math.floor(whole / MS_PER_DAY);
  const rem = whole - days * MS_PER_DAY;
  const [y, m, d] = civilFromDays(days);
  const year = y < 0 ? `-${String(-y).padStart(3, "0")}` : String(y).padStart(4, "0");
  const month = pad2(m);
  const day = pad2(d);
  const hour = pad2(Math.trunc(rem / MS_PER_HOUR));
  const minute = pad2(Math.trunc(rem / MS_PER_MINUTE) % 60);
  const second = pad2(Math.trunc(rem / 1000) % 60);
  const millis = pad3(rem % 1000);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
}

/** Parses an RFC 3339 style timestamp (`Z`, a numeric offset, or none, which reads as UTC) to epoch milliseconds. */
export function parseIso(value: string): number | undefined {
  const s = value.trim();
  const len = s.length;

  const num = (from: number, count: number): number | undefined => {
    if (from + count > len) return undefined;
    let acc = 0;
    for (let i = from; i < from + count; i++) {
      const code = s.charCodeAt(i);
      if (code < 48 || code > 57) return undefined;
      acc = acc * 10 + (code - 48);
    }
    return acc;
  };

  const year = num(0, 4);
  const month = num(5, 2);
  const day = num(8, 2);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    s.charCodeAt(4) !== 45 ||
    s.charCodeAt(7) !== 45 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }

  let ms = daysFromCivil(year, month, day) * MS_PER_DAY;
  if (len === 10) {
    return ms;
  }

  const sep = s.charCodeAt(10);
  if ((sep !== 84 && sep !== 116 && sep !== 32) || s.charCodeAt(13) !== 58) {
    return undefined;
  }

  const hour = num(11, 2);
  const minute = num(14, 2);
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) {
    return undefined;
  }
  ms += hour * MS_PER_HOUR + minute * MS_PER_MINUTE;

  let at = 16;
  if (at < len && s.charCodeAt(at) === 58) {
    const second = num(at + 1, 2);
    if (second === undefined || second > 60) {
      return undefined;
    }
    ms += second * 1000;
    at += 3;

    if (at < len && s.charCodeAt(at) === 46) {
      at += 1;
      const start = at;
      while (at < len && isAsciiDigit(s.charCodeAt(at))) {
        at += 1;
      }
      if (at === start) {
        return undefined;
      }
      const end = Math.min(at, start + 3);
      let frac = 0;
      for (let i = start; i < end; i++) {
        frac = frac * 10 + (s.charCodeAt(i) - 48);
      }
      for (let i = end - start; i < 3; i++) {
        frac *= 10;
      }
      ms += frac;
    }
  }

  if (at === len) {
    return ms;
  }
  const tz = s.charCodeAt(at);
  if ((tz === 90 || tz === 122) && at + 1 === len) {
    return ms;
  }
  if (tz === 43 || tz === 45) {
    const hours = num(at + 1, 2);
    if (hours === undefined) return undefined;
    let minutes: number | undefined;
    const remLen = len - at;
    if (remLen === 3) {
      minutes = 0;
    } else if (remLen === 5) {
      minutes = num(at + 3, 2);
    } else if (remLen === 6 && s.charCodeAt(at + 3) === 58) {
      minutes = num(at + 4, 2);
    } else {
      return undefined;
    }
    if (minutes === undefined) return undefined;
    const offset = hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
    return tz === 43 ? ms - offset : ms + offset;
  }
  return undefined;
}

/** Normalizes a valid timestamp to canonical form; a value that does not parse is returned unchanged. */
export function isoTime(value: string): string {
  const ms = parseIso(value);
  return ms !== undefined ? formatIso(ms) : value;
}

/** A canonical timestamp shifted by `deltaMs`; unchanged when it does not parse. */
export function shift(value: string, deltaMs: number): string {
  const ms = parseIso(value);
  return ms !== undefined ? formatIso(ms + deltaMs) : value;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

function daysFromCivil(y: number, m: number, d: number): number {
  const yAdj = m <= 2 ? y - 1 : y;
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const doy = Math.trunc((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(z: number): readonly [number, number, number] {
  const zAdj = z + 719_468;
  const era = Math.floor(zAdj / 146_097);
  const doe = zAdj - era * 146_097;
  const yoe = Math.trunc(
    (doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36_524) - Math.trunc(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const d = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}
