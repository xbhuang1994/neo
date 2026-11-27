/// The backend's API over HTTP.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// A call the backend refused, or that never reached it.
class ApiException implements Exception {
  ApiException(this.status, this.message);

  /// The HTTP status, or 0 when there was no answer.
  final int status;
  final String message;

  /// The backend wants an access token, or another one.
  bool get unauthorized => status == 401;

  /// The backend could not be reached at all.
  bool get unreachable => status == 0;

  @override
  String toString() => message;
}

/// Result of one conditional GET endpoint call.
class ConditionalResult<T> {
  const ConditionalResult.unchanged({required this.raw, this.etag}) : changed = false, value = null;
  const ConditionalResult.changed({required this.value, required this.raw, this.etag}) : changed = true;

  final bool changed;
  final T? value;
  final String raw;
  final String? etag;
}

/// Result of one combined `GET /api/poll` call.
class PollResult {
  const PollResult({
    this.unchanged = false,
    this.etags = const {},
    this.messages,
    this.workers,
    this.activity,
    this.devices,
    this.hasWorkerDetail = false,
    this.workerDetail,
    this.health,
  });

  const PollResult.unchanged()
    : unchanged = true,
      etags = const {},
      messages = null,
      workers = null,
      activity = null,
      devices = null,
      hasWorkerDetail = false,
      workerDetail = null,
      health = null;

  final bool unchanged;
  final Map<String, String> etags;
  final List<ChatMessage>? messages;
  final List<Worker>? workers;
  final Activity? activity;
  final DevicesOverview? devices;
  final bool hasWorkerDetail;
  final Worker? workerDetail;
  final Health? health;
}

/// Calls one backend.
class ApiClient {
  ApiClient(this.base, {this.token, http.Client? client}) : _client = client ?? http.Client();

  /// The backend's address, such as `http://127.0.0.1:3082`.
  final Uri base;

  /// The access token, where the backend wants one.
  final String? token;
  final http.Client _client;

  void close() => _client.close();

  Future<http.Response> _sendRaw(
    String method,
    String path, {
    Object? body,
    Map<String, String>? extraHeaders,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final request = http.Request(method, base.resolve(path));
    if (token != null && token!.isNotEmpty) request.headers['authorization'] = 'Bearer $token';
    if (extraHeaders != null) request.headers.addAll(extraHeaders);
    if (body != null) {
      request.headers['content-type'] = 'application/json; charset=utf-8';
      request.bodyBytes = utf8.encode(jsonEncode(body));
    }
    try {
      return await http.Response.fromStream(await _client.send(request).timeout(timeout));
    } on TimeoutException {
      throw ApiException(0, 'timeout');
    } on http.ClientException catch (error) {
      throw ApiException(0, error.message);
    } on Exception catch (error) {
      throw ApiException(0, error.toString());
    }
  }

  Object? _decodeAndCheck(http.Response response) {
    Object? decoded;
    try {
      decoded = response.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      decoded = null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = decoded is Map && decoded['error'] is String ? decoded['error'] as String : 'HTTP ${response.statusCode}';
      throw ApiException(response.statusCode, message);
    }
    return decoded;
  }

  Future<Object?> _call(String method, String path, {Object? body, Duration timeout = const Duration(seconds: 15)}) async {
    final response = await _sendRaw(method, path, body: body, timeout: timeout);
    return _decodeAndCheck(response);
  }

  Future<Map<String, dynamic>> _object(String method, String path, {Object? body, Duration timeout = const Duration(seconds: 15)}) async {
    final decoded = await _call(method, path, body: body, timeout: timeout);
    if (decoded is! Map) throw ApiException(0, 'The server answered something that is not Neo');
    return decoded.cast<String, dynamic>();
  }

  /// Fetches a JSON object only when the server's ETag or raw body differs from the previous response.
  /// Avoids `jsonDecode`, model construction, and base64 decoding completely on unchanged polls.
  Future<ConditionalResult<Map<String, dynamic>>> _conditionalObject(
    String path, {
    String? ifNoneMatch,
    String? previousRaw,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final response = await _sendRaw(
      'GET',
      path,
      extraHeaders: ifNoneMatch != null && ifNoneMatch.isNotEmpty ? {'if-none-match': ifNoneMatch} : null,
      timeout: timeout,
    );
    final etag = response.headers['etag'] ?? ifNoneMatch;
    if (response.statusCode == 304) {
      return ConditionalResult.unchanged(raw: previousRaw ?? '', etag: etag);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _decodeAndCheck(response);
    }
    final rawText = response.bodyBytes.isEmpty ? '' : utf8.decode(response.bodyBytes);
    if (previousRaw != null && previousRaw.isNotEmpty && rawText == previousRaw) {
      return ConditionalResult.unchanged(raw: rawText, etag: etag);
    }
    Object? decoded;
    try {
      decoded = rawText.isEmpty ? null : jsonDecode(rawText);
    } on FormatException {
      decoded = null;
    }
    if (decoded is! Map) throw ApiException(0, 'The server answered something that is not Neo');
    return ConditionalResult.changed(value: decoded.cast<String, dynamic>(), raw: rawText, etag: etag);
  }

  /// Combined multi-slice conditional poll (`GET /api/poll`). Returns `null` when an older backend answers 404.
  Future<PollResult?> poll({
    required Set<String> include,
    required Map<String, String> etags,
    String? workerId,
    bool wantHealth = false,
    List<ChatMessage> previousMessages = const [],
  }) async {
    final query = <String, String>{
      'include': include.join(','),
      if (workerId != null && workerId.isNotEmpty) 'worker': workerId,
      if (wantHealth) 'health': '1',
      for (final key in include)
        if (etags[key] case final tag?)
          if (tag.isNotEmpty) key: tag,
    };
    final path = Uri(path: '/api/poll', queryParameters: query).toString();
    final response = await _sendRaw('GET', path, timeout: const Duration(seconds: 15));
    if (response.statusCode == 304) {
      return const PollResult.unchanged();
    }
    if (response.statusCode == 404) {
      return null;
    }
    final decoded = _decodeAndCheck(response);
    if (decoded is! Map) throw ApiException(0, 'The server answered something that is not Neo');
    final body = decoded.cast<String, dynamic>();
    final changed = body['changed'] is Map ? (body['changed'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final nextEtags = <String, String>{};
    if (body['etags'] is Map) {
      for (final entry in (body['etags'] as Map).entries) {
        if (entry.value is String) nextEtags[entry.key.toString()] = entry.value as String;
      }
    }
    List<ChatMessage>? messages;
    if (changed.containsKey('messages')) {
      final list = changed['messages'] is List ? changed['messages'] as List<dynamic> : const <dynamic>[];
      messages = ChatMessage.parseList(list, previous: previousMessages);
    }
    List<Worker>? workers;
    if (changed.containsKey('workers')) {
      final list = changed['workers'] is List ? changed['workers'] as List<dynamic> : const <dynamic>[];
      workers = List<Worker>.unmodifiable([for (final item in list) Worker.fromJson((item as Map).cast<String, dynamic>())]);
    }
    Activity? activity;
    if (changed.containsKey('activity') && changed['activity'] is Map) {
      activity = Activity.fromJson((changed['activity'] as Map).cast<String, dynamic>());
    }
    DevicesOverview? devices;
    if (changed.containsKey('devices') && changed['devices'] is Map) {
      devices = DevicesOverview.fromJson((changed['devices'] as Map).cast<String, dynamic>());
    }
    final hasWorkerDetail = changed.containsKey('workerDetail');
    final workerDetail = hasWorkerDetail && changed['workerDetail'] is Map
        ? Worker.fromJson((changed['workerDetail'] as Map).cast<String, dynamic>())
        : null;
    Health? health;
    if (changed.containsKey('health') && changed['health'] is Map) {
      health = Health.fromJson((changed['health'] as Map).cast<String, dynamic>());
    }
    return PollResult(
      etags: nextEtags,
      messages: messages,
      workers: workers,
      activity: activity,
      devices: devices,
      hasWorkerDetail: hasWorkerDetail,
      workerDetail: workerDetail,
      health: health,
    );
  }

  Future<Health> health() async => Health.fromJson(await _object('GET', '/api/health', timeout: const Duration(seconds: 5)));

  /// The conversation, and the JSON it came as, to tell whether it changed.
  Future<(List<ChatMessage>, String)> messages() async {
    final body = await _object('GET', '/api/messages');
    final list = body['messages'] is List ? body['messages'] as List<dynamic> : const <dynamic>[];
    return (ChatMessage.parseList(list), jsonEncode(list));
  }

  Future<ConditionalResult<List<ChatMessage>>> messagesIfChanged({
    String? ifNoneMatch,
    String? previousRaw,
    List<ChatMessage> previousMessages = const [],
  }) async {
    final res = await _conditionalObject('/api/messages', ifNoneMatch: ifNoneMatch, previousRaw: previousRaw);
    if (!res.changed) return ConditionalResult.unchanged(raw: res.raw, etag: res.etag);
    final list = res.value!['messages'] is List ? res.value!['messages'] as List<dynamic> : const <dynamic>[];
    return ConditionalResult.changed(
      value: ChatMessage.parseList(list, previous: previousMessages),
      raw: res.raw,
      etag: res.etag,
    );
  }

  Future<List<Worker>> workers() async {
    final body = await _object('GET', '/api/workers');
    final list = body['workers'] is List ? body['workers'] as List<dynamic> : const <dynamic>[];
    return [for (final worker in list) Worker.fromJson((worker as Map).cast<String, dynamic>())];
  }

  Future<ConditionalResult<List<Worker>>> workersIfChanged({String? ifNoneMatch, String? previousRaw}) async {
    final res = await _conditionalObject('/api/workers', ifNoneMatch: ifNoneMatch, previousRaw: previousRaw);
    if (!res.changed) return ConditionalResult.unchanged(raw: res.raw, etag: res.etag);
    final list = res.value!['workers'] is List ? res.value!['workers'] as List<dynamic> : const <dynamic>[];
    return ConditionalResult.changed(
      value: List<Worker>.unmodifiable([for (final worker in list) Worker.fromJson((worker as Map).cast<String, dynamic>())]),
      raw: res.raw,
      etag: res.etag,
    );
  }

  /// What is at work now; idle from a backend too old to say.
  Future<Activity> activity() async {
    try {
      return Activity.fromJson(await _object('GET', '/api/activity', timeout: const Duration(seconds: 5)));
    } on ApiException catch (error) {
      if (error.status == 404) return const Activity.idle();
      rethrow;
    }
  }

  Future<ConditionalResult<Activity>> activityIfChanged({String? ifNoneMatch, String? previousRaw}) async {
    try {
      final res = await _conditionalObject('/api/activity', ifNoneMatch: ifNoneMatch, previousRaw: previousRaw, timeout: const Duration(seconds: 5));
      if (!res.changed) return ConditionalResult.unchanged(raw: res.raw, etag: res.etag);
      return ConditionalResult.changed(value: Activity.fromJson(res.value!, raw: res.raw), raw: res.raw, etag: res.etag);
    } on ApiException catch (error) {
      if (error.status == 404) {
        if (previousRaw == '__404__') return const ConditionalResult.unchanged(raw: '__404__');
        return const ConditionalResult.changed(value: Activity.idle(), raw: '__404__');
      }
      rethrow;
    }
  }

  Future<Worker> worker(String ticketId) async => Worker.fromJson(await _object('GET', '/api/workers/${Uri.encodeComponent(ticketId)}'));

  Future<ConditionalResult<Worker?>> workerIfChanged(String ticketId, {String? ifNoneMatch, String? previousRaw}) async {
    try {
      final res = await _conditionalObject('/api/workers/${Uri.encodeComponent(ticketId)}', ifNoneMatch: ifNoneMatch, previousRaw: previousRaw);
      if (!res.changed) return ConditionalResult.unchanged(raw: res.raw, etag: res.etag);
      return ConditionalResult.changed(value: Worker.fromJson(res.value!, raw: res.raw), raw: res.raw, etag: res.etag);
    } on ApiException catch (error) {
      if (error.status == 404) {
        if (previousRaw == '__404__') return const ConditionalResult.unchanged(raw: '__404__');
        return const ConditionalResult.changed(value: null, raw: '__404__');
      }
      rethrow;
    }
  }

  /// Stop a worker and all of its subtasks, marking the task ended.
  Future<Worker> stopWorker(String ticketId) async =>
      Worker.fromJson(await _object('POST', '/api/workers/${Uri.encodeComponent(ticketId)}/stop', timeout: const Duration(seconds: 60)));

  /// Send a chat message; the same [messageId] is the same message however often it is sent.
  Future<void> chat(String text, List<OutgoingFile> files, String messageId) async {
    await _object(
      'POST',
      '/api/chat',
      body: {'text': text, 'messageId': messageId, if (files.isNotEmpty) 'attachments': [for (final file in files) file.toJson()]},
      timeout: const Duration(seconds: 60),
    );
  }

  Future<void> resetSession() async {
    await _object('POST', '/api/session/reset', timeout: const Duration(seconds: 60));
  }

  Future<ModelSettings> models() async => ModelSettings.fromJson(await _object('GET', '/api/settings/models', timeout: const Duration(seconds: 30)));

  /// Save the orchestrator and worker model choices for Antigravity.
  Future<ModelSettings> saveModels({RoleModel? eval, RoleModel? executor}) async =>
      ModelSettings.fromJson(
        await _object(
          'PUT',
          '/api/settings/models',
          body: {'eval': eval?.toJson(), 'executor': executor?.toJson()},
          timeout: const Duration(seconds: 60),
        ),
      );

  /// Install the Antigravity CLI on the backend's machine with its official installer; [models] reports progress meanwhile.
  Future<ModelSettings> installKernel() async =>
      ModelSettings.fromJson(await _object('POST', '/api/settings/kernel/install', body: {'kernel': 'antigravity'}, timeout: const Duration(minutes: 11)));

  Future<GeneralSettings> general() async => GeneralSettings.fromJson(await _object('GET', '/api/settings/general'));

  /// Replace the named blocks of the general settings: `paused`, `eval`, `executor`, `policy`.
  Future<GeneralSettings> saveGeneral(Map<String, dynamic> blocks) async =>
      GeneralSettings.fromJson(await _object('PUT', '/api/settings/general', body: blocks, timeout: const Duration(seconds: 60)));

  Future<WeChatStatus> wechat() async => WeChatStatus.fromJson(await _object('GET', '/api/wechat'));

  Future<WeChatStatus> wechatConnect() async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/connect', timeout: const Duration(seconds: 30)));

  Future<WeChatStatus> wechatDisconnect() async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/disconnect', timeout: const Duration(seconds: 60)));

  Future<WeChatStatus> wechatVerify(String code) async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/verify', body: {'code': code}));

  Future<AccountsView> accounts() async => AccountsView.fromJson(await _object('GET', '/api/settings/accounts', timeout: const Duration(seconds: 90)));

  /// Start logging Antigravity in on the backend's machine.
  Future<LoginRun?> startLogin() async =>
      LoginRun.maybe((await _object('POST', '/api/settings/accounts/login', body: const <String, dynamic>{}, timeout: const Duration(seconds: 30)))['login']);

  Future<LoginRun?> login() async => LoginRun.maybe((await _object('GET', '/api/settings/accounts/login'))['login']);

  /// Pass one line, such as a code or the address the browser landed on, to the login.
  Future<LoginRun?> loginInput(String text) async => LoginRun.maybe((await _object('POST', '/api/settings/accounts/login/input', body: {'text': text}))['login']);

  Future<LoginRun?> cancelLogin() async => LoginRun.maybe((await _object('POST', '/api/settings/accounts/login/cancel'))['login']);

  Future<AccountsView> logout() async =>
      AccountsView.fromJson(await _object('POST', '/api/settings/accounts/logout', body: const <String, dynamic>{}, timeout: const Duration(seconds: 90)));

  // Multi-Device Control Plane

  Future<DevicesOverview> devicesOverview() async => DevicesOverview.fromJson(await _object('GET', '/api/devices'));

  Future<(ConditionalResult<DevicesOverview?>, bool)> devicesOverviewIfChanged({String? ifNoneMatch, String? previousRaw}) async {
    try {
      final res = await _conditionalObject('/api/devices', ifNoneMatch: ifNoneMatch, previousRaw: previousRaw);
      if (!res.changed) return (ConditionalResult<DevicesOverview?>.unchanged(raw: res.raw, etag: res.etag), false);
      return (ConditionalResult<DevicesOverview?>.changed(value: DevicesOverview.fromJson(res.value!, raw: res.raw), raw: res.raw, etag: res.etag), false);
    } on ApiException catch (error) {
      if (error.status == 404) {
        return (const ConditionalResult<DevicesOverview?>.changed(value: null, raw: '__404__'), true);
      }
      rethrow;
    }
  }

  Future<DeviceControlConfig> deviceConfig() async {
    final body = await _object('GET', '/api/devices/config');
    final cfg = body['config'] is Map ? (body['config'] as Map).cast<String, dynamic>() : body;
    return DeviceControlConfig.fromJson(cfg);
  }

  Map<String, dynamic> _deviceConfigBody({
    String? clusterId,
    String? masterNodeId,
    String? relayUrl,
    String? relaySecret,
    String? clusterSecret,
    String? e2eKey,
    bool? autoDetectLocalRelay,
    bool? enabled,
  }) => {
    if (clusterId != null && clusterId.trim().isNotEmpty) 'clusterId': clusterId.trim(),
    if (masterNodeId != null && masterNodeId.trim().isNotEmpty) 'masterNodeId': masterNodeId.trim(),
    if (relayUrl != null && relayUrl.trim().isNotEmpty) 'relayUrl': relayUrl.trim(),
    if (relaySecret != null && relaySecret.trim().isNotEmpty) 'relaySecret': relaySecret.trim(),
    if (clusterSecret != null && clusterSecret.trim().isNotEmpty) 'clusterSecret': clusterSecret.trim(),
    if (e2eKey != null && e2eKey.trim().isNotEmpty) 'e2eKey': e2eKey.trim(),
    'autoDetectLocalRelay': ?autoDetectLocalRelay,
    'enabled': ?enabled,
  };

  Future<DeviceControlConfig> initDeviceConfig({
    String? clusterId,
    String? masterNodeId,
    String? relayUrl,
    String? relaySecret,
    String? clusterSecret,
    String? e2eKey,
    bool? autoDetectLocalRelay,
    bool? enabled,
  }) async {
    final body = await _object(
      'POST',
      '/api/devices/config/init',
      body: _deviceConfigBody(
        clusterId: clusterId,
        masterNodeId: masterNodeId,
        relayUrl: relayUrl,
        relaySecret: relaySecret,
        clusterSecret: clusterSecret,
        e2eKey: e2eKey,
        autoDetectLocalRelay: autoDetectLocalRelay,
        enabled: enabled,
      ),
      timeout: const Duration(seconds: 30),
    );
    final cfg = body['config'] is Map ? (body['config'] as Map).cast<String, dynamic>() : body;
    return DeviceControlConfig.fromJson(cfg);
  }

  Future<DeviceControlConfig> updateDeviceConfig({
    String? clusterId,
    String? masterNodeId,
    String? relayUrl,
    String? relaySecret,
    String? clusterSecret,
    String? e2eKey,
    bool? autoDetectLocalRelay,
    bool? enabled,
  }) async {
    final body = await _object(
      'PUT',
      '/api/devices/config',
      body: _deviceConfigBody(
        clusterId: clusterId,
        masterNodeId: masterNodeId,
        relayUrl: relayUrl,
        relaySecret: relaySecret,
        clusterSecret: clusterSecret,
        e2eKey: e2eKey,
        autoDetectLocalRelay: autoDetectLocalRelay,
        enabled: enabled,
      ),
      timeout: const Duration(seconds: 30),
    );
    final cfg = body['config'] is Map ? (body['config'] as Map).cast<String, dynamic>() : body;
    return DeviceControlConfig.fromJson(cfg);
  }

  Future<DeviceEnrollment> createDeviceEnrollment({
    required String platform,
    required String profile,
    required String installMode,
    String? deviceId,
    String? customName,
    List<String>? workspaces,
    bool? relayBridge,
    String? mqttBind,
    String? uartDevice,
    String? cudaDevices,
    String? memoryMax,
    String? cpuQuota,
    required String transportMode,
    String? masterPublicUrl,
    int? ttlSec,
    int? maxUses,
  }) async {
    final body = await _object(
      'POST',
      '/api/devices/enrollments',
      body: {
        'platform': platform,
        'profile': profile,
        'installMode': installMode,
        'transportMode': transportMode,
        if (deviceId != null && deviceId.trim().isNotEmpty) 'deviceId': deviceId.trim(),
        if (customName != null && customName.trim().isNotEmpty) 'customName': customName.trim(),
        if (workspaces != null && workspaces.isNotEmpty) 'workspaces': workspaces,
        'relayBridge': ?relayBridge,
        if (mqttBind != null && mqttBind.trim().isNotEmpty) 'mqttBind': mqttBind.trim(),
        if (uartDevice != null && uartDevice.trim().isNotEmpty) 'uartDevice': uartDevice.trim(),
        if (cudaDevices != null && cudaDevices.trim().isNotEmpty) 'cudaDevices': cudaDevices.trim(),
        if (memoryMax != null && memoryMax.trim().isNotEmpty) 'memoryMax': memoryMax.trim(),
        if (cpuQuota != null && cpuQuota.trim().isNotEmpty) 'cpuQuota': cpuQuota.trim(),
        if (masterPublicUrl != null && masterPublicUrl.trim().isNotEmpty) 'masterPublicUrl': masterPublicUrl.trim(),
        'ttlSec': ?ttlSec,
        'maxUses': ?maxUses,
      },
      timeout: const Duration(seconds: 30),
    );
    final enrollment = body['enrollment'] is Map ? (body['enrollment'] as Map).cast<String, dynamic>() : body;
    return DeviceEnrollment.fromJson(enrollment);
  }

  Future<List<DeviceEnrollment>> deviceEnrollments() async {
    final body = await _object('GET', '/api/devices/enrollments');
    final list = body['enrollments'] is List ? body['enrollments'] as List<dynamic> : const <dynamic>[];
    return [for (final item in list) DeviceEnrollment.fromJson((item as Map).cast<String, dynamic>())];
  }

  Future<DeviceEnrollmentDetail> deviceEnrollment(String id) async =>
      DeviceEnrollmentDetail.fromJson(await _object('GET', '/api/devices/enrollments/${Uri.encodeComponent(id)}'));

  Future<DeviceEnrollment> revokeDeviceEnrollment(String id) async {
    final body = await _object('DELETE', '/api/devices/enrollments/${Uri.encodeComponent(id)}');
    final enrollment = body['enrollment'] is Map ? (body['enrollment'] as Map).cast<String, dynamic>() : body;
    return DeviceEnrollment.fromJson(enrollment);
  }

  Future<DeviceTwin> renameDevice(String id, String? customName) async {
    final trimmed = customName?.trim();
    final body = await _object(
      'PATCH',
      '/api/devices/${Uri.encodeComponent(id)}',
      body: {'customName': (trimmed == null || trimmed.isEmpty) ? null : trimmed},
    );
    final device = body['device'] is Map ? (body['device'] as Map).cast<String, dynamic>() : body;
    return DeviceTwin.fromJson(device);
  }

  Future<void> removeDevice(String id) async {
    await _object('DELETE', '/api/devices/${Uri.encodeComponent(id)}');
  }

  Future<DevicePingResult> pingDevice(String id) async =>
      DevicePingResult.fromJson(await _object('POST', '/api/devices/${Uri.encodeComponent(id)}/ping', body: const <String, dynamic>{}, timeout: const Duration(seconds: 30)));

  Future<DeviceUpdateResult> updateDevice(String id, {String? targetVersion, bool force = false}) async =>
      DeviceUpdateResult.fromJson(
        await _object(
          'POST',
          '/api/devices/${Uri.encodeComponent(id)}/update',
          body: {
            if (targetVersion != null && targetVersion.trim().isNotEmpty) 'targetVersion': targetVersion.trim(),
            if (force) 'force': true,
          },
          timeout: const Duration(minutes: 3),
        ),
      );

  Future<DeviceSandboxUpdateResult> updateDeviceSandbox(
    String id, {
    required String level,
    List<String>? workspaces,
  }) async => DeviceSandboxUpdateResult.fromJson(
    await _object(
      'PUT',
      '/api/devices/${Uri.encodeComponent(id)}/sandbox',
      body: {
        'level': level,
        if (workspaces != null && workspaces.isNotEmpty) 'workspaces': workspaces,
      },
      timeout: const Duration(seconds: 30),
    ),
  );

  // Device Local MCP Discovery & Proxy

  Future<DeviceMcpOverview> deviceMcp(String deviceId) async =>
      DeviceMcpOverview.fromJson(await _object('GET', '/api/devices/${Uri.encodeComponent(deviceId)}/mcp', timeout: const Duration(seconds: 30)));

  Future<DeviceMcpOverview> discoverDeviceMcp(String deviceId, {bool includeLoopbackProbe = false}) async => DeviceMcpOverview.fromJson(
    await _object(
      'POST',
      '/api/devices/${Uri.encodeComponent(deviceId)}/mcp/discover',
      body: {'includeLoopbackProbe': includeLoopbackProbe},
      timeout: const Duration(seconds: 45),
    ),
  );

  Future<DeviceMcpInspectResult> inspectDeviceMcp(
    String deviceId,
    String serverId, {
    bool refresh = false,
    String? query,
  }) async => DeviceMcpInspectResult.fromJson(
    await _object(
      'POST',
      '/api/devices/${Uri.encodeComponent(deviceId)}/mcp/${Uri.encodeComponent(serverId)}/inspect',
      body: {
        'refresh': refresh,
        if (query != null && query.trim().isNotEmpty) 'query': query.trim(),
      },
      timeout: const Duration(seconds: 45),
    ),
  );

  Future<DeviceMcpPolicyUpdateResult> updateDeviceMcpPolicy(
    String deviceId,
    String serverId, {
    bool? enabled,
    String? callMode,
  }) async => DeviceMcpPolicyUpdateResult.fromJson(
    await _object(
      'PUT',
      '/api/devices/${Uri.encodeComponent(deviceId)}/mcp/${Uri.encodeComponent(serverId)}/policy',
      body: {
        'enabled': ?enabled,
        if (callMode != null && callMode.trim().isNotEmpty) 'callMode': callMode.trim(),
      },
      timeout: const Duration(seconds: 30),
    ),
  );

  Future<void> stopDeviceMcpServer(String deviceId, String serverId) async {
    await _call(
      'POST',
      '/api/devices/${Uri.encodeComponent(deviceId)}/mcp/${Uri.encodeComponent(serverId)}/stop',
      body: const <String, dynamic>{},
      timeout: const Duration(seconds: 30),
    );
  }

  Future<void> restartDeviceMcpServer(String deviceId, String serverId) async {
    await _call(
      'POST',
      '/api/devices/${Uri.encodeComponent(deviceId)}/mcp/${Uri.encodeComponent(serverId)}/restart',
      body: const <String, dynamic>{},
      timeout: const Duration(seconds: 45),
    );
  }

  Future<DeviceApproval> approveDeviceApproval(String id, {String? reason}) async {
    final body = await _object(
      'POST',
      '/api/devices/approvals/${Uri.encodeComponent(id)}/approve',
      body: {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()},
      timeout: const Duration(seconds: 60),
    );
    final approval = body['approval'] is Map ? (body['approval'] as Map).cast<String, dynamic>() : body;
    return DeviceApproval.fromJson(approval);
  }

  Future<DeviceApproval> rejectDeviceApproval(String id, {String? reason}) async {
    final body = await _object(
      'POST',
      '/api/devices/approvals/${Uri.encodeComponent(id)}/reject',
      body: {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()},
      timeout: const Duration(seconds: 30),
    );
    final approval = body['approval'] is Map ? (body['approval'] as Map).cast<String, dynamic>() : body;
    return DeviceApproval.fromJson(approval);
  }

  Future<McuInstallResult> installMcu({
    required String mcuId,
    String? customName,
    required String relayDeviceId,
    required String transport,
    String? mqttBroker,
    String? serialPort,
    int? baudRate,
    String? chip,
    List<String>? backupRelayDeviceIds,
    bool autoDeploy = true,
  }) async => McuInstallResult.fromJson(
    await _object(
      'POST',
      '/api/devices/mcu/install',
      body: {
        'mcuId': mcuId.trim(),
        if (customName != null && customName.trim().isNotEmpty) 'customName': customName.trim(),
        'relayDeviceId': relayDeviceId.trim(),
        'transport': transport,
        if (mqttBroker != null && mqttBroker.trim().isNotEmpty) 'mqttBroker': mqttBroker.trim(),
        if (serialPort != null && serialPort.trim().isNotEmpty) 'serialPort': serialPort.trim(),
        'baudRate': ?baudRate,
        if (chip != null && chip.trim().isNotEmpty) 'chip': chip.trim(),
        if (backupRelayDeviceIds != null && backupRelayDeviceIds.isNotEmpty) 'backupRelayDeviceIds': backupRelayDeviceIds,
        'autoDeploy': autoDeploy,
      },
      timeout: const Duration(seconds: 60),
    ),
  );
}
