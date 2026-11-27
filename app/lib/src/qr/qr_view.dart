/// Draws a QR code.
library;

import 'dart:collection';

import 'package:flutter/widgets.dart';

import 'qr_code.dart';

final LinkedHashMap<String, QrCode?> _qrCache = LinkedHashMap<String, QrCode?>();

QrCode? _cachedQrCode(String content) {
  if (_qrCache.containsKey(content)) {
    final hit = _qrCache.remove(content);
    _qrCache[content] = hit;
    return hit;
  }
  QrCode? encoded;
  try {
    encoded = QrCode.encode(content);
  } on ArgumentError {
    encoded = null;
  }
  if (_qrCache.length >= 16) _qrCache.remove(_qrCache.keys.first);
  _qrCache[content] = encoded;
  return encoded;
}

/// The QR code of [content], dark on light with the quiet zone the standard asks for; a mark in its place when the
/// content is too long to encode.
class QrView extends StatelessWidget {
  const QrView(this.content, {super.key, this.size = 200});

  final String content;
  final double size;

  @override
  Widget build(BuildContext context) {
    final code = _cachedQrCode(content);
    if (code == null) {
      return SizedBox(width: size, height: size, child: const Center(child: Text('QR')));
    }
    return RepaintBoundary(
      child: Semantics(
        label: 'QR',
        image: true,
        child: CustomPaint(size: Size.square(size), painter: _QrPainter(code)),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.code);

  final QrCode code;

  /// The light margin around the code, in modules.
  static const int quiet = 4;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFFFFFFFF));
    final module = size.shortestSide / (code.size + 2 * quiet);
    final paint = Paint()
      ..color = const Color(0xFF000000)
      ..isAntiAlias = false;
    for (var y = 0; y < code.size; y++) {
      // Each run of dark modules in a row is one rectangle, drawn a hair wide so that no seam shows between rows.
      var x = 0;
      while (x < code.size) {
        if (!code.isDark(x, y)) {
          x++;
          continue;
        }
        final start = x;
        while (x < code.size && code.isDark(x, y)) {
          x++;
        }
        canvas.drawRect(Rect.fromLTRB((start + quiet) * module, (y + quiet) * module, (x + quiet) * module + 0.2, (y + quiet + 1) * module + 0.2), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) => oldDelegate.code != code;
}
