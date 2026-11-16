import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'host.dart';

/// The desktop: the app starts the backend that is installed beside it, and only one app runs per user.
Host createHost() => DesktopHost();

/// The exit status with which the backend says another instance runs.
const int alreadyRunningStatus = 3;

/// Where the backend program is: named by `NEO_AGENT_BIN`, else installed beside the app, else on `PATH`.
String? findBackend({required String executable, required Map<String, String> environment, bool Function(String path)? exists}) {
  final isFile = exists ?? (path) => File(path).existsSync();
  final named = environment['NEO_AGENT_BIN'];
  if (named != null && named.isNotEmpty) return isFile(named) ? named : null;
  final separator = Platform.pathSeparator;
  final name = Platform.isWindows ? 'neo-agent.exe' : 'neo-agent';
  final folder = File(executable).parent;
  final beside = [
    // A macOS app bundle keeps helper programs in Contents/Helpers, beside Contents/MacOS.
    '${folder.parent.path}${separator}Helpers$separator$name',
    '${folder.path}$separator$name',
    '${folder.path}${separator}lib$separator$name',
  ];
  for (final candidate in beside) {
    if (isFile(candidate)) return candidate;
  }
  final listSeparator = Platform.isWindows ? ';' : ':';
  for (final entry in (environment['PATH'] ?? '').split(listSeparator)) {
    if (entry.isEmpty) continue;
    final candidate = '$entry$separator$name';
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/// The search path the backend gets. An app started from the Finder or a launcher has only the system's own folders
/// on its path, without those where people install git and the agent runtimes.
String backendPath(Map<String, String> environment) {
  final current = environment['PATH'] ?? '';
  if (Platform.isWindows) return current;
  final home = environment['HOME'] ?? '';
  final usual = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    if (home.isNotEmpty) ...['$home/.local/bin', '$home/.bun/bin', '$home/.cargo/bin', '$home/.npm-global/bin'],
  ];
  final entries = current.split(':').where((entry) => entry.isNotEmpty).toList();
  for (final folder in usual) {
    if (!entries.contains(folder)) entries.add(folder);
  }
  return entries.join(':');
}

String _token() {
  final random = Random.secure();
  return [for (var i = 0; i < 32; i++) random.nextInt(256).toRadixString(16).padLeft(2, '0')].join();
}

/// The backend as a child process, restarted when it ends by itself.
class Sidecar implements LocalBackend {
  Sidecar({this.program, Map<String, String>? environment}) : _environment = environment ?? Platform.environment;

  /// The backend program; found beside the app when not given.
  final String? program;
  final Map<String, String> _environment;
  final ValueNotifier<BackendStatus> _status = ValueNotifier(const BackendStatus(BackendPhase.starting));
  Process? _process;
  Timer? _restart;
  bool _stopped = false;
  int _failures = 0;
  int _generation = 0;

  @override
  ValueListenable<BackendStatus> get status => _status;

  @override
  void start() {
    _stopped = false;
    _restart?.cancel();
    if (_process != null) return;
    unawaited(_launch());
  }

  Future<void> _launch() async {
    final generation = ++_generation;
    final program = this.program ?? findBackend(executable: Platform.resolvedExecutable, environment: _environment);
    if (program == null) {
      _status.value = const BackendStatus(BackendPhase.failed, message: 'neo-agent was not found beside the app');
      return;
    }
    _status.value = const BackendStatus(BackendPhase.starting);
    final token = _token();
    final Process process;
    try {
      process = await Process.start(program, ['desktop-sidecar', '--port', '0', '--token-stdin'], environment: {'PATH': backendPath(_environment)});
    } on ProcessException catch (error) {
      _status.value = BackendStatus(BackendPhase.failed, message: error.message);
      return;
    }
    if (_stopped || generation != _generation) {
      process.kill();
      return;
    }
    _process = process;
    // The backend reads its token from the first line, and lives for as long as this pipe stays open.
    process.stdin.writeln(token);
    unawaited(process.stdin.flush().catchError((Object _) {}));
    final errors = <String>[];
    final errorsRead = process.stderr
        .transform(const Utf8Decoder(allowMalformed: true))
        .transform(const LineSplitter())
        .listen((line) {
          errors.add(line);
          if (errors.length > 40) errors.removeAt(0);
        })
        .asFuture<void>()
        .catchError((Object _) {});
    process.stdout.transform(const Utf8Decoder(allowMalformed: true)).transform(const LineSplitter()).listen((line) {
      if (generation != _generation || _status.value.phase == BackendPhase.running) return;
      try {
        final said = jsonDecode(line);
        if (said is Map && said['port'] is int) {
          _failures = 0;
          _status.value = BackendStatus(BackendPhase.running, port: said['port'] as int, token: token);
        }
      } on FormatException {
        // Not the line that says where it listens.
      }
    }, onError: (Object _) {});
    final code = await process.exitCode;
    // The exit can be seen before the last of what it wrote is read; a child that keeps the pipe open is not waited for.
    await errorsRead.timeout(const Duration(seconds: 1), onTimeout: () {});
    if (generation != _generation) return;
    _process = null;
    if (_stopped) return;
    // What the backend said last that is not its log prefix alone.
    final said = errors.lastWhere((line) => line.trim().isNotEmpty && !line.startsWith('[neo-agent] Stopping'), orElse: () => 'exit status $code');
    if (code == alreadyRunningStatus) {
      _status.value = BackendStatus(BackendPhase.alreadyRunning, message: said);
      return;
    }
    _failures++;
    if (_failures >= 5) {
      _status.value = BackendStatus(BackendPhase.failed, message: said);
      return;
    }
    _status.value = BackendStatus(BackendPhase.starting, message: said);
    _restart = Timer(Duration(seconds: min(30, 1 << (_failures - 1))), () => unawaited(_launch()));
  }

  @override
  Future<void> stop() async {
    _stopped = true;
    _restart?.cancel();
    final process = _process;
    _process = null;
    if (process == null) return;
    // Closing its input asks it to end in order; it is ended outright if it does not.
    unawaited(process.stdin.close().catchError((Object _) {}));
    await process.exitCode.timeout(const Duration(seconds: 5), onTimeout: () {
      process.kill();
      return -1;
    });
  }
}

/// The folder for the app's own files: beside the backend's data on macOS and Windows, under the user's
/// configuration elsewhere.
String appFolder(Map<String, String> environment) {
  final separator = Platform.pathSeparator;
  if (Platform.isMacOS) return '${environment['HOME']}/Library/Application Support/neo-agent';
  if (Platform.isWindows) {
    final local = environment['LOCALAPPDATA'] ?? '${environment['USERPROFILE']}${separator}AppData${separator}Local';
    return '$local${separator}neo-agent';
  }
  final config = environment['XDG_CONFIG_HOME'];
  return '${config != null && config.startsWith('/') ? config : '${environment['HOME']}/.config'}/neo-agent';
}

/// The desktop host.
class DesktopHost implements Host {
  DesktopHost({String? folder}) : _folder = folder ?? appFolder(Platform.environment);

  static const _window = MethodChannel('neo_agent/window');
  static const _hello = 'neo-agent-focus';
  final String _folder;
  ServerSocket? _listening;

  File get _prefs => File('$_folder${Platform.pathSeparator}app.json');
  File get _instance => File('$_folder${Platform.pathSeparator}app-instance.json');

  @override
  bool get isDesktop => true;

  @override
  Uri? get pageOrigin => null;

  @override
  Future<Map<String, String>> readPrefs() async {
    try {
      return (jsonDecode(await _prefs.readAsString()) as Map).map((key, value) => MapEntry(key.toString(), value.toString()));
    } on Object {
      // No file yet, or one that is not ours: start from nothing.
      return {};
    }
  }

  @override
  Future<void> writePrefs(Map<String, String> prefs) async {
    await Directory(_folder).create(recursive: true);
    await _prefs.writeAsString(jsonEncode(prefs));
  }

  @override
  LocalBackend? createLocalBackend() => Sidecar();

  @override
  Future<bool> claimSingleInstance(VoidCallback onFocusRequested) async {
    // The running app listens on a loopback port it wrote down; whoever starts next asks it to come to the front.
    try {
      final port = (jsonDecode(await _instance.readAsString()) as Map)['port'] as int;
      final socket = await Socket.connect(InternetAddress.loopbackIPv4, port, timeout: const Duration(seconds: 1));
      socket.writeln(_hello);
      await socket.flush();
      final answer = await socket.cast<List<int>>().transform(utf8.decoder).first.timeout(const Duration(seconds: 2), onTimeout: () => '');
      socket.destroy();
      if (answer.trim() == 'ok') return false;
    } on Object {
      // Nobody answers there: this is the first app.
    }
    try {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      _listening = server;
      server.listen((socket) {
        socket.cast<List<int>>().transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
          if (line.trim() != _hello) return;
          socket.writeln('ok');
          unawaited(socket.flush().then((_) => socket.destroy()).catchError((Object _) {}));
          onFocusRequested();
        }, onError: (Object _) {});
      });
      await Directory(_folder).create(recursive: true);
      await _instance.writeAsString(jsonEncode({'port': server.port, 'pid': pid}));
    } on Object {
      // Without the port this app cannot be asked to the front; the backend still refuses a second instance.
    }
    return true;
  }

  @override
  Future<void> focusWindow() async {
    try {
      await _window.invokeMethod<void>('focus');
    } on MissingPluginException {
      // A platform without the handler leaves the window where it is.
    } on PlatformException {
      // The same when the window refuses.
    }
  }

  @override
  void quit() {
    unawaited(_listening?.close());
    exit(0);
  }
}
