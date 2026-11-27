/// What the app needs from where it runs: a desktop, where it starts its own backend, or a browser, where the server
/// that gave it the page is its backend.
library;

import 'package:flutter/foundation.dart';

import 'host_stub.dart' if (dart.library.io) 'host_io.dart' if (dart.library.js_interop) 'host_web.dart' as implementation;

/// Copy [text] to the system clipboard, falling back to a DOM copy when the browser hides `navigator.clipboard`.
Future<void> copyToClipboard(String text) => implementation.copyToClipboard(text);

/// How far the local backend is.
enum BackendPhase {
  /// Its process is starting, or restarting after it ended.
  starting,

  /// It listens.
  running,

  /// It cannot start; [BackendStatus.message] says why.
  failed,

  /// Another Neo already runs for this user.
  alreadyRunning,
}

/// The local backend's state.
@immutable
class BackendStatus {
  const BackendStatus(this.phase, {this.port, this.token, this.message});

  final BackendPhase phase;

  /// The loopback port it listens on, while running.
  final int? port;

  /// The access token the app gave it.
  final String? token;

  /// What went wrong, in the backend's own words.
  final String? message;
}

/// The backend the desktop app starts and watches over.
abstract class LocalBackend {
  ValueListenable<BackendStatus> get status;

  /// Start it, or start it again after a failure.
  void start();

  /// End it; it also ends by itself when the app does.
  Future<void> stop();
}

/// Where the app runs.
abstract class Host {
  /// The host of this platform.
  static Host create() => implementation.createHost();

  /// A desktop app, which can start a local backend.
  bool get isDesktop;

  /// In a browser: the address the page came from, whose server is the backend.
  Uri? get pageOrigin;

  /// The app's own small settings: how it connects.
  Future<Map<String, String>> readPrefs();

  Future<void> writePrefs(Map<String, String> prefs);

  /// A local backend to start, on a desktop.
  LocalBackend? createLocalBackend();

  /// On a desktop: become the one running app. False when another one runs; it was asked to come to the front, and
  /// this one should end.
  Future<bool> claimSingleInstance(VoidCallback onFocusRequested);

  /// Bring the app's window to the front.
  Future<void> focusWindow();

  /// End the app.
  void quit();
}
