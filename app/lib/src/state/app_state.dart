/// The app's state: how it is connected, and what the backend last said — the conversation, the workers, its health.
library;

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../platform/host.dart';

/// Granular slices of [AppState] so widgets rebuild only when the data they actually display changes.
enum AppAspect {
  connection,
  messages,
  workers,
  workerDetail,
  activity,
  devices,
  health,
  badges,
}

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

  /// The multi-device control plane snapshot, when supported by the backend.
  DevicesOverview? devicesOverview;
  bool devicesUnsupported = false;

  // Per-aspect monotonic revisions for granular InheritedModel rebuilds.
  int connectionRev = 0;
  int messagesRev = 0;
  int workersRev = 0;
  int workerDetailRev = 0;
  int activityRev = 0;
  int devicesRev = 0;
  int healthRev = 0;
  int badgesRev = 0;

  LocalBackend? _backend;
  Timer? _timer;
  Future<void>? _running;
  int _ticks = 0;
  int _epoch = 0;
  int _activeTab = 0;
  bool _foreground = true;
  bool _started = false;
  bool _pollEndpointSupported = true;
  final Map<String, String> _pollEtags = {};
  String _messagesRaw = '';
  String? _messagesEtag;
  String _workersRaw = '';
  String? _workersEtag;
  String _activityRaw = '';
  String? _activityEtag;
  String _detailRaw = '';
  String? _detailEtag;
  String? _detailTicketId;
  String _devicesRaw = '';
  String? _devicesEtag;
  int _cachedActiveWorkers = 0;
  bool _disposed = false;

  int get activeWorkers => _cachedActiveWorkers;
  DeviceControlConfig? get deviceConfig => devicesOverview?.config;
  List<DeviceTwin> get devices => devicesOverview?.devices ?? const [];
  List<DeviceApproval> get deviceApprovals => devicesOverview?.approvals ?? const [];
  List<DeviceEnrollment> get deviceEnrollments => devicesOverview?.enrollments ?? const [];
  int get pendingDeviceApprovals => devicesOverview?.pendingApprovalsCount ?? 0;
  int get onlineDevices => devicesOverview?.onlineDevicesCount ?? 0;

  /// Tells polling which tab is currently visible so background tabs avoid unnecessary traffic.
  void setActiveTab(int tab) {
    if (_activeTab == tab) return;
    _activeTab = tab;
    if ((tab == 2 || tab == 3) && !devicesUnsupported && devicesOverview == null) {
      unawaited(refresh());
    } else if (tab == 1 && selectedWorkerId != null && detail == null) {
      unawaited(refresh());
    }
  }

  /// Pauses periodic background polling when the browser tab or app is hidden, and refreshes on resume.
  void setForeground(bool foreground) {
    if (_foreground == foreground || _disposed) return;
    _foreground = foreground;
    if (!foreground) {
      _timer?.cancel();
      _timer = null;
    } else if (_started) {
      _startTimer();
      unawaited(refresh());
    }
  }

  void _startTimer() {
    _timer?.cancel();
    if (!_foreground || _disposed) return;
    // A poll that finds one still under way leaves it be.
    _timer = Timer.periodic(pollEvery, (_) {
      if (_running == null && _foreground) unawaited(refresh());
    });
  }

  /// Read how to connect, and connect.
  Future<void> start() async {
    _started = true;
    final prefs = await host.readPrefs();
    if (host.isDesktop) {
      config = ConnectionConfig(local: prefs['mode'] != 'remote', url: prefs['url'] ?? '', token: prefs['token'] ?? '');
    } else {
      // In a browser the page's own server is the backend; only the token is the person's to give.
      config = ConnectionConfig(local: false, url: host.pageOrigin?.toString() ?? prefs['url'] ?? '', token: prefs['token'] ?? '');
    }
    _connect();
    _startTimer();
  }

  /// Connect another way from now on.
  Future<void> applyConnection(ConnectionConfig next) async {
    config = next;
    await host.writePrefs(next.toPrefs());
    _connect();
  }

  /// Try again after a failure.
  void retry() => _connect();

  void _bumpAll() {
    connectionRev++;
    messagesRev++;
    workersRev++;
    workerDetailRev++;
    activityRev++;
    devicesRev++;
    healthRev++;
    badgesRev++;
  }

  void _setClient(ApiClient? next) {
    client?.close();
    client = next;
    _epoch++;
    _ticks = 0;
    _pollEndpointSupported = true;
    _pollEtags.clear();
    messages = const [];
    workers = const [];
    _cachedActiveWorkers = 0;
    health = null;
    activity = const Activity.idle();
    detail = null;
    devicesOverview = null;
    devicesUnsupported = false;
    _messagesRaw = '';
    _messagesEtag = null;
    _workersRaw = '';
    _workersEtag = null;
    _activityRaw = '';
    _activityEtag = null;
    _detailRaw = '';
    _detailEtag = null;
    _detailTicketId = null;
    _devicesRaw = '';
    _devicesEtag = null;
    _bumpAll();
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

  Future<void> _refresh() async {
    final api = client;
    if (api == null) return;
    final epoch = _epoch;
    var changed = false;
    try {
      final wantHealth = health == null || _ticks % 5 == 0;
      final tick = _ticks++;
      final selected = selectedWorkerId;
      final wantDevices = !devicesUnsupported && (devicesOverview == null || _activeTab == 2 || _activeTab == 3 || tick % 3 == 0);

      if (_pollEndpointSupported) {
        final include = <String>{'m', 'w', 'a'};
        if (wantDevices) include.add('d');
        if (selected != null) include.add('wd');
        if (wantHealth) include.add('h');

        final poll = await api.poll(
          include: include,
          etags: _pollEtags,
          workerId: selected,
          wantHealth: wantHealth,
          previousMessages: messages,
        );
        if (epoch != _epoch) return;
        if (poll != null) {
          if (!poll.unchanged) {
            _pollEtags.addAll(poll.etags);
            if (poll.messages != null) {
              messages = poll.messages!;
              messagesRev++;
              changed = true;
            }
            if (poll.workers != null) {
              final prevActive = _cachedActiveWorkers;
              workers = poll.workers!;
              _cachedActiveWorkers = workers.where((w) => w.active).length;
              workersRev++;
              if (_cachedActiveWorkers != prevActive) badgesRev++;
              changed = true;
            }
            if (poll.activity != null) {
              activity = poll.activity!;
              activityRev++;
              changed = true;
            }
            if (poll.devices != null) {
              final prevApprovals = pendingDeviceApprovals;
              devicesOverview = poll.devices;
              devicesRev++;
              if (pendingDeviceApprovals != prevApprovals) badgesRev++;
              changed = true;
            }
            if (selected != null && selected == selectedWorkerId && poll.hasWorkerDetail) {
              detail = poll.workerDetail;
              workerDetailRev++;
              changed = true;
            }
            if (poll.health != null) {
              final prev = health;
              final next = poll.health!;
              final connChanged = prev == null || prev.paused != next.paused || prev.kernelProblem != next.kernelProblem;
              health = next;
              healthRev++;
              if (connChanged) connectionRev++;
              changed = true;
            }
          }
          if (link != Link.online) {
            link = Link.online;
            linkDetail = null;
            connectionRev++;
            changed = true;
          }
          if (changed) _notify();
          return;
        }
        // Older backend or test fixture without /api/poll: fall back cleanly to individual endpoints.
        _pollEndpointSupported = false;
      }

      if (_detailTicketId != selected) {
        _detailTicketId = selected;
        _detailRaw = '';
        _detailEtag = null;
      }

      final messagesFuture = api.messagesIfChanged(ifNoneMatch: _messagesEtag, previousRaw: _messagesRaw, previousMessages: messages);
      final workersFuture = api.workersIfChanged(ifNoneMatch: _workersEtag, previousRaw: _workersRaw);
      final activityFuture = api.activityIfChanged(ifNoneMatch: _activityEtag, previousRaw: _activityRaw);
      final healthFuture = wantHealth ? api.health() : Future<Health?>.value(null);
      final detailFuture = selected != null
          ? api.workerIfChanged(selected, ifNoneMatch: _detailEtag, previousRaw: _detailRaw)
          : Future<ConditionalResult<Worker?>?>.value(null);
      final devicesFuture = wantDevices
          ? api.devicesOverviewIfChanged(ifNoneMatch: _devicesEtag, previousRaw: _devicesRaw)
          : Future<(ConditionalResult<DevicesOverview?>, bool)?>.value(null);

      await Future.wait<Object?>([messagesFuture, workersFuture, activityFuture, healthFuture, detailFuture, devicesFuture]);
      final msgRes = await messagesFuture;
      final workersRes = await workersFuture;
      final activityRes = await activityFuture;
      final fetchedHealth = await healthFuture;
      final detailRes = await detailFuture;
      final devicesPair = await devicesFuture;
      if (epoch != _epoch) return;

      _messagesEtag = msgRes.etag;
      if (msgRes.changed) {
        _messagesRaw = msgRes.raw;
        messages = msgRes.value!;
        messagesRev++;
        changed = true;
      }

      _workersEtag = workersRes.etag;
      if (workersRes.changed) {
        _workersRaw = workersRes.raw;
        final prevActive = _cachedActiveWorkers;
        workers = workersRes.value!;
        _cachedActiveWorkers = workers.where((worker) => worker.active).length;
        workersRev++;
        if (_cachedActiveWorkers != prevActive) badgesRev++;
        changed = true;
      }

      _activityEtag = activityRes.etag;
      if (activityRes.changed) {
        _activityRaw = activityRes.raw;
        activity = activityRes.value!;
        activityRev++;
        changed = true;
      }

      if (fetchedHealth != null) {
        final connChanged = health == null || health?.paused != fetchedHealth.paused || health?.kernelProblem != fetchedHealth.kernelProblem;
        final healthChanged = connChanged || health?.version != fetchedHealth.version || health?.components.length != fetchedHealth.components.length;
        health = fetchedHealth;
        if (healthChanged) healthRev++;
        if (connChanged) {
          connectionRev++;
          changed = true;
        }
      }

      if (selected != null && selected == selectedWorkerId && detailRes != null) {
        _detailEtag = detailRes.etag;
        if (detailRes.changed) {
          _detailRaw = detailRes.raw;
          detail = detailRes.value;
          workerDetailRev++;
          changed = true;
        }
      }

      if (devicesPair != null) {
        final (devRes, unsupported) = devicesPair;
        if (unsupported != devicesUnsupported) {
          devicesUnsupported = unsupported;
          if (unsupported) {
            final prevApprovals = pendingDeviceApprovals;
            devicesOverview = null;
            _devicesRaw = '';
            _devicesEtag = null;
            if (prevApprovals != 0) badgesRev++;
          }
          devicesRev++;
          connectionRev++;
          changed = true;
        }
        if (!unsupported) {
          _devicesEtag = devRes.etag;
          if (devRes.changed && devRes.value != null) {
            final prevApprovals = pendingDeviceApprovals;
            _devicesRaw = devRes.raw;
            devicesOverview = devRes.value;
            devicesRev++;
            if (pendingDeviceApprovals != prevApprovals) badgesRev++;
            changed = true;
          }
        }
      }

      if (link != Link.online) {
        link = Link.online;
        linkDetail = null;
        connectionRev++;
        changed = true;
      }
    } on ApiException catch (error) {
      if (epoch != _epoch) return;
      final next = error.unauthorized ? Link.tokenNeeded : Link.offline;
      if (link != next || linkDetail != error.message) {
        link = next;
        linkDetail = error.message;
        connectionRev++;
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
    _pollEtags.remove('m');
    _messagesRaw = '';
    _messagesEtag = null;
    await refresh();
  }

  /// Stop a task together with its worker, subagents and background jobs.
  Future<Worker> stopWorker(String ticketId) async {
    final api = client;
    if (api == null) throw ApiException(0, 'offline');
    final stopped = await api.stopWorker(ticketId);
    if (selectedWorkerId == ticketId) {
      detail = stopped;
      workerDetailRev++;
    }
    final prevActive = _cachedActiveWorkers;
    workers = List<Worker>.unmodifiable([for (final worker in workers) worker.ticketId == ticketId ? stopped : worker]);
    _cachedActiveWorkers = workers.where((worker) => worker.active).length;
    workersRev++;
    if (_cachedActiveWorkers != prevActive) badgesRev++;
    _pollEtags.remove('w');
    _pollEtags.remove('wd');
    _workersRaw = '';
    _workersEtag = null;
    _detailRaw = '';
    _detailEtag = null;
    _notify();
    await refresh();
    return stopped;
  }

  /// Show a worker's detail, or none.
  void selectWorker(String? ticketId) {
    if (selectedWorkerId == ticketId) return;
    selectedWorkerId = ticketId;
    detail = null;
    _pollEtags.remove('wd');
    _detailTicketId = ticketId;
    _detailRaw = '';
    _detailEtag = null;
    workerDetailRev++;
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
