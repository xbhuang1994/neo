/// The app's state: how it is connected, and what the backend last said — the conversation, the workers, its health.
library;

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../platform/host.dart';

/// How the app reaches its backend.
@immutable
class ConnectionConfig {
  const ConnectionConfig({required this.local, this.url = '', this.token = ''});

  /// Use the backend this app starts on this computer.
  final bool local;

  /// Else: the server's address.
  final String url;

  /// And its access token, if it wants one.
  final String token;

  Map<String, String> toPrefs() => {'mode': local ? 'local' : 'remote', 'url': url, 'token': token};
}

/// Where the connection stands.
enum Link {
  /// The local backend is starting.
  starting,

  /// The first answer is awaited.
  connecting,
  online,

  /// The backend does not answer.
  offline,

  /// The backend wants an access token, or another one.
  tokenNeeded,

  /// The local backend cannot start.
  backendFailed,

  /// Another Neo already runs on this computer.
  alreadyRunning,
}

/// A server address as typed, made whole: `http://` is assumed, a path is dropped. Null when it is no address.
Uri? parseServerAddress(String typed) {
  var text = typed.trim();
  if (text.isEmpty) return null;
  if (!text.contains('://')) text = 'http://$text';
  final uri = Uri.tryParse(text);
  if (uri == null || uri.host.isEmpty || (uri.scheme != 'http' && uri.scheme != 'https')) return null;
  // A host is a name or an address, not whatever else parses.
  if (!RegExp(r'^[A-Za-z0-9.\-:]+$').hasMatch(uri.host)) return null;
  return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
}

/// A new id for a chat message, which makes sending it again the same message.
String newMessageId() {
  final random = Random.secure();
  return 'web:${[for (var i = 0; i < 12; i++) random.nextInt(256).toRadixString(16).padLeft(2, '0')].join()}';
}

typedef ClientFactory = ApiClient Function(Uri base, String? token);

/// The app's state.
class AppState extends ChangeNotifier {
  AppState(this.host, {ClientFactory? clients, this.pollEvery = const Duration(seconds: 2)}) : _clients = clients ?? ((base, token) => ApiClient(base, token: token));

  final Host host;
  final Duration pollEvery;
  final ClientFactory _clients;

  ConnectionConfig config = const ConnectionConfig(local: true);
  Link link = Link.connecting;

  /// What the backend or the network said, when the link is not online.
  String? linkDetail;
  ApiClient? client;
  List<ChatMessage> messages = const [];
  List<Worker> workers = const [];
  Health? health;

  /// What is at work now, for the ticker.
  Activity activity = const Activity.idle();

  /// The worker whose detail is shown, with its recent activity.
  Worker? detail;
  String? selectedWorkerId;

  LocalBackend? _backend;
  Timer? _timer;
  Future<void>? _running;
  int _ticks = 0;
  int _epoch = 0;
  String _messagesRaw = '';
  String _workersRaw = '';
  bool _disposed = false;

  int get activeWorkers => workers.where((worker) => worker.active).length;

  /// Read how to connect, and connect.
  Future<void> start() async {
    final prefs = await host.readPrefs();
    if (host.isDesktop) {
      config = ConnectionConfig(local: prefs['mode'] != 'remote', url: prefs['url'] ?? '', token: prefs['token'] ?? '');
    } else {
      // In a browser the page's own server is the backend; only the token is the person's to give.
      config = ConnectionConfig(local: false, url: host.pageOrigin?.toString() ?? prefs['url'] ?? '', token: prefs['token'] ?? '');
    }
    _connect();
    // A poll that finds one still under way leaves it be.
    _timer = Timer.periodic(pollEvery, (_) {
      if (_running == null) unawaited(refresh());
    });
  }

  /// Connect another way from now on.
  Future<void> applyConnection(ConnectionConfig next) async {
    config = next;
    await host.writePrefs(next.toPrefs());
    _connect();
  }

  /// Try again after a failure.
  void retry() => _connect();

  void _setClient(ApiClient? next) {
    client?.close();
    client = next;
    _epoch++;
    messages = const [];
    workers = const [];
    health = null;
    activity = const Activity.idle();
    detail = null;
    _messagesRaw = '';
    _workersRaw = '';
  }

  void _connect() {
    if (config.local && host.isDesktop) {
      _setClient(null);
      link = Link.starting;
      linkDetail = null;
      final backend = _backend ??= host.createLocalBackend()!..status.addListener(_backendChanged);
      backend.start();
      _backendChanged();
    } else {
      final backend = _backend;
      if (backend != null) {
        backend.status.removeListener(_backendChanged);
        unawaited(backend.stop());
        _backend = null;
      }
      final base = parseServerAddress(config.url);
      _setClient(base == null ? null : _clients(base, config.token.isEmpty ? null : config.token));
      link = base == null ? Link.offline : Link.connecting;
      linkDetail = null;
      _notify();
      unawaited(refresh());
    }
  }

  void _backendChanged() {
    final status = _backend?.status.value;
    if (status == null || !config.local) return;
    switch (status.phase) {
      case BackendPhase.running:
        _setClient(_clients(Uri.parse('http://127.0.0.1:${status.port}'), status.token));
        link = Link.connecting;
        linkDetail = null;
        unawaited(refresh());
      case BackendPhase.starting:
        _setClient(null);
        link = Link.starting;
        linkDetail = status.message;
      case BackendPhase.failed:
        _setClient(null);
        link = Link.backendFailed;
        linkDetail = status.message;
      case BackendPhase.alreadyRunning:
        _setClient(null);
        link = Link.alreadyRunning;
        linkDetail = status.message;
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Ask the backend for what changed. A call made while another runs waits for it and then asks again, so that what
  /// it returns is never older than the call.
  Future<void> refresh() async {
    while (_running != null) {
      await _running;
    }
    final run = _refresh();
    _running = run;
    try {
      await run;
    } finally {
      if (identical(_running, run)) _running = null;
    }
  }

  Future<Worker?> _fetchSelectedWorker(ApiClient api, String ticketId) async {
    try {
      return await api.worker(ticketId);
    } on ApiException catch (error) {
      if (error.status == 404) return null;
      rethrow;
    }
  }

  Future<void> _refresh() async {
    final api = client;
    if (api == null) return;
    final epoch = _epoch;
    var changed = false;
    try {
      final wantHealth = health == null || _ticks % 5 == 0;
      _ticks++;
      final selected = selectedWorkerId;
      final messagesFuture = api.messages();
      final workersFuture = api.workers();
      final activityFuture = api.activity();
      final healthFuture = wantHealth ? api.health() : Future<Health?>.value(null);
      final detailFuture = selected != null ? _fetchSelectedWorker(api, selected) : Future<Worker?>.value(null);
      await Future.wait<Object?>([messagesFuture, workersFuture, activityFuture, healthFuture, detailFuture]);
      final (fetched, raw) = await messagesFuture;
      final fetchedWorkers = await workersFuture;
      final fetchedActivity = await activityFuture;
      final fetchedHealth = await healthFuture;
      final fetchedDetail = await detailFuture;
      if (epoch != _epoch) return;
      if (raw != _messagesRaw) {
        _messagesRaw = raw;
        messages = fetched;
        changed = true;
      }
      final workersRaw = fetchedWorkers.map((worker) => worker.raw).join('\n');
      if (workersRaw != _workersRaw) {
        _workersRaw = workersRaw;
        workers = fetchedWorkers;
        changed = true;
      }
      if (fetchedActivity.raw != activity.raw) {
        activity = fetchedActivity;
        changed = true;
      }
      if (fetchedHealth != null) {
        changed = changed || health?.paused != fetchedHealth.paused || health?.kernelProblem != fetchedHealth.kernelProblem || health == null;
        health = fetchedHealth;
      }
      if (selected != null && selected == selectedWorkerId && fetchedDetail?.raw != detail?.raw) {
        detail = fetchedDetail;
        changed = true;
      }
      if (link != Link.online) {
        link = Link.online;
        linkDetail = null;
        changed = true;
      }
    } on ApiException catch (error) {
      if (epoch != _epoch) return;
      final next = error.unauthorized ? Link.tokenNeeded : Link.offline;
      if (link != next || linkDetail != error.message) {
        link = next;
        linkDetail = error.message;
        changed = true;
      }
    }
    if (changed) _notify();
  }

  /// Send a chat message. The same [messageId] is the same message, so a retry after a failure repeats nothing.
  Future<void> send(String text, List<OutgoingFile> files, String messageId) async {
    final api = client;
    if (api == null) throw ApiException(0, 'offline');
    await api.chat(text, files, messageId);
    await refresh();
  }

  /// Empty the conversation; tickets and workers stay.
  Future<void> resetConversation() async {
    final api = client;
    if (api == null) throw ApiException(0, 'offline');
    await api.resetSession();
    await refresh();
  }

  /// Show a worker's detail, or none.
  void selectWorker(String? ticketId) {
    if (selectedWorkerId == ticketId) return;
    selectedWorkerId = ticketId;
    detail = null;
    _notify();
    unawaited(refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _backend?.status.removeListener(_backendChanged);
    unawaited(_backend?.stop());
    client?.close();
    super.dispose();
  }
}
