import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/src/qr/qr_code.dart';

/// The rows of a code as the reference vectors write them: each row's modules as one hexadecimal number.
String hexRows(QrCode code) {
  final digits = (code.size + 3) ~/ 4;
  final rows = StringBuffer();
  for (var y = 0; y < code.size; y++) {
    var value = BigInt.zero;
    for (var x = 0; x < code.size; x++) {
      value = (value << 1) | (code.isDark(x, y) ? BigInt.one : BigInt.zero);
    }
    rows.write(value.toRadixString(16).padLeft(digits, '0'));
  }
  return rows.toString();
}

void main() {
  test('matches an independent encoder module for module, for every mask', () {
    // The vectors were made with the qrcode package of npm, in byte mode at level M, once per mask pattern.
    final vectors = jsonDecode(File('test/qr_vectors.json').readAsStringSync()) as List<dynamic>;
    expect(vectors, hasLength(9));
    for (final vector in vectors) {
      final text = vector['text'] as String;
      final masks = (vector['masks'] as List<dynamic>).cast<String>();
      for (var mask = 0; mask < 8; mask++) {
        final code = QrCode.encode(text, mask: mask);
        expect(code.version, vector['version'], reason: 'version for ${text.length} characters');
        expect(code.size, 17 + 4 * code.version);
        expect(hexRows(code), masks[mask], reason: 'mask $mask of "${text.length > 30 ? '${text.substring(0, 30)}…' : text}"');
      }
    }
  });

  test('chooses the mask with the lowest penalty and draws the fixed patterns', () {
    final code = QrCode.encode('weixin://fixture-bind');
    expect(code.version, 2);
    expect(code.mask, inInclusiveRange(0, 7));
    expect(hexRows(code), hexRows(QrCode.encode('weixin://fixture-bind', mask: code.mask)));
    // The three finder patterns and the timing pattern are where every reader looks for them.
    final rows = code.rows;
    expect(rows[0].substring(0, 8), '#######.');
    expect(rows[0].substring(code.size - 8), '.#######');
    expect(rows[code.size - 1].substring(0, 8), '#######.');
    expect(rows[3].substring(0, 7), '#.###.#');
    expect([for (var i = 8; i < code.size - 8; i++) code.isDark(i, 6)], [for (var i = 8; i < code.size - 8; i++) i.isEven]);
    // The module that is always dark.
    expect(code.isDark(8, code.size - 8), isTrue);
  });

  test('holds what its tables say, and no more', () {
    // Each version's codewords fill its data modules but for at most seven remainder bits.
    for (var version = 1; version <= 20; version++) {
      final spare = rawDataModules(version) - 8 * totalCodewords(version);
      expect(spare, inInclusiveRange(0, 7), reason: 'version $version');
    }
    expect(QrCode.encode('z' * QrCode.maxBytes).version, 20);
    expect(() => QrCode.encode('z' * (QrCode.maxBytes + 1)), throwsArgumentError);
    // Bytes count, not characters.
    expect(QrCode.encode('微' * 222).version, 20);
    expect(() => QrCode.encode('微' * 223), throwsArgumentError);
    expect(QrCode.encode('').version, 1);
  });

  test('computes Reed–Solomon codewords as the standard does', () {
    // The worked example of the QR code standard: version 1-M, "01234567" in numeric mode.
    const data = [0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
    expect(reedSolomon(data, 10), [0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55]);
  });
}
