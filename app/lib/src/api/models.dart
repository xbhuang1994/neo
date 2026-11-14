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
      startedAt = _time(json['startedAt']);

  final String id;
  final String type;
  final String label;
  final DateTime? startedAt;
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

/// A kernel and whether it can run on the backend's machine.
class KernelInfo {
  KernelInfo.fromJson(Map<String, dynamic> json) : id = json['id'] as String? ?? '', problem = _text(json['problem']);

  final String id;
  final String? problem;
}

/// The kernel and model settings, with what may be chosen.
class ModelSettings {
  ModelSettings.fromJson(Map<String, dynamic> json)
    : kernel = json['kernel'] as String? ?? 'omp',
      kernels = [for (final kernel in _list(json['kernels'])) KernelInfo.fromJson(_map(kernel))],
      supportsAdvisor = _map(json['supports'])['advisor'] == true,
      thinkingLevels = _list(_map(json['supports'])['thinkingLevels']).cast<String>(),
      eval = RoleModel.fromJson(_map(json['current'])['eval']),
      executor = RoleModel.fromJson(_map(json['current'])['executor']),
      advisor = RoleModel.fromJson(_map(json['current'])['advisor']),
      available = [for (final option in _list(json['available'])) ModelOption.fromJson(_map(option))],
      problem = _text(json['problem']);

  final String kernel;
  final List<KernelInfo> kernels;
  final bool supportsAdvisor;
  final List<String> thinkingLevels;
  final RoleModel? eval;
  final RoleModel? executor;
  final RoleModel? advisor;
  final List<ModelOption> available;
  final String? problem;
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
