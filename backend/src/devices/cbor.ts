/**
 * Pure TypeScript RFC 8949 CBOR codec subset (`uint`, `negint`, `bstr`, `tstr`,
 * `array`, `map`, `bool`, `null`, plus IEEE-754 float decode/encode fallback).
 *
 * Byte-for-byte compatible with the Tier 2 C99 `neo-agent-mcu` CBOR codec and
 * Tier 1 Rust `neo-agent-os` CBOR forwarding.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const MAX_CBOR_DEPTH = 32;
const MAX_CBOR_ITEMS = 10_000;

class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 128) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.byteLength) return;
    let nextCap = this.buf.byteLength * 2;
    while (nextCap < needed) {
      nextCap *= 2;
    }
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.pos), 0);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeU16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, false);
    this.pos += 2;
  }

  writeU32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, false);
    this.pos += 4;
  }

  writeU64(v: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, false);
    this.pos += 8;
  }

  writeF64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, false);
    this.pos += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.byteLength);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.byteLength;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function writeTypeAndArg(writer: ByteWriter, major: number, arg: number | bigint): void {
  const prefix = (major & 0x07) << 5;
  if (typeof arg === "number") {
    if (!Number.isInteger(arg) || arg < 0) {
      throw new Error(`CBOR integer argument out of range: ${arg}`);
    }
    if (arg <= 23) {
      writer.writeU8(prefix | arg);
      return;
    }
    if (arg <= 0xff) {
      writer.writeU8(prefix | 24);
      writer.writeU8(arg);
      return;
    }
    if (arg <= 0xffff) {
      writer.writeU8(prefix | 25);
      writer.writeU16(arg);
      return;
    }
    if (arg <= 0xffffffff) {
      writer.writeU8(prefix | 26);
      writer.writeU32(arg);
      return;
    }
    writer.writeU8(prefix | 27);
    writer.writeU64(BigInt(arg));
    return;
  }

  if (arg < 0n || arg > 0xffffffffffffffffn) {
    throw new Error(`CBOR bigint argument out of uint64 range: ${arg.toString()}`);
  }
  if (arg <= 23n) {
    writer.writeU8(prefix | Number(arg));
  } else if (arg <= 0xffn) {
    writer.writeU8(prefix | 24);
    writer.writeU8(Number(arg));
  } else if (arg <= 0xffffn) {
    writer.writeU8(prefix | 25);
    writer.writeU16(Number(arg));
  } else if (arg <= 0xffffffffn) {
    writer.writeU8(prefix | 26);
    writer.writeU32(Number(arg));
  } else {
    writer.writeU8(prefix | 27);
    writer.writeU64(arg);
  }
}

function encodeValue(writer: ByteWriter, value: unknown, depth: number): void {
  if (depth > MAX_CBOR_DEPTH) {
    throw new Error(`CBOR max encoding depth (${MAX_CBOR_DEPTH}) exceeded`);
  }

  if (value === null) {
    writer.writeU8(0xf6);
    return;
  }
  if (typeof value === "boolean") {
    writer.writeU8(value ? 0xf5 : 0xf4);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`CBOR non-finite number is not supported: ${value}`);
    }
    if (Number.isInteger(value)) {
      if (Object.is(value, -0)) {
        writeTypeAndArg(writer, 0, 0);
        return;
      }
      if (value >= 0) {
        if (value <= Number.MAX_SAFE_INTEGER) {
          writeTypeAndArg(writer, 0, value);
        } else {
          writeTypeAndArg(writer, 0, BigInt(value));
        }
        return;
      }
      const mag = -1n - BigInt(value);
      writeTypeAndArg(writer, 1, mag);
      return;
    }
    writer.writeU8(0xfb);
    writer.writeF64(value);
    return;
  }
  if (typeof value === "bigint") {
    if (value >= 0n) {
      writeTypeAndArg(writer, 0, value);
    } else {
      writeTypeAndArg(writer, 1, -1n - value);
    }
    return;
  }
  if (typeof value === "string") {
    const utf8 = textEncoder.encode(value);
    writeTypeAndArg(writer, 3, utf8.byteLength);
    writer.writeBytes(utf8);
    return;
  }
  if (value instanceof Uint8Array) {
    writeTypeAndArg(writer, 2, value.byteLength);
    writer.writeBytes(value);
    return;
  }
  if (Array.isArray(value)) {
    writeTypeAndArg(writer, 4, value.length);
    for (let i = 0; i < value.length; i++) {
      encodeValue(writer, value[i], depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        entries.push([k, v]);
      }
    }
    writeTypeAndArg(writer, 5, entries.length);
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]!;
      const keyUtf8 = textEncoder.encode(k);
      writeTypeAndArg(writer, 3, keyUtf8.byteLength);
      writer.writeBytes(keyUtf8);
      encodeValue(writer, v, depth + 1);
    }
    return;
  }

  throw new Error(`Unsupported CBOR value type: ${typeof value}`);
}

/** Encode a JS value into RFC 8949 CBOR bytes. */
export function encodeCbor(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  encodeValue(writer, value, 0);
  return writer.toUint8Array();
}

interface Reader {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
}

function need(reader: Reader, count: number): void {
  if (reader.offset + count > reader.bytes.byteLength) {
    throw new Error(`CBOR unexpected end of input at offset ${reader.offset}`);
  }
}

function readArg(reader: Reader, addl: number): bigint {
  if (addl <= 23) {
    return BigInt(addl);
  }
  if (addl === 24) {
    need(reader, 1);
    return BigInt(reader.bytes[reader.offset++]!);
  }
  if (addl === 25) {
    need(reader, 2);
    const val = reader.view.getUint16(reader.offset, false);
    reader.offset += 2;
    return BigInt(val);
  }
  if (addl === 26) {
    need(reader, 4);
    const val = reader.view.getUint32(reader.offset, false);
    reader.offset += 4;
    return BigInt(val);
  }
  if (addl === 27) {
    need(reader, 8);
    const val = reader.view.getBigUint64(reader.offset, false);
    reader.offset += 8;
    return val;
  }
  throw new Error(`Unsupported CBOR additional info ${addl} at offset ${reader.offset}`);
}

function toSafeNumber(v: bigint): number | bigint {
  if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  return v;
}

function toSafeLength(v: bigint, kind: string): number {
  if (v > BigInt(MAX_CBOR_ITEMS) && kind !== "bytes") {
    throw new Error(`CBOR ${kind} count exceeds safety limit (${v.toString()})`);
  }
  if (v > 0x7fffffffn) {
    throw new Error(`CBOR ${kind} length exceeds maximum (${v.toString()})`);
  }
  return Number(v);
}

function decodeFloat16(half: number): number {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const frac = half & 0x03ff;
  if (exp === 0) {
    return sign * 2 ** -14 * (frac / 1024);
  }
  if (exp === 31) {
    return frac === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

function decodeValue(reader: Reader, depth: number): unknown {
  if (depth > MAX_CBOR_DEPTH) {
    throw new Error(`CBOR max decoding depth (${MAX_CBOR_DEPTH}) exceeded`);
  }
  need(reader, 1);
  const initial = reader.bytes[reader.offset++]!;
  const major = (initial >>> 5) & 0x07;
  const addl = initial & 0x1f;

  switch (major) {
    case 0: {
      const arg = readArg(reader, addl);
      return toSafeNumber(arg);
    }
    case 1: {
      const arg = readArg(reader, addl);
      return toSafeNumber(-1n - arg);
    }
    case 2: {
      const len = toSafeLength(readArg(reader, addl), "bytes");
      need(reader, len);
      const out = reader.bytes.slice(reader.offset, reader.offset + len);
      reader.offset += len;
      return out;
    }
    case 3: {
      const len = toSafeLength(readArg(reader, addl), "bytes");
      need(reader, len);
      const slice = reader.bytes.subarray(reader.offset, reader.offset + len);
      reader.offset += len;
      return textDecoder.decode(slice);
    }
    case 4: {
      const count = toSafeLength(readArg(reader, addl), "array");
      const out = new Array<unknown>(count);
      for (let i = 0; i < count; i++) {
        out[i] = decodeValue(reader, depth + 1);
      }
      return out;
    }
    case 5: {
      const count = toSafeLength(readArg(reader, addl), "map");
      const out: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const rawKey = decodeValue(reader, depth + 1);
        const key = typeof rawKey === "string" ? rawKey : String(rawKey);
        const val = decodeValue(reader, depth + 1);
        Object.defineProperty(out, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    case 7: {
      if (addl === 20) return false;
      if (addl === 21) return true;
      if (addl === 22) return null;
      if (addl === 23) return undefined;
      if (addl === 25) {
        need(reader, 2);
        const half = reader.view.getUint16(reader.offset, false);
        reader.offset += 2;
        return decodeFloat16(half);
      }
      if (addl === 26) {
        need(reader, 4);
        const f32 = reader.view.getFloat32(reader.offset, false);
        reader.offset += 4;
        return f32;
      }
      if (addl === 27) {
        need(reader, 8);
        const f64 = reader.view.getFloat64(reader.offset, false);
        reader.offset += 8;
        return f64;
      }
      throw new Error(`Unsupported CBOR simple/float value ${addl} at offset ${reader.offset}`);
    }
    default:
      throw new Error(`Unsupported CBOR major type ${major} at offset ${reader.offset}`);
  }
}

/** Decode RFC 8949 CBOR bytes into a JS value, rejecting trailing bytes. */
export function decodeCbor<T = unknown>(bytes: Uint8Array): T {
  const reader: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  };
  const value = decodeValue(reader, 0);
  if (reader.offset !== bytes.byteLength) {
    throw new Error(`CBOR trailing bytes: consumed ${reader.offset} of ${bytes.byteLength}`);
  }
  return value as T;
}
