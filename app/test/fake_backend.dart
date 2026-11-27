import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neo_agent/src/api/client.dart';
import 'package:neo_agent/src/platform/host.dart';
import 'package:neo_agent/src/state/app_state.dart';

/// A backend in memory that answers the API as the real one does, for the app's tests.
class FakeBackend {
  FakeBackend({this.token});

  /// The token calls must carry, when set.
  final String? token;

  /// Answer nothing: every call fails to connect.
  bool down = false;

  /// Refuse the next chat message with this error.
  String? chatError;
  final List<Map<String, dynamic>> messages = [];
  final List<Map<String, dynamic>> workers = [];
  final Map<String, Map<String, dynamic>> details = {};

  /// What `/api/activity` says is at work; null answers 404, as a backend too old to say.
  Map<String, dynamic>? activity = {'router': false, 'workers': <Map<String, dynamic>>[]};
  final List<Map<String, dynamic>> chats = [];
  final List<String> calls = [];
  final List<String> stopped = [];
  String? stopError;
  int resets = 0;

  /// Antigravity is still listing its models; the page asks again until it is done.
  bool antigravityListing = false;

  /// How many times the models were asked for.
  int modelReads = 0;

  /// Why Antigravity cannot run; set, its program is not installed until the app installs it.
  String? antigravityProblem;
  final List<String> installed = [];

  /// Set, an install answers only once it completes; meanwhile Antigravity is being installed, as far as
  /// [installProgress] says.
  Completer<void>? installGate;
  String? installProgress;
  bool _installingNow = false;
  Map<String, dynamic> models = {'eval': null, 'executor': null};
  Map<String, dynamic> general = {
    'paused': false,
    'recoveryMode': true,
    'eval': {'mode': 'observe', 'timeoutSeconds': 120},
    'executor': {'maxWorkers': 3, 'directory': '', 'prepare': '', 'blockedCommands': <String>[]},
    'policy': {
      'rules': [
        {'id': 'copy', 'name': 'Copy fixes', 'enabled': true, 'instruction': 'Fix typos when asked.'},
      ],
      'sources': {
        'chat': {
          'allowed': [
            {'id': 'web:local'},
          ],
        },
      },
    },
  };
  Map<String, dynamic> wechat = {'state': 'disconnected', 'message': '尚未连接微信。'};
  String? kernelProblem;

  // Multi-device control plane fixture state.
  bool devicesSupported = true;
  Map<String, dynamic> deviceConfig = {
    'enabled': false,
    'configured': false,
    'clusterId': '',
    'masterNodeId': 'master-local',
    'relayUrl': null,
    'hasRelaySecret': false,
    'hasClusterSecret': false,
    'hasToken': false,
    'hasE2eKey': false,
    'canMintTokens': false,
    'relayState': 'idle',
    'localRelayDetected': false,
    'defaultRelayUrl': 'https://neo.1inch.cn:18443',
    'agentVersion': '0.11.0',
    'masterVersion': '0.11.0',
  };
  final List<Map<String, dynamic>> devices = [];
  final List<Map<String, dynamic>> deviceApprovals = [];
  final List<Map<String, dynamic>> deviceEnrollments = [];
  final List<Map<String, dynamic>> deviceConfigInits = [];
  final List<Map<String, dynamic>> deviceConfigUpdates = [];
  final List<Map<String, dynamic>> createdEnrollments = [];
  final List<String> revokedEnrollments = [];
  final List<String> removedDevices = [];
  final List<String> pingedDevices = [];
  final List<Map<String, dynamic>> updatedDevices = [];
  final Map<String, Map<String, dynamic>> deviceUpdateResponses = {};
  final List<Map<String, dynamic>> sandboxUpdates = [];
  String? sandboxError;
  String? sandboxWarning;
  bool sandboxPendingMode = false;
  final List<(String, String?)> renamedDevices = [];
  final List<Map<String, dynamic>> mcuInstalls = [];
  final List<String> approvedApprovals = [];
  final List<String> rejectedApprovals = [];
  bool mcuAutoDeploySuccess = true;
  int _enrollmentSeq = 0;

  // Device MCP discovery & proxy fixture state.
  final Map<String, Map<String, dynamic>> deviceMcpOverviews = {};
  final Map<String, Map<String, List<Map<String, dynamic>>>> deviceMcpTools = {};
  final List<Map<String, dynamic>> mcpDiscovers = [];
  final List<Map<String, dynamic>> mcpInspects = [];
  final List<Map<String, dynamic>> mcpPolicyUpdates = [];
  final List<Map<String, dynamic>> mcpStops = [];
  final List<Map<String, dynamic>> mcpRestarts = [];
  String? mcpError;
  String? mcpInspectError;
  String? mcpPolicyError;
  String? mcpRuntimeError;
  List<Map<String, dynamic>> Function(String deviceId, bool includeLoopbackProbe)? onMcpDiscover;

  void configureDevices({
    String clusterId = 'personal',
    String masterNodeId = 'master-1',
    String relayUrl = 'https://neo.1inch.cn:18443',
    String relayState = 'connected',
    bool localRelayDetected = false,
    String? masterVersion,
    String? agentVersion,
  }) {
    deviceConfig = {
      ...deviceConfig,
      'enabled': true,
      'configured': true,
      'clusterId': clusterId,
      'masterNodeId': masterNodeId,
      'relayUrl': relayUrl,
      'hasRelaySecret': true,
      'hasClusterSecret': true,
      'hasToken': true,
      'hasE2eKey': true,
      'canMintTokens': true,
      'relayState': relayState,
      'localRelayDetected': localRelayDetected,
      'masterVersion': ?masterVersion,
      'agentVersion': ?agentVersion,
    };
  }

  void addDevice(
    String deviceId, {
    String? customName,
    String tier = 'os',
    String status = 'online',
    String route = 'relay',
    String? agentVersion,
    String? publicIp,
    String? location,
    String? relayNodeId,
    String? version,
    bool omitVersion = false,
    Map<String, dynamic>? manifest,
    List<String> capabilities = const ['exec', 'fs'],
    List<Map<String, dynamic>> pendingQueue = const [],
    String? sandboxLevel,
    String? desiredSandboxLevel,
    String? sandboxSyncState,
    String? sandboxSyncError,
    bool sandboxLocked = false,
    Map<String, dynamic>? mcpSummary,
  }) {
    final (memMb, timeoutSec) = switch (sandboxLevel) {
      'readonly' => (1024, 60),
      'corp' => (4096, 90),
      'desktop' => (4096, 180),
      'unrestricted' => (0, 0),
      _ => (2048, 120),
    };
    devices.removeWhere((d) => d['deviceId'] == deviceId);
    final effectiveVer = omitVersion
        ? null
        : (version ?? agentVersion ?? (tier == 'mcu' ? '0.1.0' : (deviceConfig['masterVersion'] as String? ?? '0.9.1')));
    devices.add({
      'deviceId': deviceId,
      'clusterId': (deviceConfig['clusterId'] as String?)?.isNotEmpty == true ? deviceConfig['clusterId'] : 'personal',
      if (customName != null && customName.trim().isNotEmpty) 'customName': customName.trim(),
      'tier': tier,
      'status': status,
      'route': route,
      'agentVersion': ?effectiveVer,
      'publicIp': ?publicIp,
      'location': ?location,
      'relayNodeId': ?relayNodeId,
      'sandboxLevel': ?sandboxLevel,
      'desiredSandboxLevel': ?desiredSandboxLevel,
      'sandboxSyncState': ?sandboxSyncState,
      'sandboxSyncError': ?sandboxSyncError,
      'manifest': manifest ??
          (tier == 'mcu'
              ? {'device_id': deviceId, 'tier': 'mcu', 'chip': 'ESP32', 'fw': ?effectiveVer, 'acts': ['get_temp']}
              : {
                  'device_id': deviceId,
                  'tier': 'os',
                  'version': ?effectiveVer,
                  'agent_version': ?effectiveVer,
                  'os': 'linux',
                  'arch': 'amd64',
                  'hostname': deviceId,
                  'public_ip': ?publicIp,
                  'location': ?location,
                  'cpus': 8,
                  'ram_mb': 16384,
                  'capabilities': capabilities,
                  'sandbox': {
                    'level': ?sandboxLevel,
                    if (sandboxLevel == 'unrestricted') 'unrestricted': true,
                    if (sandboxLevel == 'readonly') 'read_only': true,
                    if (sandboxLocked) 'locked': true,
                    'allowed_workspaces': ['/home/neo-personal/work'],
                    'max_child_mem_mb': memMb,
                    'max_exec_timeout_sec': timeoutSec,
                  },
                  'mcp_summary': ?mcpSummary,
                }),
      'capabilities': capabilities,
      'desiredState': <String, dynamic>{},
      'reportedState': <String, dynamic>{},
      'pendingQueue': pendingQueue,
      'lastSeqId': 1,
      'lastAckedSeqId': 1,
      'lastSeenAt': '2026-05-01T09:42:00.000Z',
      'updatedAt': '2026-05-01T09:42:00.000Z',
    });
  }

  Map<String, dynamic> _buildMcpSummaryMap(
    List<Map<String, dynamic>> servers, {
    required bool supported,
    required String discoveryMode,
    String? catalogHash,
  }) {
    final enabledCount = servers.where((s) => (s['trustState'] ?? s['trust_state']) == 'enabled').length;
    final runningCount = servers.where((s) {
      final rt = s['runtimeState'] ?? s['runtime_state'];
      return rt == 'running' || rt == 'idle';
    }).length;
    return {
      'enabled': supported,
      'discovery_mode': discoveryMode,
      'discovered_count': servers.length,
      'enabled_count': enabledCount,
      'running_count': runningCount,
      'catalog_hash': catalogHash ?? 'sha256:catalog-${servers.length}-$enabledCount',
      'servers': [
        for (final s in servers)
          {
            'server_id': s['serverId'] ?? s['server_id'] ?? '',
            'name': s['name'] ?? '',
            'source': s['source'] ?? '',
            'transport': s['transport'] ?? 'stdio',
            'trust_state': s['trustState'] ?? s['trust_state'] ?? 'discovered',
            'call_mode': s['callMode'] ?? s['call_mode'] ?? 'disabled',
            'runtime_state': s['runtimeState'] ?? s['runtime_state'] ?? 'stopped',
            if ((s['toolCount'] ?? s['tool_count']) != null) 'tool_count': s['toolCount'] ?? s['tool_count'],
          },
      ],
    };
  }

  void _syncDeviceMcpSummary(String deviceId) {
    final overview = deviceMcpOverviews[deviceId];
    if (overview == null) return;
    final supported = overview['supported'] == true;
    final discoveryMode = overview['discoveryMode'] as String? ?? 'standard';
    final servers = [for (final s in (overview['servers'] as List)) (s as Map).cast<String, dynamic>()];
    final summary = _buildMcpSummaryMap(
      servers,
      supported: supported,
      discoveryMode: discoveryMode,
      catalogHash: overview['catalogHash'] as String?,
    );
    overview['summary'] = summary;
    final idx = devices.indexWhere((d) => d['deviceId'] == deviceId);
    if (idx == -1) return;
    final device = devices[idx];
    final manifest = device['manifest'] is Map ? (device['manifest'] as Map).cast<String, dynamic>() : null;
    if (manifest != null) {
      if (supported) {
        manifest['mcp_summary'] = summary;
        final caps = (device['capabilities'] as List?)?.cast<String>().toList() ?? <String>[];
        if (!caps.contains('mcp_discovery')) caps.add('mcp_discovery');
        if (!caps.contains('mcp_proxy')) caps.add('mcp_proxy');
        device['capabilities'] = caps;
        manifest['capabilities'] = List<String>.from(caps);
      } else {
        manifest.remove('mcp_summary');
      }
    }
  }

  void setDeviceMcp(
    String deviceId, {
    bool supported = true,
    String discoveryMode = 'standard',
    String? catalogHash,
    List<Map<String, dynamic>> servers = const [],
    List<String> warnings = const [],
    Map<String, List<Map<String, dynamic>>> toolsByServer = const {},
    bool syncManifestSummary = true,
  }) {
    final copiedServers = [for (final s in servers) Map<String, dynamic>.from(s)];
    deviceMcpOverviews[deviceId] = {
      'deviceId': deviceId,
      'supported': supported,
      'discoveryMode': discoveryMode,
      'catalogHash': catalogHash ?? 'sha256:catalog-$deviceId',
      'updatedAt': '2026-05-01T09:50:00.000Z',
      'servers': copiedServers,
      'warnings': List<String>.from(warnings),
    };
    deviceMcpTools[deviceId] = {
      for (final entry in toolsByServer.entries) entry.key: [for (final t in entry.value) Map<String, dynamic>.from(t)],
    };
    if (syncManifestSummary) {
      _syncDeviceMcpSummary(deviceId);
    } else {
      deviceMcpOverviews[deviceId]!['summary'] = _buildMcpSummaryMap(
        copiedServers,
        supported: supported,
        discoveryMode: discoveryMode,
        catalogHash: catalogHash,
      );
    }
  }

  void addDeviceApproval(
    String id, {
    required String shortCode,
    required String deviceId,
    required String action,
    Map<String, dynamic> params = const {},
    String? reason,
  }) {
    deviceApprovals.add({
      'id': id,
      'shortCode': shortCode,
      'clusterId': (deviceConfig['clusterId'] as String?)?.isNotEmpty == true ? deviceConfig['clusterId'] : 'personal',
      'deviceId': deviceId,
      'action': action,
      'params': params,
      'reason': ?reason,
      'status': 'pending',
      'createdAt': '2026-05-01T09:45:00.000Z',
    });
  }

  void claimEnrollment(String id, {String ip = '192.168.1.88'}) {
    final enrollment = deviceEnrollments.firstWhere((e) => e['id'] == id);
    enrollment['status'] = 'claimed';
    enrollment['lastClaimedIp'] = ip;
    enrollment['lastClaimedAt'] = DateTime.now().toIso8601String();
  }

  void completeEnrollment(String id, {required String deviceId, String os = 'linux', String arch = 'amd64', String route = 'p2p'}) {
    final enrollment = deviceEnrollments.firstWhere((e) => e['id'] == id);
    enrollment['status'] = 'completed';
    enrollment['usedCount'] = ((enrollment['usedCount'] as int?) ?? 0) + 1;
    final ids = (enrollment['enrolledDeviceIds'] as List).cast<String>();
    if (!ids.contains(deviceId)) ids.add(deviceId);
    addDevice(
      deviceId,
      customName: enrollment['requestedCustomName'] as String?,
      status: 'online',
      route: route,
      manifest: {
        'device_id': deviceId,
        'tier': 'os',
        'os': os,
        'arch': arch,
        'hostname': deviceId,
        'cpus': 16,
        'ram_mb': 32768,
        'capabilities': ['exec', 'fs', 'gpu'],
        'sandbox': {
          'allowed_workspaces': ['/workspace'],
        },
      },
      capabilities: ['exec', 'fs', 'gpu'],
    );
  }

  http.Client get client => MockClient(_handle);

  ApiClient api([String? withToken]) => ApiClient(Uri.parse('http://backend.test'), token: withToken ?? token, client: client);

  /// A message as the API lists it.
  void say(String role, String text, {String? source, List<Map<String, dynamic>>? images, List<Map<String, dynamic>>? files}) {
    messages.add({
      'id': messages.length,
      'role': role,
      'text': text,
      'at': DateTime(2026, 5, 1, 9, 30 + messages.length).millisecondsSinceEpoch,
      'source': source ?? (role == 'user' ? 'web-panel' : 'chat-reply'),
      'images': ?images,
      'files': ?files,
    });
  }

  /// A worker card, and its detail with [recent] activity.
  void addWorker(String id, String title, Map<String, dynamic> stage, {String? outcome, bool streaming = false, Map<String, dynamic>? report, String? question, List<Map<String, dynamic>> background = const [], List<Map<String, dynamic>> recent = const []}) {
    final card = {
      'ticketId': id,
      'title': title,
      'stage': stage,
      'outcome': outcome,
      'updatedAt': '2026-05-01T09:40:00.000Z',
      'directory': '/data/work/$id',
      'session': {'loaded': streaming, 'streaming': streaming},
      'background': background,
      'assignment': {'id': 'a-$id', 'state': outcome == null ? 'running' : 'ended'},
      'progress': report,
      'attention': question == null ? null : {'id': 'q', 'question': question},
      'pendingInputs': 0,
      'delivery': null,
    };
    workers.add(card);
    details[id] = {...card, 'inputs': <dynamic>[], 'recent': recent};
  }

  List<Map<String, dynamic>> _available() => antigravityListing
      ? <Map<String, dynamic>>[]
      : [
          {'id': 'gemini-3.8-flash-low', 'provider': 'antigravity', 'name': 'Gemini 3.8 Flash (Low)'},
          {'id': 'gemini-3.8-pro-high', 'provider': 'antigravity', 'name': 'Gemini 3.8 Pro (High)'},
        ];

  Map<String, dynamic> _modelsView() => {
    'kernel': 'antigravity',
    'installed': antigravityProblem == null,
    'installing': _installingNow,
    'installProgress': _installingNow ? installProgress : null,
    'problem': antigravityProblem,
    'listProblem': antigravityProblem,
    'loading': antigravityListing,
    'current': {'eval': models['eval'], 'executor': models['executor']},
    'available': _available(),
  };

  /// The login in progress, and what was pasted into it.
  Map<String, dynamic>? login;
  final List<String> pasted = [];
  Map<String, dynamic>? account;

  Map<String, dynamic> _accountsView() => {
    'installed': antigravityProblem == null,
    'problem': null,
    'account': account,
    'note': account == null ? 'No login file found. A login kept in the system keyring does not show here.' : null,
    'login': login,
  };

  Map<String, dynamic> _generalView() => {
    ...general,
    'defaults': {'directory': '/data/work'},
    'limits': {
      'maxWorkers': [1, 16],
      'evalTimeoutSeconds': [30, 600],
    },
  };

  http.Response _json(int status, Object body) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

  Future<http.Response> _handle(http.Request request) async {
    if (down) throw http.ClientException('Connection refused', request.url);
    final path = request.url.path;
    calls.add('${request.method} $path');
    if (token != null && request.headers['authorization'] != 'Bearer $token') {
      return _json(401, {'error': 'A valid access token is required', if (path == '/api/health') 'authRequired': true});
    }
    final body = request.body.isEmpty ? null : jsonDecode(request.body);
    switch ((request.method, path)) {
      case ('GET', '/api/health'):
        return _json(200, {
          'ready': true,
          'version': '0.2.0',
          'kernel': 'antigravity',
          'paused': general['paused'],
          'activeWorkers': 0,
          'components': {
            'runtime': {'state': 'ready', 'detail': 'Ready'},
            'kernel': kernelProblem == null ? {'state': 'ready', 'detail': 'Running on antigravity'} : {'state': 'error', 'detail': kernelProblem},
          },
        });
      case ('GET', '/api/messages'):
        return _json(200, {'messages': messages});
      case ('GET', '/api/workers'):
        return _json(200, {'workers': workers});
      case ('GET', '/api/activity'):
        final now = activity;
        return now == null ? _json(404, {'error': 'Not found'}) : _json(200, now);
      case ('POST', '/api/chat'):
        chats.add((body as Map).cast<String, dynamic>());
        if (chatError != null) {
          final error = chatError!;
          chatError = null;
          return _json(400, {'error': error});
        }
        if (!messages.any((message) => message['messageId'] == body['messageId'])) {
          say('user', body['text'] as String);
          messages.last['messageId'] = body['messageId'];
          say('assistant', 'On it.');
        }
        return _json(202, {'requestId': 'chat:${body['messageId']}', 'triggerId': 't', 'result': 'stored'});
      case ('POST', '/api/session/reset'):
        resets++;
        messages.clear();
        return _json(200, {'reset': true});
      case ('GET', '/api/settings/models'):
        modelReads++;
        return _json(200, _modelsView());
      case ('PUT', '/api/settings/models'):
        final chosen = (body as Map).cast<String, dynamic>();
        if ((chosen['eval'] as Map?)?['model'] == 'broken') return _json(400, {'error': 'Unknown Antigravity model: broken'});
        models['eval'] = chosen['eval'];
        models['executor'] = chosen['executor'];
        return _json(200, _modelsView());
      case ('POST', '/api/settings/kernel/install'):
        final which = (body as Map)['kernel'] as String? ?? 'antigravity';
        if (installGate case final gate?) {
          _installingNow = true;
          await gate.future;
          _installingNow = false;
        }
        installed.add(which);
        antigravityProblem = null;
        return _json(200, _modelsView());
      case ('GET', '/api/settings/general'):
        return _json(200, _generalView());
      case ('PUT', '/api/settings/general'):
        final blocks = (body as Map).cast<String, dynamic>();
        if (((blocks['executor'] as Map?)?['blockedCommands'] as List?)?.contains('rm -rf') ?? false) return _json(400, {'error': '"rm -rf" is not a command name'});
        general = {...general, ...blocks};
        return _json(200, _generalView());
      case ('GET', '/api/settings/accounts'):
        return _json(200, _accountsView());
      case ('POST', '/api/settings/accounts/login'):
        login = {'id': 1, 'state': 'running', 'links': ['https://auth.example/authorize?x=1'], 'output': 'Open this URL in your browser:\nhttps://auth.example/authorize?x=1\nPaste the authorization code:'};
        return _json(200, {'login': login});
      case ('GET', '/api/settings/accounts/login'):
        return _json(200, {'login': login});
      case ('POST', '/api/settings/accounts/login/input'):
        pasted.add((body as Map)['text'] as String);
        account = {'email': 'me@example.com', 'removable': true};
        login = {...login!, 'state': 'done', 'output': 'Logged in to Google as me@example.com'};
        return _json(200, {'login': login});
      case ('POST', '/api/settings/accounts/logout'):
        account = null;
        return _json(200, _accountsView());
      case ('GET', '/api/wechat'):
        return _json(200, wechat);
      case ('POST', '/api/wechat/connect'):
        wechat = {'state': 'waiting', 'message': '使用微信扫码并确认授权。', 'qrContent': 'weixin://fixture-bind'};
        return _json(200, wechat);
      case ('POST', '/api/wechat/verify'):
        if ((body as Map)['code'] != '1234') return _json(400, {'error': '验证码必须为数字'});
        wechat = {'state': 'connected', 'message': '微信连接成功。', 'senderId': 'wechat:bound-user'};
        return _json(200, wechat);
      case ('POST', '/api/wechat/disconnect'):
        wechat = {'state': 'disconnected', 'message': '微信已断开，orchestrator 对话记录保留。'};
        return _json(200, wechat);
    }
    if (request.method == 'POST' && path.startsWith('/api/workers/') && path.endsWith('/stop') && path.length > '/api/workers//stop'.length) {
      final id = Uri.decodeComponent(path.substring('/api/workers/'.length, path.length - '/stop'.length));
      final detail = details[id];
      if (detail == null) return _json(404, {'error': 'Worker not found'});
      if (stopError != null) {
        final error = stopError!;
        stopError = null;
        return _json(400, {'error': error});
      }
      if ((detail['stage'] as Map)['stage'] == 'ended') {
        return _json(400, {'error': 'Task has already ended'});
      }
      final updatedAssignment = {...(detail['assignment'] as Map).cast<String, dynamic>(), 'state': 'ended'};
      final updates = <String, dynamic>{
        'stage': {'stage': 'ended'},
        'outcome': 'stopped',
        'session': {'loaded': false, 'streaming': false},
        'background': <Map<String, dynamic>>[],
        'assignment': updatedAssignment,
        'attention': null,
        'delivery': null,
        'pendingInputs': 0,
      };
      detail.addAll(updates);
      final index = workers.indexWhere((worker) => worker['ticketId'] == id);
      if (index != -1) {
        workers[index].addAll(updates);
      }
      stopped.add(id);
      return _json(200, detail);
    }
    if (request.method == 'GET' && path.startsWith('/api/workers/')) {
      final detail = details[Uri.decodeComponent(path.substring('/api/workers/'.length))];
      return detail == null ? _json(404, {'error': 'Worker not found'}) : _json(200, detail);
    }
    if (path == '/api/devices' || path.startsWith('/api/devices/')) {
      return _handleDevices(request.method, path, request.url.pathSegments, body);
    }
    return _json(404, {'error': 'Not found'});
  }

  http.Response _handleDevices(String method, String path, List<String> segments, Object? body) {
    if (!devicesSupported) return _json(404, {'error': 'Not found'});
    if (method == 'GET' && path == '/api/devices') {
      return _json(200, {
        'config': deviceConfig,
        'devices': devices,
        'approvals': deviceApprovals,
        'enrollments': deviceEnrollments,
      });
    }
    if (method == 'GET' && path == '/api/devices/config') {
      return _json(200, {'config': deviceConfig});
    }
    if ((method == 'POST' && path == '/api/devices/config/init') || (method == 'PUT' && path == '/api/devices/config')) {
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      if (method == 'POST') {
        deviceConfigInits.add(req);
      } else {
        deviceConfigUpdates.add(req);
      }
      final clusterId = (req['clusterId'] as String?)?.trim();
      final relayUrl = (req['relayUrl'] as String?)?.trim();
      final masterNodeId = (req['masterNodeId'] as String?)?.trim();
      final enabled = req['enabled'] is bool ? req['enabled'] as bool : true;
      final hasSecret = (req['clusterSecret'] as String?)?.isNotEmpty == true ||
          (req['relaySecret'] as String?)?.isNotEmpty == true ||
          req['autoDetectLocalRelay'] == true ||
          deviceConfig['hasClusterSecret'] == true;
      deviceConfig = {
        ...deviceConfig,
        'enabled': enabled,
        'configured': true,
        'clusterId': (clusterId != null && clusterId.isNotEmpty)
            ? clusterId
            : ((deviceConfig['clusterId'] as String?)?.isNotEmpty == true ? deviceConfig['clusterId'] : 'personal'),
        'masterNodeId': (masterNodeId != null && masterNodeId.isNotEmpty) ? masterNodeId : deviceConfig['masterNodeId'],
        'relayUrl': (relayUrl != null && relayUrl.isNotEmpty) ? relayUrl : (deviceConfig['relayUrl'] ?? deviceConfig['defaultRelayUrl']),
        'hasRelaySecret': hasSecret,
        'hasClusterSecret': hasSecret,
        'hasToken': true,
        'hasE2eKey': true,
        'canMintTokens': hasSecret,
        'relayState': enabled ? 'connected' : 'idle',
      };
      return _json(200, {'config': deviceConfig});
    }
    if (method == 'GET' && path == '/api/devices/enrollments') {
      return _json(200, {'enrollments': deviceEnrollments});
    }
    if (method == 'POST' && path == '/api/devices/enrollments') {
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      createdEnrollments.add(req);
      _enrollmentSeq++;
      final id = 'enr-$_enrollmentSeq';
      final platform = req['platform'] as String? ?? 'linux';
      final profile = req['profile'] as String? ?? 'personal';
      final installMode = req['installMode'] as String? ?? 'auto';
      final transportMode = req['transportMode'] as String? ?? 'relay';
      final ttlSec = (req['ttlSec'] as num?)?.toInt() ?? 600;
      final maxUses = (req['maxUses'] as num?)?.toInt() ?? 1;
      final clusterId = (deviceConfig['clusterId'] as String?)?.isNotEmpty == true ? deviceConfig['clusterId'] as String : 'personal';
      final enrollCode = 'neo-enr-$id-secret';
      final now = DateTime.now();
      final enrollment = <String, dynamic>{
        'id': id,
        'clusterId': clusterId,
        'platform': platform,
        'profile': profile,
        'installMode': installMode,
        'transportMode': transportMode,
        'requestedDeviceId': req['deviceId'],
        if (req['customName'] is String && (req['customName'] as String).trim().isNotEmpty)
          'requestedCustomName': (req['customName'] as String).trim(),
        'status': 'pending',
        'createdAt': now.toIso8601String(),
        'expiresAt': now.add(Duration(seconds: ttlSec)).toIso8601String(),
        'maxUses': maxUses,
        'usedCount': 0,
        'lastClaimedIp': null,
        'lastClaimedAt': null,
        'enrolledDeviceIds': <String>[],
        'enrollCode': enrollCode,
        'commands': {
          'linuxRoot': 'curl -fsSL https://neo.1inch.cn:18443/install.sh | sudo sh -s -- --enroll $enrollCode --profile $profile',
          'linuxUser': 'curl -fsSL https://neo.1inch.cn:18443/install.sh | sh -s -- --enroll $enrollCode --profile $profile --user',
          'macos': 'curl -fsSL https://neo.1inch.cn:18443/install.sh | sh -s -- --enroll $enrollCode --profile $profile --macos',
          'windows': 'irm https://neo.1inch.cn:18443/install.ps1 | iex; neo-agent-install -Enroll $enrollCode -Profile $profile',
          'docker': 'docker run -d --name neo-agent-$clusterId -e NEO_ENROLL=$enrollCode ghcr.io/neo/neo-agent-os:latest',
          'uninstall': 'sudo neo-agent-os uninstall --cluster $clusterId',
        },
      };
      deviceEnrollments.add(enrollment);
      return _json(200, {'enrollment': enrollment});
    }
    if (path.startsWith('/api/devices/enrollments/')) {
      final id = Uri.decodeComponent(path.substring('/api/devices/enrollments/'.length));
      final index = deviceEnrollments.indexWhere((e) => e['id'] == id);
      if (index == -1) return _json(404, {'error': 'Enrollment not found'});
      final enrollment = deviceEnrollments[index];
      if (method == 'GET') {
        final enrolledIds = (enrollment['enrolledDeviceIds'] as List).cast<String>().toSet();
        final matched = [for (final d in devices) if (enrolledIds.contains(d['deviceId'])) d];
        return _json(200, {'enrollment': enrollment, 'devices': matched});
      }
      if (method == 'DELETE') {
        enrollment['status'] = 'revoked';
        revokedEnrollments.add(id);
        return _json(200, {'enrollment': enrollment});
      }
    }
    if (method == 'POST' && path == '/api/devices/mcu/install') {
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      mcuInstalls.add(req);
      final mcuId = req['mcuId'] as String? ?? 'esp32-1';
      final customName = req['customName'] as String?;
      final relayDeviceId = req['relayDeviceId'] as String? ?? 'edge-1';
      final chip = req['chip'] as String? ?? 'ESP32';
      final transport = req['transport'] as String? ?? 'mqtt';
      addDevice(
        mcuId,
        customName: customName,
        tier: 'mcu',
        status: mcuAutoDeploySuccess ? 'online' : 'offline',
        route: 'via_tier1',
        relayNodeId: relayDeviceId,
        manifest: {'device_id': mcuId, 'tier': 'mcu', 'chip': chip, 'fw': '0.9.0', 'acts': ['get_temp', 'set_gpio']},
        capabilities: ['gpio', 'sensor'],
      );
      final twin = devices.firstWhere((d) => d['deviceId'] == mcuId);
      final workspaceDir = '/home/neo-personal/work/mcu/$mcuId';
      return _json(200, {
        'twin': twin,
        'deployed': mcuAutoDeploySuccess,
        'deployMethod': mcuAutoDeploySuccess ? 'tier1_rpc' : 'staged_manual',
        'deployDetail': mcuAutoDeploySuccess
            ? 'Wrote neo_mcu_config.h and install.sh on $relayDeviceId ($transport).'
            : 'Tier 1 device $relayDeviceId is offline; staged config locally.',
        'workspaceDir': workspaceDir,
        'configHeader': '#pragma once\n#define NEO_MCU_ID "$mcuId"\n#define NEO_MCU_CHIP "$chip"\n#define NEO_MCU_TRANSPORT "$transport"\n',
        'installScript': '#!/bin/sh\necho "Flashing $mcuId via $transport"\n',
        'mcuE2eKeyHex': 'a1b2c3d4e5f60708192a3b4c5d6e7f80a1b2c3d4e5f60708192a3b4c5d6e7f80',
      });
    }
    if (method == 'POST' && path.startsWith('/api/devices/approvals/')) {
      final rest = path.substring('/api/devices/approvals/'.length);
      final isApprove = rest.endsWith('/approve');
      final isReject = rest.endsWith('/reject');
      if (isApprove || isReject) {
        final suffix = isApprove ? '/approve' : '/reject';
        final id = Uri.decodeComponent(rest.substring(0, rest.length - suffix.length));
        final index = deviceApprovals.indexWhere((a) => a['id'] == id);
        if (index == -1) return _json(404, {'error': 'Approval not found'});
        final approval = deviceApprovals[index];
        approval['status'] = isApprove ? 'approved' : 'rejected';
        approval['decidedAt'] = DateTime.now().toIso8601String();
        if (isApprove) {
          approvedApprovals.add(id);
        } else {
          rejectedApprovals.add(id);
        }
        return _json(200, {'approval': approval});
      }
    }
    if (method == 'PUT' && path.startsWith('/api/devices/') && path.endsWith('/sandbox') && path.length > '/api/devices//sandbox'.length) {
      final id = Uri.decodeComponent(path.substring('/api/devices/'.length, path.length - '/sandbox'.length));
      final index = devices.indexWhere((d) => d['deviceId'] == id);
      if (index == -1) return _json(404, {'error': 'Device not found'});
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      final level = (req['level'] as String?)?.trim() ?? '';
      sandboxUpdates.add({'deviceId': id, ...req});
      if (sandboxError != null) {
        final error = sandboxError!;
        sandboxError = null;
        return _json(400, {'error': error});
      }
      final device = devices[index];
      final manifest = (device['manifest'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
      final sandbox = (manifest['sandbox'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
      if (sandbox['locked'] == true || device['sandboxSyncState'] == 'locked') {
        return _json(403, {'error': 'Device sandbox policy is locked locally (lock_sandbox = true)'});
      }
      final warning = sandboxWarning;
      sandboxWarning = null;
      final isOnline = device['status'] == 'online';
      final pending = sandboxPendingMode || !isOnline;
      if (pending) {
        device['desiredSandboxLevel'] = level;
        device['sandboxSyncState'] = 'pending';
        device.remove('sandboxSyncError');
        return _json(200, {
          'device': device,
          'level': level,
          'applied': false,
          'pending': true,
          'persisted': null,
          'warning': ?warning,
        });
      }
      final (memMb, timeoutSec) = switch (level) {
        'readonly' => (1024, 60),
        'corp' => (4096, 90),
        'desktop' => (4096, 180),
        'unrestricted' => (0, 0),
        _ => (2048, 120),
      };
      manifest['sandbox'] = <String, dynamic>{
        ...sandbox,
        'level': level,
        'unrestricted': level == 'unrestricted',
        'read_only': level == 'readonly',
        'max_child_mem_mb': memMb,
        'max_exec_timeout_sec': timeoutSec,
        if (req['workspaces'] is List) 'allowed_workspaces': (req['workspaces'] as List).cast<String>(),
      };
      device['manifest'] = manifest;
      device['sandboxLevel'] = level;
      device['desiredSandboxLevel'] = level;
      device['sandboxSyncState'] = 'synced';
      device.remove('sandboxSyncError');
      return _json(200, {
        'device': device,
        'level': level,
        'applied': true,
        'pending': false,
        'persisted': true,
        'warning': ?warning,
      });
    }
    if (method == 'POST' && path.startsWith('/api/devices/') && path.endsWith('/ping')) {
      final id = Uri.decodeComponent(path.substring('/api/devices/'.length, path.length - '/ping'.length));
      final index = devices.indexWhere((d) => d['deviceId'] == id);
      if (index == -1) return _json(404, {'error': 'Device not found'});
      pingedDevices.add(id);
      final device = devices[index];
      return _json(200, {
        'ok': true,
        'deviceId': id,
        'latencyMs': 18,
        'status': device['status'],
        'route': device['route'],
      });
    }
    if (method == 'POST' && path.startsWith('/api/devices/') && path.endsWith('/update')) {
      final id = Uri.decodeComponent(path.substring('/api/devices/'.length, path.length - '/update'.length));
      final index = devices.indexWhere((d) => d['deviceId'] == id);
      if (index == -1) return _json(404, {'error': 'Device not found'});
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      final masterVer = (deviceConfig['masterVersion'] as String?) ?? (deviceConfig['agentVersion'] as String?) ?? '0.9.1';
      final requestedTarget = (req['targetVersion'] as String?)?.trim();
      if (requestedTarget != null && requestedTarget.isNotEmpty && requestedTarget != masterVer) {
        return _json(400, {'error': 'Target update version v$requestedTarget must match Master Neo version v$masterVer'});
      }
      updatedDevices.add({'deviceId': id, 'targetVersion': requestedTarget ?? masterVer, ...req});
      final override = deviceUpdateResponses[id];
      if (override != null) {
        return _json(200, override);
      }
      final device = devices[index];
      final manifest = device['manifest'] is Map ? (device['manifest'] as Map).cast<String, dynamic>() : <String, dynamic>{};
      final tier = device['tier'] as String? ?? 'os';
      final prev = tier == 'mcu' ? manifest['fw'] as String? : manifest['version'] as String?;
      return _json(200, {
        'ok': true,
        'status': tier == 'mcu' ? 'queued' : 'restarting',
        'deviceId': id,
        'tier': tier,
        'currentVersion': ?prev,
        'targetVersion': masterVer,
        'message': 'Triggered remote update to v$masterVer',
      });
    }
    if (segments.length >= 4 && segments[0] == 'api' && segments[1] == 'devices' && segments[3] == 'mcp') {
      final deviceId = segments[2];
      final deviceIndex = devices.indexWhere((d) => d['deviceId'] == deviceId);
      if (deviceIndex == -1) return _json(404, {'error': 'Device not found'});
      final device = devices[deviceIndex];
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};

      if (segments.length == 4 && method == 'GET') {
        if (mcpError != null) {
          final error = mcpError!;
          mcpError = null;
          return _json(500, {'error': error});
        }
        final existing = deviceMcpOverviews[deviceId];
        if (existing != null) return _json(200, existing);
        final caps = (device['capabilities'] as List?)?.cast<String>() ?? const <String>[];
        final supported = caps.contains('mcp_proxy') || caps.contains('mcp_discovery');
        return _json(200, {
          'deviceId': deviceId,
          'supported': supported,
          'discoveryMode': supported ? 'standard' : 'off',
          'servers': <Map<String, dynamic>>[],
          'warnings': <String>[],
        });
      }

      if (segments.length == 5 && segments[4] == 'discover' && method == 'POST') {
        final includeLoopback = req['includeLoopbackProbe'] == true;
        mcpDiscovers.add({'deviceId': deviceId, 'includeLoopbackProbe': includeLoopback});
        if (mcpError != null) {
          final error = mcpError!;
          mcpError = null;
          return _json(400, {'error': error});
        }
        var overview = deviceMcpOverviews[deviceId];
        if (overview == null) {
          setDeviceMcp(deviceId, supported: true, servers: const []);
          overview = deviceMcpOverviews[deviceId]!;
        }
        if (overview['supported'] != true) {
          return _json(200, overview);
        }
        if (onMcpDiscover != null) {
          overview['servers'] = [for (final s in onMcpDiscover!(deviceId, includeLoopback)) Map<String, dynamic>.from(s)];
        } else if (includeLoopback) {
          final list = (overview['servers'] as List).cast<Map<String, dynamic>>();
          if (!list.any((s) => (s['serverId'] ?? s['server_id']) == 'loopback:local-http')) {
            list.add({
              'serverId': 'loopback:local-http',
              'name': 'local-http',
              'source': 'loopback_probe',
              'transport': 'streamable_http',
              'urlSanitized': 'http://127.0.0.1:8765/mcp',
              'envKeys': <String>[],
              'authRequired': false,
              'trustState': 'discovered',
              'callMode': 'disabled',
              'runtimeState': 'running',
            });
          }
        }
        overview['updatedAt'] = DateTime.now().toIso8601String();
        _syncDeviceMcpSummary(deviceId);
        return _json(200, overview);
      }

      if (segments.length == 6) {
        final serverId = segments[4];
        final action = segments[5];
        final overview = deviceMcpOverviews[deviceId];
        if (overview == null) return _json(404, {'error': 'MCP catalog not found'});
        final servers = (overview['servers'] as List).cast<Map<String, dynamic>>();
        final serverIndex = servers.indexWhere((s) => (s['serverId'] ?? s['server_id']) == serverId);
        if (serverIndex == -1) return _json(404, {'error': 'MCP server not found: $serverId'});
        final server = servers[serverIndex];

        if (action == 'inspect' && method == 'POST') {
          mcpInspects.add({'deviceId': deviceId, 'serverId': serverId, ...req});
          if (mcpInspectError != null) {
            final error = mcpInspectError!;
            mcpInspectError = null;
            return _json(400, {'error': error});
          }
          if (mcpError != null) {
            final error = mcpError!;
            mcpError = null;
            return _json(400, {'error': error});
          }
          final allTools = deviceMcpTools[deviceId]?[serverId] ?? const <Map<String, dynamic>>[];
          final query = (req['query'] as String?)?.trim().toLowerCase();
          final filteredTools = (query == null || query.isEmpty)
              ? allTools
              : [
                  for (final t in allTools)
                    if (((t['name'] as String?) ?? '').toLowerCase().contains(query) ||
                        ((t['description'] as String?) ?? '').toLowerCase().contains(query))
                      t,
                ];
          server['toolCount'] = allTools.length;
          if ((server['runtimeState'] ?? server['runtime_state']) == 'stopped') {
            server['runtimeState'] = 'running';
          }
          _syncDeviceMcpSummary(deviceId);
          return _json(200, {
            'deviceId': deviceId,
            'server': server,
            'protocolVersion': '2025-03-26',
            'tools': filteredTools,
            'toolsSchemaHash': 'sha256:tools-$serverId',
          });
        }

        if (action == 'policy' && method == 'PUT') {
          mcpPolicyUpdates.add({'deviceId': deviceId, 'serverId': serverId, ...req});
          if (mcpPolicyError != null) {
            final error = mcpPolicyError!;
            mcpPolicyError = null;
            return _json(400, {'error': error});
          }
          final manifest = (device['manifest'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
          final sandbox = (manifest['sandbox'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
          if (sandbox['locked'] == true || device['sandboxSyncState'] == 'locked') {
            return _json(403, {'error': 'Device sandbox policy is locked locally (lock_sandbox = true)'});
          }
          if ((server['trustState'] ?? server['trust_state']) == 'blocked_by_policy') {
            return _json(403, {'error': 'MCP server is blocked by local policy'});
          }
          if (req['enabled'] is bool) {
            final enable = req['enabled'] as bool;
            server['trustState'] = enable ? 'enabled' : 'disabled';
            if (enable) {
              final currentMode = server['callMode'] ?? server['call_mode'];
              if (currentMode == null || currentMode == 'disabled') {
                server['callMode'] = 'auto_readonly';
              }
            } else {
              server['runtimeState'] = 'stopped';
            }
          }
          if (req['callMode'] is String && (req['callMode'] as String).isNotEmpty) {
            server['callMode'] = req['callMode'];
          }
          _syncDeviceMcpSummary(deviceId);
          return _json(200, {
            'deviceId': deviceId,
            'server': server,
            'persisted': true,
            'summary': overview['summary'],
          });
        }

        if (action == 'stop' && method == 'POST') {
          mcpStops.add({'deviceId': deviceId, 'serverId': serverId});
          if (mcpRuntimeError != null) {
            final error = mcpRuntimeError!;
            mcpRuntimeError = null;
            return _json(400, {'error': error});
          }
          server['runtimeState'] = 'stopped';
          _syncDeviceMcpSummary(deviceId);
          return _json(200, {'ok': true, 'server': server});
        }

        if (action == 'restart' && method == 'POST') {
          mcpRestarts.add({'deviceId': deviceId, 'serverId': serverId});
          if (mcpRuntimeError != null) {
            final error = mcpRuntimeError!;
            mcpRuntimeError = null;
            return _json(400, {'error': error});
          }
          server['runtimeState'] = 'running';
          server.remove('lastError');
          server.remove('last_error');
          _syncDeviceMcpSummary(deviceId);
          return _json(200, {'ok': true, 'server': server});
        }
      }
    }
    if ((method == 'PATCH' || method == 'PUT') && path.startsWith('/api/devices/') && path != '/api/devices/config') {
      final id = Uri.decodeComponent(path.substring('/api/devices/'.length));
      if (id.contains('/')) return _json(404, {'error': 'Device not found'});
      final index = devices.indexWhere((d) => d['deviceId'] == id);
      if (index == -1) return _json(404, {'error': 'Device not found'});
      final req = body is Map ? body.cast<String, dynamic>() : <String, dynamic>{};
      final rawName = req['customName'] ?? req['custom_name'] ?? req['name'];
      if (rawName != null && rawName is! String) {
        return _json(400, {'error': 'customName must be a string or null'});
      }
      final trimmed = rawName is String ? rawName.trim() : null;
      if (trimmed != null && trimmed.runes.length > 64) {
        return _json(400, {'error': 'Device custom name must be at most 64 characters'});
      }
      final device = devices[index];
      if (trimmed == null || trimmed.isEmpty) {
        device.remove('customName');
        renamedDevices.add((id, null));
      } else {
        device['customName'] = trimmed;
        renamedDevices.add((id, trimmed));
      }
      return _json(200, device);
    }
    if (method == 'DELETE' && path.startsWith('/api/devices/')) {
      final id = Uri.decodeComponent(path.substring('/api/devices/'.length));
      final before = devices.length;
      devices.removeWhere((d) => d['deviceId'] == id);
      if (devices.length == before) return _json(404, {'error': 'Device not found'});
      removedDevices.add(id);
      return _json(200, {'removed': true, 'deviceId': id});
    }
    return _json(404, {'error': 'Not found'});
  }
}

/// A local backend whose phases a test sets.
class FakeLocalBackend implements LocalBackend {
  final ValueNotifier<BackendStatus> notifier = ValueNotifier(const BackendStatus(BackendPhase.starting));
  int starts = 0;
  bool stopped = false;

  @override
  ValueListenable<BackendStatus> get status => notifier;

  @override
  void start() => starts++;

  @override
  Future<void> stop() async => stopped = true;
}

/// A host with nothing behind it but what a test gives.
class FakeHost implements Host {
  FakeHost({this.isDesktop = false, this.pageOrigin, Map<String, String>? prefs}) : prefs = prefs ?? {};

  @override
  final bool isDesktop;
  @override
  final Uri? pageOrigin;
  Map<String, String> prefs;
  final FakeLocalBackend backend = FakeLocalBackend();
  int focused = 0;

  @override
  Future<Map<String, String>> readPrefs() async => prefs;

  @override
  Future<void> writePrefs(Map<String, String> next) async => prefs = next;

  @override
  LocalBackend? createLocalBackend() => isDesktop ? backend : null;

  @override
  Future<bool> claimSingleInstance(VoidCallback onFocusRequested) async => true;

  @override
  Future<void> focusWindow() async => focused++;

  @override
  void quit() {}
}

/// The app's state over a fake backend reached as a remote server, as a page in a browser reaches its own.
AppState stateOver(FakeBackend backend, {FakeHost? host, Duration pollEvery = const Duration(seconds: 2)}) {
  return AppState(host ?? FakeHost(pageOrigin: Uri.parse('http://backend.test'), prefs: {'token': ?backend.token}), clients: (base, token) => ApiClient(base, token: token, client: backend.client), pollEvery: pollEvery);
}
