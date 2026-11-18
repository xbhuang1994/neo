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

/// Calls one backend.
class ApiClient {
  ApiClient(this.base, {this.token, http.Client? client}) : _client = client ?? http.Client();

  /// The backend's address, such as `http://127.0.0.1:3082`.
  final Uri base;

  /// The access token, where the backend wants one.
  final String? token;
  final http.Client _client;

  void close() => _client.close();

  Future<Object?> _call(String method, String path, {Object? body, Duration timeout = const Duration(seconds: 15)}) async {
    final request = http.Request(method, base.resolve(path));
    if (token != null && token!.isNotEmpty) request.headers['authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['content-type'] = 'application/json; charset=utf-8';
      request.bodyBytes = utf8.encode(jsonEncode(body));
    }
    final http.Response response;
    try {
      response = await http.Response.fromStream(await _client.send(request).timeout(timeout));
    } on TimeoutException {
      throw ApiException(0, 'timeout');
    } on http.ClientException catch (error) {
      throw ApiException(0, error.message);
    } on Exception catch (error) {
      throw ApiException(0, error.toString());
    }
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

  Future<Map<String, dynamic>> _object(String method, String path, {Object? body, Duration timeout = const Duration(seconds: 15)}) async {
    final decoded = await _call(method, path, body: body, timeout: timeout);
    if (decoded is! Map) throw ApiException(0, 'The server answered something that is not Neo');
    return decoded.cast<String, dynamic>();
  }

  Future<Health> health() async => Health.fromJson(await _object('GET', '/api/health', timeout: const Duration(seconds: 5)));

  /// The conversation, and the JSON it came as, to tell whether it changed.
  Future<(List<ChatMessage>, String)> messages() async {
    final body = await _object('GET', '/api/messages');
    final list = body['messages'] is List ? body['messages'] as List<dynamic> : const <dynamic>[];
    return ([for (final message in list) ChatMessage.fromJson((message as Map).cast<String, dynamic>())], jsonEncode(list));
  }

  Future<List<Worker>> workers() async {
    final body = await _object('GET', '/api/workers');
    final list = body['workers'] is List ? body['workers'] as List<dynamic> : const <dynamic>[];
    return [for (final worker in list) Worker.fromJson((worker as Map).cast<String, dynamic>())];
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

  Future<Worker> worker(String ticketId) async => Worker.fromJson(await _object('GET', '/api/workers/${Uri.encodeComponent(ticketId)}'));

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

  /// Save the kernels and models as one: the main session's kernel and model, and the workers' kernel (`null` follows
  /// the main session's) and model. A new main kernel reopens the main session on it.
  Future<ModelSettings> saveModels({required String kernel, required String? workerKernel, RoleModel? eval, RoleModel? executor}) async =>
      ModelSettings.fromJson(
        await _object(
          'PUT',
          '/api/settings/models',
          body: {'kernel': kernel, 'workerKernel': workerKernel, 'eval': eval?.toJson(), 'executor': executor?.toJson()},
          timeout: const Duration(seconds: 90),
        ),
      );

  Future<ModelSettings> setKernel(String kernel) async =>
      ModelSettings.fromJson(await _object('PUT', '/api/settings/kernel', body: {'kernel': kernel}, timeout: const Duration(seconds: 60)));

  /// Install a kernel's program on the backend's machine with its official installer; that can take minutes, and
  /// Hermes Agent's up to two hours on a slow link to GitHub. [models] says how far it has come meanwhile.
  Future<ModelSettings> installKernel(String kernel) async =>
      ModelSettings.fromJson(await _object('POST', '/api/settings/kernel/install', body: {'kernel': kernel}, timeout: const Duration(minutes: 121)));

  Future<GeneralSettings> general() async => GeneralSettings.fromJson(await _object('GET', '/api/settings/general'));

  /// Replace the named blocks of the general settings: `paused`, `eval`, `executor`, `policy`.
  Future<GeneralSettings> saveGeneral(Map<String, dynamic> blocks) async =>
      GeneralSettings.fromJson(await _object('PUT', '/api/settings/general', body: blocks, timeout: const Duration(seconds: 60)));

  Future<WeChatStatus> wechat() async => WeChatStatus.fromJson(await _object('GET', '/api/wechat'));

  Future<WeChatStatus> wechatConnect() async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/connect', timeout: const Duration(seconds: 30)));

  Future<WeChatStatus> wechatDisconnect() async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/disconnect', timeout: const Duration(seconds: 60)));

  Future<WeChatStatus> wechatVerify(String code) async => WeChatStatus.fromJson(await _object('POST', '/api/wechat/verify', body: {'code': code}));
}
