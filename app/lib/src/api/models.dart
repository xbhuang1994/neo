/// What the backend's API carries, as the app reads it.
library;

import 'dart:convert';
import 'dart:typed_data';

Map<String, dynamic> _map(Object? value) => value is Map ? value.cast<String, dynamic>() : const {};
List<dynamic> _list(Object? value) => value is List ? value : const [];
String? _text(Object? value) => value is String && value.isNotEmpty ? value : null;
DateTime? _time(Object? value) {
  if (value is num) return DateTime.fromMillisecondsSinceEpoch(value.toInt());
  if (value is String) return DateTime.tryParse(value)?.toLocal();
  return null;
}

/// An image shown with a chat message.
class ChatImage {
  ChatImage(this.name, this.mediaType, this.bytes);

  final String name;
  final String mediaType;
  final Uint8List bytes;
}

/// A file named with a chat message.
class ChatFile {
  const ChatFile(this.name, this.mediaType, this.kind);

  final String name;
  final String mediaType;

  /// `text` for a file whose text is part of the message, `file` otherwise.
  final String kind;
}

/// One message of the conversation.
class ChatMessage {
  ChatMessage({required this.id, required this.fromUser, required this.text, this.at, this.source, this.images = const [], this.files = const []});

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final images = <ChatImage>[];
    for (final image in _list(json['images'])) {
      final fields = _map(image);
      try {
        images.add(ChatImage(fields['name'] as String? ?? 'image', fields['mediaType'] as String? ?? 'image/png', base64Decode(fields['data'] as String? ?? '')));
      } on FormatException {
        // An image that cannot be decoded is left out; its message still shows.
      }
    }
    return ChatMessage(
      id: (json['id'] as num?)?.toInt() ?? 0,
      fromUser: json['role'] == 'user',
      text: json['text'] as String? ?? '',
      at: _time(json['at']),
      source: _text(json['source']),
      images: images,
      files: [
        for (final file in _list(json['files']))
          ChatFile(_map(file)['name'] as String? ?? '', _map(file)['mediaType'] as String? ?? '', _map(file)['kind'] as String? ?? 'file'),
      ],
    );
  }

  final int id;
  final bool fromUser;
  final String text;
  final DateTime? at;

  /// `web-panel`, `wechat` or `chat-reply`.
  final String? source;
  final List<ChatImage> images;
  final List<ChatFile> files;
}

/// A file to send with a chat message.
class OutgoingFile {
  OutgoingFile(this.name, this.mediaType, this.bytes);

  final String name;
  final String mediaType;
  final Uint8List bytes;

  Map<String, dynamic> toJson() => {'name': name, 'mediaType': mediaType, 'data': base64Encode(bytes)};
}

/// How a worker is doing, for its badge.
enum WorkerTone { working, person, idle, ended }

/// A background job of a worker.
class BackgroundJob {
  BackgroundJob.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      type = json['type'] as String? ?? 'bash',
      label = json['label'] as String? ?? '',
      startedAt = _time(json['startedAt']),
      elapsedSeconds = (json['elapsedSeconds'] as num?)?.toInt(),
      progress = json['progress'] as String? ?? '';

  final String id;
  final String type;

  /// A shell job's command, or a subagent's task.
  final String label;
  final DateTime? startedAt;

  /// How long it had run when the server answered.
  final int? elapsedSeconds;

  /// Its latest step: what a subagent does now, or a job's last line of output.
  final String progress;
}

/// A worker's latest report.
class WorkerReport {
  WorkerReport.fromJson(Map<String, dynamic> json) : state = json['state'] as String? ?? '', summary = json['summary'] as String? ?? '', at = _time(json['at']);

  final String state;
  final String summary;
  final DateTime? at;
}

/// A line of a worker's recent activity.
class WorkerActivity {
  WorkerActivity.fromJson(Map<String, dynamic> json)
    : id = (json['id'] as num?)?.toInt() ?? 0,
      role = json['role'] as String? ?? '',
      text = json['text'] as String? ?? '',
      at = _time(json['at']);

  final int id;
  final String role;
  final String text;
  final DateTime? at;
}

/// A ticket with its worker.
class Worker {
  Worker.fromJson(Map<String, dynamic> json)
    : ticketId = json['ticketId'] as String? ?? '',
      title = json['title'] as String? ?? '',
      stage = _map(json['stage'])['stage'] as String? ?? 'working',
      action = _map(json['stage'])['action'] as String?,
      outcome = _text(json['outcome']),
      updatedAt = _time(json['updatedAt']),
      directory = _text(json['directory']),
      digest = _text(json['digest']),
      loaded = _map(json['session'])['loaded'] == true,
      streaming = _map(json['session'])['streaming'] == true,
      background = [for (final job in _list(json['background'])) BackgroundJob.fromJson(_map(job))],
      assignmentId = _text(_map(json['assignment'])['id']),
      assignmentState = _text(_map(json['assignment'])['state']),
      report = json['progress'] is Map ? WorkerReport.fromJson(_map(json['progress'])) : null,
      question = _text(_map(json['attention'])['question']),
      deliveryError = _text(_map(json['delivery'])['error']),
      pendingInputs = (json['pendingInputs'] as num?)?.toInt() ?? 0,
      recent = [for (final line in _list(json['recent'])) WorkerActivity.fromJson(_map(line))],
      raw = jsonEncode(json);

  final String ticketId;
  final String title;

  /// `person`, `working`, `idle` or `ended`.
  final String stage;

  /// For `person`: `delivery`, `answer`, `review`, `blocked` or `failed`; for `working`: `queued` or nothing.
  final String? action;

  /// For an ended ticket: `completed`, `dropped` or `stopped`.
  final String? outcome;
  final DateTime? updatedAt;
  final String? directory;
  final String? digest;
  final bool loaded;
  final bool streaming;
  final List<BackgroundJob> background;
  final String? assignmentId;
  final String? assignmentState;
  final WorkerReport? report;
  final String? question;
  final String? deliveryError;
  final int pendingInputs;

  /// The worker's latest transcript entries; only a detail carries them.
  final List<WorkerActivity> recent;

  /// The JSON this was read from, to tell whether anything changed.
  final String raw;

  bool get active => stage != 'ended';

  WorkerTone get tone {
    if (streaming) return WorkerTone.working;
    if (background.isNotEmpty && stage != 'person') return WorkerTone.working;
    return switch (stage) {
      'ended' => WorkerTone.ended,
      'person' => WorkerTone.person,
      'idle' => WorkerTone.idle,
      _ => WorkerTone.working,
    };
  }
}

/// A model a role can use.
class ModelOption {
  ModelOption.fromJson(Map<String, dynamic> json) : id = json['id'] as String? ?? '', provider = json['provider'] as String? ?? '', name = json['name'] as String? ?? '';

  final String id;
  final String provider;
  final String name;
}

/// A role's chosen model; `null` in its place follows the kernel's default.
class RoleModel {
  const RoleModel(this.provider, this.model, [this.thinkingLevel]);

  static RoleModel? fromJson(Object? json) {
    if (json is! Map) return null;
    return RoleModel(json['provider'] as String? ?? '', json['model'] as String? ?? '', _text(json['thinkingLevel']));
  }

  final String provider;
  final String model;
  final String? thinkingLevel;

  Map<String, dynamic> toJson() => {'provider': provider, 'model': model, if (thinkingLevel != null) 'thinkingLevel': thinkingLevel};

  RoleModel withThinking(String? level) => RoleModel(provider, model, level);

  @override
  bool operator ==(Object other) => other is RoleModel && other.provider == provider && other.model == model && other.thinkingLevel == thinkingLevel;

  @override
  int get hashCode => Object.hash(provider, model, thinkingLevel);
}

/// A kernel, whether its program is installed on the backend's machine and can run there, the models it offers,
/// and the model choices kept for it.
class KernelInfo {
  KernelInfo.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      problem = _text(json['problem']),
      installed = json['installed'] != false,
      installing = json['installing'] == true,
      installProgress = _text(json['installProgress']),
      thinkingLevels = _list(_map(json['supports'])['thinkingLevels']).cast<String>(),
      available = [for (final option in _list(json['available'])) ModelOption.fromJson(_map(option))],
      listProblem = _text(json['listProblem']),
      loading = json['loading'] == true,
      eval = RoleModel.fromJson(_map(json['models'])['eval']),
      executor = RoleModel.fromJson(_map(json['models'])['executor']);

  final String id;
  final String? problem;
  final bool installed;
  final bool installing;

  /// The last line its installer printed, while it is being installed: how far its download has come.
  final String? installProgress;
  final List<String> thinkingLevels;
  final List<ModelOption> available;

  /// Why it lists no models, when it cannot run or listing them failed.
  final String? listProblem;

  /// It is still listing its models.
  final bool loading;
  final RoleModel? eval;
  final RoleModel? executor;
}

/// The kernel and model settings, with what may be chosen.
class ModelSettings {
  ModelSettings.fromJson(Map<String, dynamic> json)
    : kernel = json['kernel'] as String? ?? 'omp',
      workerKernel = _text(json['workerKernel']) ?? json['kernel'] as String? ?? 'omp',
      workerKernelFollows = json['workerKernelFollows'] != false,
      loading = json['loading'] == true,
      kernels = [for (final kernel in _list(json['kernels'])) KernelInfo.fromJson(_map(kernel))],
      thinkingLevels = _list(_map(json['supports'])['thinkingLevels']).cast<String>(),
      eval = RoleModel.fromJson(_map(json['current'])['eval']),
      executor = RoleModel.fromJson(_map(json['current'])['executor']),
      available = [for (final option in _list(json['available'])) ModelOption.fromJson(_map(option))],
      problem = _text(json['problem']);

  /// The kernel the main session runs on.
  final String kernel;

  /// The kernel workers run on, and whether it follows the main session's.
  final String workerKernel;
  final bool workerKernelFollows;

  /// A kernel is still listing its models.
  final bool loading;
  final List<KernelInfo> kernels;
  final List<String> thinkingLevels;
  final RoleModel? eval;
  final RoleModel? executor;
  final List<ModelOption> available;
  final String? problem;

  /// What is known of a kernel; an empty one when the backend did not list it.
  KernelInfo info(String id) => kernels.firstWhere((kernel) => kernel.id == id, orElse: () => KernelInfo.fromJson({'id': id}));
}

/// A rule of the Policy.
class Rule {
  Rule({required this.id, required this.name, required this.enabled, required this.instruction});

  Rule.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      name = json['name'] as String? ?? '',
      enabled = json['enabled'] == true,
      instruction = json['instruction'] as String? ?? '';

  String id;
  String name;
  bool enabled;
  String instruction;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'enabled': enabled, 'instruction': instruction};
}

/// The general settings, editable in place and sent back block by block.
class GeneralSettings {
  GeneralSettings.fromJson(Map<String, dynamic> json)
    : paused = json['paused'] == true,
      evalMode = _map(json['eval'])['mode'] as String? ?? 'observe',
      evalTimeoutSeconds = (_map(json['eval'])['timeoutSeconds'] as num?)?.toInt() ?? 120,
      maxWorkers = (_map(json['executor'])['maxWorkers'] as num?)?.toInt() ?? 3,
      directory = _map(json['executor'])['directory'] as String? ?? '',
      prepare = _map(json['executor'])['prepare'] as String? ?? '',
      prepareShell = _map(json['executor'])['prepareShell'] as String? ?? '',
      blockedCommands = _list(_map(json['executor'])['blockedCommands']).cast<String>().toList(),
      rules = [for (final rule in _list(_map(json['policy'])['rules'])) Rule.fromJson(_map(rule))],
      sources = jsonDecode(jsonEncode(_map(json['policy'])['sources'] ?? const {})) as Map<String, dynamic>,
      defaultDirectory = _map(json['defaults'])['directory'] as String? ?? '',
      maxWorkersRange = _range(_map(json['limits'])['maxWorkers'], 1, 16),
      evalTimeoutRange = _range(_map(json['limits'])['evalTimeoutSeconds'], 30, 600);

  static (int, int) _range(Object? value, int low, int high) {
    final list = _list(value);
    return list.length == 2 ? ((list[0] as num).toInt(), (list[1] as num).toInt()) : (low, high);
  }

  bool paused;
  String evalMode;
  int evalTimeoutSeconds;
  int maxWorkers;
  String directory;
  String prepare;
  String prepareShell;
  List<String> blockedCommands;
  List<Rule> rules;

  /// Who may write, by Source, kept as the backend gave it.
  Map<String, dynamic> sources;
  final String defaultDirectory;
  final (int, int) maxWorkersRange;
  final (int, int) evalTimeoutRange;

  /// The senders the chat Source listens to.
  List<String> get chatSenders => [for (final entry in _list(_map(sources['chat'])['allowed'])) _map(entry)['id'] as String? ?? ''];

  Map<String, dynamic> evalJson() => {'mode': evalMode, 'timeoutSeconds': evalTimeoutSeconds};

  Map<String, dynamic> executorJson() => {
    'maxWorkers': maxWorkers,
    'directory': directory.trim(),
    'prepare': prepare.trim(),
    if (prepareShell.trim().isNotEmpty) 'prepareShell': prepareShell.trim(),
    'blockedCommands': blockedCommands,
  };

  Map<String, dynamic> policyJson() => {'rules': [for (final rule in rules) rule.toJson()], 'sources': sources};
}

/// Where the WeChat bridge stands.
class WeChatStatus {
  WeChatStatus.fromJson(Map<String, dynamic> json)
    : state = json['state'] as String? ?? 'disconnected',
      message = json['message'] as String? ?? '',
      qrContent = _text(json['qrContent']),
      senderId = _text(json['senderId']);

  /// `disconnected`, `waiting`, `scaned`, `verify`, `connected` or `error`.
  final String state;
  final String message;
  final String? qrContent;
  final String? senderId;

  bool get loggingIn => state == 'waiting' || state == 'scaned' || state == 'verify';
}

/// A part of the backend and how it is doing.
class Component {
  Component(this.name, Map<String, dynamic> json) : state = json['state'] as String? ?? '', detail = json['detail'] as String? ?? '';

  final String name;
  final String state;
  final String detail;
}

/// Whether the backend runs, and how its parts are doing.
class Health {
  Health.fromJson(Map<String, dynamic> json)
    : ready = json['ready'] == true,
      version = json['version'] as String? ?? '',
      kernel = json['kernel'] as String? ?? '',
      paused = json['paused'] == true,
      components = [for (final entry in _map(json['components']).entries) Component(entry.key, _map(entry.value))];

  final bool ready;
  final String version;
  final String kernel;
  final bool paused;
  final List<Component> components;

  /// The kernel's problem, when it cannot run.
  String? get kernelProblem {
    for (final component in components) {
      if (component.name == 'kernel' && component.state == 'error') return component.detail;
    }
    return null;
  }
}

/// What one busy worker is doing now, in a line.
class WorkerDoing {
  WorkerDoing.fromJson(Map<String, dynamic> json)
    : ticketId = json['ticketId'] as String? ?? '',
      title = json['title'] as String? ?? '',
      doing = json['doing'] as String? ?? '';

  final String ticketId;
  final String title;
  final String doing;
}

/// What is at work now: whether the router is thinking, and what each busy worker is doing.
class Activity {
  Activity.fromJson(Map<String, dynamic> json)
    : router = json['router'] == true,
      workers = [for (final worker in _list(json['workers'])) WorkerDoing.fromJson(_map(worker))],
      raw = jsonEncode(json);

  const Activity.idle() : router = false, workers = const [], raw = '';

  final bool router;
  final List<WorkerDoing> workers;

  /// The JSON this was read from, to tell whether anything changed.
  final String raw;

  bool get busy => router || workers.isNotEmpty;
}

/// A custom model provider the kernels share, as the backend shows it: its key only as a hint.
class CustomProvider {
  CustomProvider.fromJson(Map<String, dynamic> json)
    : raw = Map<String, dynamic>.of(json)
        ..remove('key')
        ..remove('listsModels')
        ..remove('modelsProblem'),
      listsModels = json['listsModels'] != false,
      modelsProblem = _text(json['modelsProblem']),
      name = json['name'] as String? ?? '',
      api = json['api'] as String? ?? 'openai-completions',
      baseUrl = json['baseUrl'] as String? ?? '',
      headers = _map(json['headers']).map((name, value) => MapEntry(name, '$value')),
      models = [for (final model in _list(json['models'])) _map(model)],
      kernels = _list(json['kernels']).cast<String>(),
      keyHint = _text(json['key']);

  /// Everything the backend sent but the key hint, to send back as it was.
  final Map<String, dynamic> raw;
  final String name;
  final String api;
  final String baseUrl;
  final Map<String, String> headers;

  /// Each model as the backend has it: `id`, `name`, and fields the app does not edit, which go back unchanged.
  final List<Map<String, dynamic>> models;
  final List<String> kernels;
  final String? keyHint;

  /// Whether its models are listed over its API rather than typed.
  final bool listsModels;

  /// Why its models could not be listed the last time.
  final String? modelsProblem;
}

/// The custom providers, with the APIs a provider may speak and the ones each kernel can use.
class ProvidersView {
  ProvidersView.fromJson(Map<String, dynamic> json)
    : providers = [for (final provider in _list(json['providers'])) CustomProvider.fromJson(_map(provider))],
      apis = _list(json['apis']).cast<String>(),
      serves = _map(json['serves']),
      imported = (json['imported'] as num?)?.toInt();

  final List<CustomProvider> providers;
  final List<String> apis;
  final Map<String, dynamic> serves;

  /// How many an import added, after one.
  final int? imported;

  /// Whether a provider of an API lists its models itself.
  bool listsModels(String api) => apis.contains(api);

  /// Whether a kernel can use a provider of an API.
  bool kernelServes(String kernel, String api) {
    final apis = serves[kernel];
    return apis == '*' || (apis is List && apis.contains(api));
  }
}

/// An account a kernel is logged in with.
class KernelAccount {
  KernelAccount.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      provider = json['provider'] as String? ?? '',
      kind = json['kind'] as String? ?? '',
      label = json['label'] as String? ?? '',
      removable = json['removable'] == true;

  final String id;
  final String provider;
  final String kind;
  final String label;
  final bool removable;
}

/// One kernel's accounts and what can be done about them.
class KernelAccounts {
  KernelAccounts.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      installed = json['installed'] == true,
      problem = _text(json['problem']),
      accounts = [for (final account in _list(_map(json['accounts'])['accounts'])) KernelAccount.fromJson(_map(account))],
      login = [for (final option in _list(_map(json['accounts'])['login'])) (_map(option)['id'] as String? ?? '', _map(option)['name'] as String? ?? '')],
      anyProvider = _map(json['accounts'])['anyProvider'] == true,
      apiKeys = _map(json['accounts'])['apiKeys'] == true,
      note = _text(_map(json['accounts'])['note']);

  final String id;
  final bool installed;
  final String? problem;
  final List<KernelAccount> accounts;

  /// The providers it can log in to, as (id, name).
  final List<(String, String)> login;
  final bool anyProvider;
  final bool apiKeys;
  final String? note;
}

/// A login run by the backend: the links to open, and what the login program printed.
class LoginRun {
  LoginRun.fromJson(Map<String, dynamic> json)
    : id = (json['id'] as num?)?.toInt() ?? 0,
      kernel = json['kernel'] as String? ?? '',
      provider = json['provider'] as String? ?? '',
      state = json['state'] as String? ?? 'failed',
      links = _list(json['links']).cast<String>(),
      output = json['output'] as String? ?? '';

  static LoginRun? maybe(Object? json) => json is Map ? LoginRun.fromJson(_map(json)) : null;

  final int id;
  final String kernel;
  final String provider;

  /// `running`, `done` or `failed`.
  final String state;
  final List<String> links;
  final String output;

  bool get running => state == 'running';
}

/// Every kernel's accounts, and the login in progress or the last one.
class AccountsView {
  AccountsView.fromJson(Map<String, dynamic> json)
    : kernels = [for (final kernel in _list(json['kernels'])) KernelAccounts.fromJson(_map(kernel))],
      login = LoginRun.maybe(json['login']);

  AccountsView.withLogin(AccountsView view, this.login) : kernels = view.kernels;

  final List<KernelAccounts> kernels;
  final LoginRun? login;
}
