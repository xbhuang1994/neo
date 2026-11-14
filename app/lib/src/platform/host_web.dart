import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

import 'host.dart';

/// The browser: the page's server is the backend, and the browser's storage keeps the access token.
Host createHost() => _WebHost();

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
