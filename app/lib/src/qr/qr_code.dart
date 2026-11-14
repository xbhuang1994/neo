/// A QR code encoder: byte mode, error correction level M, versions 1 to 20 — up to 666 bytes, more than a login
/// address needs. Written here so that the app draws WeChat's login code itself and needs no package for it.
library;

import 'dart:convert';
import 'dart:typed_data';

/// A square of dark and light modules.
class QrCode {
  QrCode._(this.version, this.mask, this.size, this._dark);

  /// The symbol version, 1 to 20.
  final int version;

  /// The mask pattern applied, 0 to 7.
  final int mask;

  /// Modules per side.
  final int size;
  final Uint8List _dark;

  /// Whether the module in column [x] of row [y] is dark.
  bool isDark(int x, int y) => _dark[y * size + x] == 1;

  /// The rows as text, `#` for a dark module and `.` for a light one.
  List<String> get rows => [
    for (var y = 0; y < size; y++) [for (var x = 0; x < size; x++) isDark(x, y) ? '#' : '.'].join(),
  ];

  /// The most bytes a code holds.
  static const int maxBytes = 666;

  /// Encode [text] as UTF-8 in the smallest version that holds it. [mask] forces a mask pattern; without one the
  /// pattern with the lowest penalty is chosen, as the standard says.
  ///
  /// Throws an [ArgumentError] when the text is longer than [maxBytes] bytes.
  factory QrCode.encode(String text, {int? mask}) {
    final data = utf8.encode(text);
    final version = _versionFor(data.length);
    if (version == null) {
      throw ArgumentError('The text is too long for a QR code: ${data.length} bytes, at most $maxBytes');
    }
    final codewords = _interleave(_dataCodewords(data, version), version);
    final builder = _Builder(version)..drawFunctionPatterns();
    builder.drawCodewords(codewords);
    var chosen = mask;
    if (chosen == null) {
      var lowest = -1;
      for (var pattern = 0; pattern < 8; pattern++) {
        builder.applyMask(pattern);
        builder.drawFormat(pattern);
        final penalty = builder.penalty();
        if (lowest < 0 || penalty < lowest) {
          lowest = penalty;
          chosen = pattern;
        }
        builder.applyMask(pattern);
      }
    }
    builder.applyMask(chosen!);
    builder.drawFormat(chosen);
    return QrCode._(version, chosen, builder.size, builder.dark);
  }
}

/// Error correction for level M by version: codewords per block, then the count and data length of each of the two
/// block groups.
const List<List<int>> _blocks = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
];

/// The centres of the alignment patterns by version.
const List<List<int>> _alignment = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

int _dataCapacity(int version) {
  final b = _blocks[version - 1];
  return b[1] * b[2] + b[3] * b[4];
}

/// The data and error correction codewords a version holds in all.
int totalCodewords(int version) {
  final b = _blocks[version - 1];
  return _dataCapacity(version) + (b[1] + b[3]) * b[0];
}

/// The modules of a version that carry codewords: everything but the function patterns.
int rawDataModules(int version) {
  var modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    final aligned = version ~/ 7 + 2;
    modules -= (25 * aligned - 10) * aligned - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

int? _versionFor(int bytes) {
  for (var version = 1; version <= _blocks.length; version++) {
    // The mode takes four bits and the length eight, or sixteen from version 10 on.
    final bits = 4 + (version < 10 ? 8 : 16) + 8 * bytes;
    if (bits <= 8 * _dataCapacity(version)) return version;
  }
  return null;
}

Uint8List _dataCodewords(List<int> data, int version) {
  final capacity = _dataCapacity(version);
  final bits = <int>[];
  void put(int value, int length) {
    for (var bit = length - 1; bit >= 0; bit--) {
      bits.add((value >> bit) & 1);
    }
  }

  put(4, 4);
  put(data.length, version < 10 ? 8 : 16);
  for (final byte in data) {
    put(byte, 8);
  }
  // The terminator, shortened where the data fills the symbol, then zeros to a whole codeword.
  final terminator = capacity * 8 - bits.length;
  put(0, terminator < 4 ? terminator : 4);
  while (bits.length % 8 != 0) {
    bits.add(0);
  }
  final codewords = Uint8List(capacity);
  for (var index = 0; index < bits.length; index++) {
    codewords[index >> 3] |= bits[index] << (7 - (index & 7));
  }
  for (var index = bits.length >> 3, pad = 0; index < capacity; index++, pad ^= 1) {
    codewords[index] = pad == 0 ? 0xEC : 0x11;
  }
  return codewords;
}

final Uint8List _exp = Uint8List(512);
final Uint8List _log = Uint8List(256);
bool _fieldReady = false;

void _prepareField() {
  if (_fieldReady) return;
  var value = 1;
  for (var power = 0; power < 255; power++) {
    _exp[power] = value;
    _log[value] = power;
    value <<= 1;
    if (value & 0x100 != 0) value ^= 0x11D;
  }
  for (var power = 255; power < 512; power++) {
    _exp[power] = _exp[power - 255];
  }
  _fieldReady = true;
}

int _multiply(int a, int b) => a == 0 || b == 0 ? 0 : _exp[_log[a] + _log[b]];

/// The Reed–Solomon error correction codewords of [data].
Uint8List reedSolomon(List<int> data, int count) {
  _prepareField();
  // The generator polynomial: the product of (x - 2^i) for i below count, without its leading 1.
  final generator = Uint8List(count);
  generator[count - 1] = 1;
  var root = 1;
  for (var i = 0; i < count; i++) {
    for (var j = 0; j < count; j++) {
      generator[j] = _multiply(generator[j], root);
      if (j + 1 < count) generator[j] ^= generator[j + 1];
    }
    root = _multiply(root, 2);
  }
  final remainder = Uint8List(count);
  for (final byte in data) {
    final factor = byte ^ remainder[0];
    for (var j = 0; j < count - 1; j++) {
      remainder[j] = remainder[j + 1];
    }
    remainder[count - 1] = 0;
    for (var j = 0; j < count; j++) {
      remainder[j] ^= _multiply(generator[j], factor);
    }
  }
  return remainder;
}

Uint8List _interleave(Uint8List data, int version) {
  final b = _blocks[version - 1];
  final blocks = <Uint8List>[];
  final corrections = <Uint8List>[];
  var offset = 0;
  for (var group = 0; group < 2; group++) {
    for (var block = 0; block < b[1 + 2 * group]; block++) {
      final length = b[2 + 2 * group];
      final part = Uint8List.sublistView(data, offset, offset + length);
      offset += length;
      blocks.add(part);
      corrections.add(reedSolomon(part, b[0]));
    }
  }
  final out = BytesBuilder();
  final longest = blocks.last.length;
  for (var index = 0; index < longest; index++) {
    for (final block in blocks) {
      if (index < block.length) out.addByte(block[index]);
    }
  }
  for (var index = 0; index < b[0]; index++) {
    for (final correction in corrections) {
      out.addByte(correction[index]);
    }
  }
  return out.toBytes();
}

class _Builder {
  _Builder(this.version) : size = 17 + 4 * version {
    dark = Uint8List(size * size);
    reserved = Uint8List(size * size);
  }

  final int version;
  final int size;
  late final Uint8List dark;
  late final Uint8List reserved;

  void set(int x, int y, bool isDark, {bool function = true}) {
    dark[y * size + x] = isDark ? 1 : 0;
    if (function) reserved[y * size + x] = 1;
  }

  void drawFunctionPatterns() {
    for (var i = 0; i < size; i++) {
      set(6, i, i.isEven);
      set(i, 6, i.isEven);
    }
    _finder(3, 3);
    _finder(size - 4, 3);
    _finder(3, size - 4);
    final centres = _alignment[version - 1];
    for (var i = 0; i < centres.length; i++) {
      for (var j = 0; j < centres.length; j++) {
        final last = centres.length - 1;
        // Not where the three finder patterns are.
        if ((i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            set(centres[i] + dx, centres[j] + dy, dx.abs() == 2 || dy.abs() == 2 || (dx == 0 && dy == 0));
          }
        }
      }
    }
    drawFormat(0);
    _drawVersion();
  }

  void _finder(int cx, int cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        final x = cx + dx, y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        final ring = dx.abs() > dy.abs() ? dx.abs() : dy.abs();
        set(x, y, ring != 2 && ring != 4);
      }
    }
  }

  /// The format information: level M and the mask, with its error correction, in both of its places.
  void drawFormat(int mask) {
    // Level M is 00.
    final data = mask;
    var remainder = data;
    for (var i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >> 9) * 0x537);
    }
    final bits = ((data << 10) | remainder) ^ 0x5412;
    bool bit(int i) => (bits >> i) & 1 == 1;
    for (var i = 0; i <= 5; i++) {
      set(8, i, bit(i));
    }
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (var i = 9; i < 15; i++) {
      set(14 - i, 8, bit(i));
    }
    for (var i = 0; i < 8; i++) {
      set(size - 1 - i, 8, bit(i));
    }
    for (var i = 8; i < 15; i++) {
      set(8, size - 15 + i, bit(i));
    }
    set(8, size - 8, true);
  }

  void _drawVersion() {
    if (version < 7) return;
    var remainder = version;
    for (var i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1F25);
    }
    final bits = (version << 12) | remainder;
    for (var i = 0; i < 18; i++) {
      final isDark = (bits >> i) & 1 == 1;
      final a = size - 11 + i % 3, b = i ~/ 3;
      set(a, b, isDark);
      set(b, a, isDark);
    }
  }

  /// Lay the codewords in the zigzag from the bottom right, two columns at a time, skipping function modules.
  void drawCodewords(Uint8List codewords) {
    var index = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (var step = 0; step < size; step++) {
        for (var column = 0; column < 2; column++) {
          final x = right - column;
          final upward = ((right + 1) & 2) == 0;
          final y = upward ? size - 1 - step : step;
          if (reserved[y * size + x] == 1) continue;
          if (index < codewords.length * 8) {
            final isDark = (codewords[index >> 3] >> (7 - (index & 7))) & 1 == 1;
            set(x, y, isDark, function: false);
            index++;
          }
        }
      }
    }
  }

  /// Flip the data modules the pattern selects; applying it twice undoes it.
  void applyMask(int mask) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (reserved[y * size + x] == 1) continue;
        final bool flip = switch (mask) {
          0 => (x + y) % 2 == 0,
          1 => y % 2 == 0,
          2 => x % 3 == 0,
          3 => (x + y) % 3 == 0,
          4 => (x ~/ 3 + y ~/ 2) % 2 == 0,
          5 => x * y % 2 + x * y % 3 == 0,
          6 => (x * y % 2 + x * y % 3) % 2 == 0,
          _ => ((x + y) % 2 + x * y % 3) % 2 == 0,
        };
        if (flip) dark[y * size + x] ^= 1;
      }
    }
  }

  /// How hard the symbol is to read, by the standard's four rules; lower is better.
  int penalty() {
    var points = 0;
    int at(int x, int y) => dark[y * size + x];
    // Runs of five or more of one colour, in rows and in columns.
    for (var line = 0; line < size; line++) {
      for (final horizontal in const [true, false]) {
        var run = 1;
        for (var i = 1; i <= size; i++) {
          final same = i < size && (horizontal ? at(i, line) == at(i - 1, line) : at(line, i) == at(line, i - 1));
          if (same) {
            run++;
          } else {
            if (run >= 5) points += run - 2;
            run = 1;
          }
        }
      }
    }
    // Blocks of two by two of one colour.
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        final colour = at(x, y);
        if (colour == at(x + 1, y) && colour == at(x, y + 1) && colour == at(x + 1, y + 1)) points += 3;
      }
    }
    // What looks like a finder pattern: 1011101 with four light modules on either side.
    const before = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const after = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    for (var line = 0; line < size; line++) {
      for (var start = 0; start + 11 <= size; start++) {
        for (final horizontal in const [true, false]) {
          var matchesBefore = true, matchesAfter = true;
          for (var i = 0; i < 11; i++) {
            final value = horizontal ? at(start + i, line) : at(line, start + i);
            if (value != before[i]) matchesBefore = false;
            if (value != after[i]) matchesAfter = false;
          }
          if (matchesBefore) points += 40;
          if (matchesAfter) points += 40;
        }
      }
    }
    // How far the share of dark modules is from half, in steps of five percent.
    var darkCount = 0;
    for (final module in dark) {
      darkCount += module;
    }
    final total = size * size;
    final steps = ((darkCount * 20 - total * 10).abs() + total - 1) ~/ total - 1;
    points += (steps < 0 ? 0 : steps) * 10;
    return points;
  }
}
