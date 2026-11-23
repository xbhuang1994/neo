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
