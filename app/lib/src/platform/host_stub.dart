import 'package:flutter/services.dart';

import 'host.dart';

/// A host for platforms that are neither a desktop nor a browser: nothing local, nothing stored.
Host createHost() => _NoHost();

/// Copy [text] to the system clipboard.
Future<void> copyToClipboard(String text) => Clipboard.setData(ClipboardData(text: text));

class _NoHost implements Host {
  @override
  bool get isDesktop => false;

  @override
  Uri? get pageOrigin => null;

  @override
  Future<Map<String, String>> readPrefs() async => {};

  @override
  Future<void> writePrefs(Map<String, String> prefs) async {}

  @override
  LocalBackend? createLocalBackend() => null;

  @override
  Future<bool> claimSingleInstance(VoidCallback onFocusRequested) async => true;

  @override
  Future<void> focusWindow() async {}

  @override
  void quit() {}
}
