/// How a message's text is shown: plain text and code blocks, with JSON and fenced code recognised.
library;

import 'dart:collection';
import 'dart:convert';

/// A stretch of a message.
sealed class Segment {
  const Segment(this.text);

  final String text;
}

/// Running text.
class TextSegment extends Segment {
  const TextSegment(super.text);
}

/// A block of code, with the name of its language for a label.
class CodeSegment extends Segment {
  const CodeSegment(super.text, this.language);

  final String language;
}

final RegExp _fence = RegExp(r'```([\w+-]*)[^\S\n]*\n?([\s\S]*?)```');
final RegExp _trailingNewline = RegExp(r'\n$');
final RegExp _config = RegExp(r'(?:^|\n)\s*(?:[\w.-]+\s*=|[\w.-]+\s*:\s|\[[\w.-]+\])');
final RegExp _attachment = RegExp(r'\n*<attachment name="[^"\n]*"[^>\n]*>\n[\s\S]*?\n</attachment>');

const int _cacheCapacity = 256;
final LinkedHashMap<String, List<Segment>> _formatCache = LinkedHashMap<String, List<Segment>>();
final LinkedHashMap<String, String> _stripCache = LinkedHashMap<String, String>();

/// Split a message into text and code: a message that is JSON is shown indented; fenced blocks are code; several
/// lines that read like settings are code; anything else is text.
List<Segment> formatMessage(String text) {
  final cached = _formatCache.remove(text);
  if (cached != null) {
    _formatCache[text] = cached;
    return cached;
  }
  final result = List<Segment>.unmodifiable(_computeSegments(text));
  if (_formatCache.length >= _cacheCapacity) {
    _formatCache.remove(_formatCache.keys.first);
  }
  _formatCache[text] = result;
  return result;
}

List<Segment> _computeSegments(String text) {
  final trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [CodeSegment(const JsonEncoder.withIndent('  ').convert(jsonDecode(trimmed)), 'JSON')];
    } on FormatException {
      // Not whole JSON: shown as it is.
    }
  }
  if (text.contains('```')) {
    final segments = <Segment>[];
    var cursor = 0;
    for (final match in _fence.allMatches(text)) {
      final before = text.substring(cursor, match.start).trim();
      if (before.isNotEmpty) segments.add(TextSegment(before));
      final language = match.group(1)!;
      segments.add(CodeSegment(match.group(2)!.replaceFirst(_trailingNewline, ''), language.isEmpty ? 'code' : language));
      cursor = match.end;
    }
    if (segments.isNotEmpty) {
      final rest = text.substring(cursor).trim();
      if (rest.isNotEmpty) segments.add(TextSegment(rest));
      return segments;
    }
  }
  if (text.contains('\n') && _config.hasMatch(text)) return [CodeSegment(text, 'config')];
  return [TextSegment(text)];
}

/// Whether a message is shown folded at first: more than 700 characters or 12 lines.
bool isLong(String text) {
  if (text.length > 700) return true;
  var count = 0;
  var pos = 0;
  while (true) {
    final next = text.indexOf('\n', pos);
    if (next == -1) return false;
    count++;
    if (count >= 12) return true;
    pos = next + 1;
  }
}

/// A person's message without the blocks that carry its attachments, which the app shows as files beside it.
String withoutAttachments(String text) {
  if (!text.contains('<attachment')) {
    final trimmed = text.trim();
    return trimmed == '请查看附件。' ? '' : trimmed;
  }
  final cached = _stripCache.remove(text);
  if (cached != null) {
    _stripCache[text] = cached;
    return cached;
  }
  final stripped = text.replaceAll(_attachment, '').trim();
  final result = stripped == '请查看附件。' ? '' : stripped;
  if (_stripCache.length >= _cacheCapacity) {
    _stripCache.remove(_stripCache.keys.first);
  }
  _stripCache[text] = result;
  return result;
}

/// A time of day as `HH:mm`, with the date before it when it is not today.
String clockTime(DateTime time, {DateTime? now}) {
  final today = now ?? DateTime.now();
  String two(int value) => value < 10 ? '0$value' : '$value';
  final clock = '${two(time.hour)}:${two(time.minute)}';
  if (time.year == today.year && time.month == today.month && time.day == today.day) return clock;
  return '${time.month}/${time.day} $clock';
}

/// A count of bytes for people: `812 B`, `1.4 KB`, `3.2 MB`.
String byteSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// The media type a file name's extension stands for, for the files a person attaches.
String mediaTypeOf(String name) {
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return const {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'pdf': 'application/pdf',
        'txt': 'text/plain',
        'md': 'text/markdown',
        'json': 'application/json',
        'csv': 'text/csv',
        'zip': 'application/zip',
      }[extension] ??
      '';
}
