import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

import 'host.dart';

/// The browser: the page's server is the backend, and the browser's storage keeps the access token.
Host createHost() => _WebHost();

/// Copy [text] to the browser clipboard, falling back to `document.execCommand('copy')` on non-HTTPS origins.
Future<void> copyToClipboard(String text) async {
  if (!web.window.isSecureContext) {
    _copyViaDom(text);
    return;
  }
  try {
    await Clipboard.setData(ClipboardData(text: text));
    return;
  } on Object {
    // Fall back to execCommand when navigator.clipboard is unavailable or blocked.
  }
  _copyViaDom(text);
}

void _copyViaDom(String text) {
  final body = web.document.body;
  if (body == null) return;
  final previous = web.document.activeElement;
  final textarea = web.HTMLTextAreaElement()
    ..value = text
    ..readOnly = true;
  textarea.style
    ..position = 'fixed'
    ..left = '-9999px'
    ..top = '0'
    ..opacity = '0';
  body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    web.document.execCommand('copy');
  } on Object {
    // Ignore if the browser denies clipboard writes.
  } finally {
    textarea.remove();
    if (previous != null && previous.isA<web.HTMLElement>()) {
      try {
        (previous as web.HTMLElement).focus();
      } on Object {
        // Ignore focus restoration errors.
      }
    }
  }
}

class _WebHost implements Host {
  static const _key = 'neo-agent';

  @override
  bool get isDesktop => false;

  @override
  Uri? get pageOrigin => Uri.parse(Uri.base.origin);

  @override
  Future<Map<String, String>> readPrefs() async {
    try {
      final stored = web.window.localStorage.getItem(_key);
      if (stored == null) return {};
      return (jsonDecode(stored) as Map).map((key, value) => MapEntry(key.toString(), value.toString()));
    } on Object {
      // Storage that is unavailable or holds something else is as good as empty.
      return {};
    }
  }

  @override
  Future<void> writePrefs(Map<String, String> prefs) async {
    try {
      web.window.localStorage.setItem(_key, jsonEncode(prefs));
    } on Object {
      // Private browsing may refuse storage; the token then lasts as long as the page.
    }
  }

  @override
  LocalBackend? createLocalBackend() => null;

  @override
  Future<bool> claimSingleInstance(VoidCallback onFocusRequested) async => true;

  @override
  Future<void> focusWindow() async {}

  @override
  void quit() {}
}
