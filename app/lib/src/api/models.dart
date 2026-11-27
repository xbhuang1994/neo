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
  const RoleModel(this.provider, this.model);

  static RoleModel? fromJson(Object? json) {
    if (json is! Map) return null;
    return RoleModel(json['provider'] as String? ?? '', json['model'] as String? ?? '');
  }

  final String provider;
  final String model;

  Map<String, dynamic> toJson() => {'provider': provider, 'model': model};

  @override
  bool operator ==(Object other) => other is RoleModel && other.provider == provider && other.model == model;

  @override
  int get hashCode => Object.hash(provider, model);
}

/// The Antigravity CLI status and model settings, with what may be chosen.
class ModelSettings {
  ModelSettings.fromJson(Map<String, dynamic> json)
    : kernel = json['kernel'] as String? ?? 'antigravity',
      installed = json['installed'] != false,
      installing = json['installing'] == true,
      installProgress = _text(json['installProgress']),
      loading = json['loading'] == true,
      eval = RoleModel.fromJson(_map(json['current'])['eval']),
      executor = RoleModel.fromJson(_map(json['current'])['executor']),
      available = [for (final option in _list(json['available'])) ModelOption.fromJson(_map(option))],
      problem = _text(json['problem']),
      listProblem = _text(json['listProblem']);

  final String kernel;
  final bool installed;
  final bool installing;

  /// The last line its installer printed, while it is being installed.
  final String? installProgress;

  /// Antigravity is still listing its models.
  final bool loading;
  final RoleModel? eval;
  final RoleModel? executor;
  final List<ModelOption> available;
  final String? problem;

  /// Why it lists no models, when it cannot run or listing them failed.
  final String? listProblem;
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
      recoveryMode = json['recoveryMode'] != false,
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
  bool recoveryMode;
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

/// The Google account Antigravity is signed in with.
class AntigravityAccount {
  AntigravityAccount.fromJson(Map<String, dynamic> json) : email = json['email'] as String? ?? '', removable = json['removable'] == true;

  static AntigravityAccount? maybe(Object? json) => json is Map ? AntigravityAccount.fromJson(_map(json)) : null;

  final String email;
  final bool removable;
}

/// An Antigravity login run by the backend: the links to open, and what the login program printed.
class LoginRun {
  LoginRun.fromJson(Map<String, dynamic> json)
    : id = (json['id'] as num?)?.toInt() ?? 0,
      state = json['state'] as String? ?? 'failed',
      links = _list(json['links']).cast<String>(),
      output = json['output'] as String? ?? '';

  static LoginRun? maybe(Object? json) => json is Map ? LoginRun.fromJson(_map(json)) : null;

  final int id;

  /// `running`, `done` or `failed`.
  final String state;
  final List<String> links;
  final String output;

  bool get running => state == 'running';
}

/// Antigravity's account status, and any login in progress or the last one.
class AccountsView {
  AccountsView.fromJson(Map<String, dynamic> json)
    : installed = json['installed'] == true,
      problem = _text(json['problem']),
      account = AntigravityAccount.maybe(json['account']),
      note = _text(json['note']),
      login = LoginRun.maybe(json['login']);

  AccountsView.withLogin(AccountsView view, this.login)
    : installed = view.installed,
      problem = view.problem,
      account = view.account,
      note = view.note;

  final bool installed;
  final String? problem;
  final AntigravityAccount? account;
  final String? note;
  final LoginRun? login;
}

List<String> _strings(Object? value) => [for (final item in _list(value)) if (item is String && item.isNotEmpty) item];

/// Public configuration and relay connectivity state for the Master Neo device control plane.
class DeviceControlConfig {
  const DeviceControlConfig({
    this.enabled = false,
    this.configured = false,
    this.clusterId = '',
    this.masterNodeId = '',
    this.relayUrl,
    this.hasRelaySecret = false,
    this.hasClusterSecret = false,
    this.hasToken = false,
    this.hasE2eKey = false,
    this.canMintTokens = false,
    this.relayState = 'idle',
    this.localRelayDetected = false,
    this.defaultRelayUrl,
    this.agentVersion,
  });

  DeviceControlConfig.fromJson(Map<String, dynamic> json)
    : enabled = json['enabled'] == true,
      configured = json['configured'] == true,
      clusterId = json['clusterId'] as String? ?? '',
      masterNodeId = json['masterNodeId'] as String? ?? '',
      relayUrl = _text(json['relayUrl']),
      hasRelaySecret = json['hasRelaySecret'] == true,
      hasClusterSecret = json['hasClusterSecret'] == true,
      hasToken = json['hasToken'] == true,
      hasE2eKey = json['hasE2eKey'] == true,
      canMintTokens = json['canMintTokens'] == true,
      relayState = _text(json['relayState']) ?? 'idle',
      localRelayDetected = json['localRelayDetected'] == true,
      defaultRelayUrl = _text(json['defaultRelayUrl']),
      agentVersion = _text(json['agentVersion']);

  final bool enabled;
  final bool configured;
  final String clusterId;
  final String masterNodeId;
  final String? relayUrl;
  final bool hasRelaySecret;
  final bool hasClusterSecret;
  final bool hasToken;
  final bool hasE2eKey;
  final bool canMintTokens;

  /// `idle`, `connecting`, `connected`, `reconnecting` or `closed`.
  final String relayState;
  final bool localRelayDetected;
  final String? defaultRelayUrl;
  final String? agentVersion;
}

/// Optional Tier 2 MCU bridge settings advertised by a Tier 1 OS agent.
class DeviceRelayConfig {
  const DeviceRelayConfig({this.enabled = false, this.mqttBind, this.uartDevice});

  DeviceRelayConfig.fromJson(Map<String, dynamic> json)
    : enabled = json['enabled'] == true,
      mqttBind = _text(json['mqtt_bind']) ?? _text(json['mqttBind']),
      uartDevice = _text(json['uart_device']) ?? _text(json['uartDevice']);

  final bool enabled;
  final String? mqttBind;
  final String? uartDevice;
}

/// A declared action in a device's capability manifest.
class DeviceActionSpec {
  const DeviceActionSpec({required this.name, this.description, this.risk});

  DeviceActionSpec.fromJson(Map<String, dynamic> json)
    : name = json['name'] as String? ?? '',
      description = _text(json['description']),
      risk = _text(json['risk']);

  final String name;
  final String? description;
  final String? risk;
}

/// Hardware, sandbox, and capability manifest reported by a Tier 1 OS agent or Tier 2 MCU.
class DeviceManifest {
  DeviceManifest.fromJson(Map<String, dynamic> json)
    : deviceId = _text(json['device_id']) ?? _text(json['deviceId']) ?? '',
      tier = _text(json['tier']) ?? 'os',
      os = _text(json['os']),
      arch = _text(json['arch']),
      hostname = _text(json['hostname']),
      cpus = (json['cpus'] as num?)?.toInt(),
      ramMb = (json['ram_mb'] as num?)?.toInt() ?? (json['ramMb'] as num?)?.toInt(),
      gpus = _parseGpus(json),
      capabilities = _strings(json['capabilities']),
      actions = [for (final item in _list(json['actions'])) DeviceActionSpec.fromJson(_map(item))],
      sandbox = _map(json['sandbox']),
      relayConfig = json['relay_config'] is Map
          ? DeviceRelayConfig.fromJson(_map(json['relay_config']))
          : json['relayConfig'] is Map
          ? DeviceRelayConfig.fromJson(_map(json['relayConfig']))
          : null,
      chip = _text(json['chip']),
      fw = _text(json['fw']),
      acts = _strings(json['acts']);

  static List<String> _parseGpus(Map<String, dynamic> json) {
    final gpus = _strings(json['gpus']);
    if (gpus.isNotEmpty) return gpus;
    final gpu = _text(json['gpu']);
    if (gpu != null) return [gpu];
    final cuda = _text(json['cuda_devices']) ?? _text(_map(json['sandbox'])['cuda_devices']);
    if (cuda != null) return ['CUDA $cuda'];
    return const [];
  }

  final String deviceId;
  final String tier;
  final String? os;
  final String? arch;
  final String? hostname;
  final int? cpus;
  final int? ramMb;
  final List<String> gpus;
  final List<String> capabilities;
  final List<DeviceActionSpec> actions;
  final Map<String, dynamic> sandbox;
  final DeviceRelayConfig? relayConfig;
  final String? chip;
  final String? fw;
  final List<String> acts;

  /// Canonical workspace paths permitted by the agent's local sandbox policy.
  List<String> get workspaces {
    for (final key in const ['allowed_workspaces', 'allowedWorkspaces', 'workspaces']) {
      final raw = sandbox[key];
      if (raw is List) {
        final paths = _strings(raw);
        if (paths.isNotEmpty) return paths;
      } else if (raw is String && raw.isNotEmpty) {
        return [raw];
      }
    }
    final single = _text(sandbox['workspace']) ?? _text(sandbox['root']);
    return single == null ? const [] : [single];
  }

  bool get hasGpu => gpus.isNotEmpty || capabilities.contains('gpu');
}

/// A persisted Device Twin for a Tier 1 OS agent or Tier 2 MCU.
class DeviceTwin {
  DeviceTwin.fromJson(Map<String, dynamic> json)
    : deviceId = json['deviceId'] as String? ?? '',
      clusterId = json['clusterId'] as String? ?? '',
      customName = _text(json['customName'])?.trim(),
      tier = _text(json['tier']) ?? 'os',
      status = _text(json['status']) ?? 'offline',
      route = _text(json['route']) ?? 'relay',
      lanUrl = _text(json['lanUrl']),
      relayNodeId = _text(json['relayNodeId']),
      backupRelayNodeIds = _strings(json['backupRelayNodeIds']),
      alertSuppressed = json['alertSuppressed'] == true,
      manifest = json['manifest'] is Map ? DeviceManifest.fromJson(_map(json['manifest'])) : null,
      capabilities = _strings(json['capabilities']),
      desiredState = _map(json['desiredState']),
      reportedState = _map(json['reportedState']),
      pendingQueueLength = _list(json['pendingQueue']).length,
      lastSeqId = (json['lastSeqId'] as num?)?.toInt() ?? 0,
      lastAckedSeqId = (json['lastAckedSeqId'] as num?)?.toInt() ?? 0,
      lastSeenAt = _time(json['lastSeenAt']) ?? _time(json['lastSeenMs']),
      updatedAt = _time(json['updatedAt']),
      raw = jsonEncode(json);

  final String deviceId;
  final String clusterId;

  /// Optional user-defined display name (does not change protocol [deviceId]).
  final String? customName;

  /// `os` or `mcu`.
  final String tier;

  /// `online`, `offline`, `sleeping`, or `unreachable_via_relay`.
  final String status;

  /// `lan`, `p2p`, `relay`, or `via_tier1`.
  final String route;
  final String? lanUrl;
  final String? relayNodeId;
  final List<String> backupRelayNodeIds;
  final bool alertSuppressed;
  final DeviceManifest? manifest;
  final List<String> capabilities;
  final Map<String, dynamic> desiredState;
  final Map<String, dynamic> reportedState;
  final int pendingQueueLength;
  final int lastSeqId;
  final int lastAckedSeqId;
  final DateTime? lastSeenAt;
  final DateTime? updatedAt;
  final String raw;

  bool get hasCustomName => customName != null && customName!.isNotEmpty;
  String get displayName => hasCustomName ? customName! : deviceId;
  bool get isOnline => status == 'online';
  bool get isMcu => tier == 'mcu';
  bool get isTier1 => tier == 'os';
  bool get hasGpu => manifest?.hasGpu == true || capabilities.contains('gpu');
  List<String> get workspaces => manifest?.workspaces ?? const [];
  String? get mqttBind => manifest?.relayConfig?.mqttBind;
  String? get uartDevice => manifest?.relayConfig?.uartDevice;
  bool get isRelayCapable =>
      manifest?.relayConfig?.enabled == true ||
      capabilities.contains('relay') ||
      (mqttBind != null && mqttBind!.isNotEmpty) ||
      (uartDevice != null && uartDevice!.isNotEmpty);
}

/// A risk-gated device invocation awaiting human approval.
class DeviceApproval {
  DeviceApproval.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      shortCode = json['shortCode'] as String? ?? '',
      clusterId = json['clusterId'] as String? ?? '',
      deviceId = json['deviceId'] as String? ?? '',
      action = json['action'] as String? ?? '',
      params = _map(json['params']),
      timeoutMs = (json['timeoutMs'] as num?)?.toInt(),
      reason = _text(json['reason']),
      status = _text(json['status']) ?? 'pending',
      createdAt = _time(json['createdAt']),
      decidedAt = _time(json['decidedAt']),
      decidedBy = _text(json['decidedBy']),
      result = json['result'],
      error = _text(json['error']);

  final String id;
  final String shortCode;
  final String clusterId;
  final String deviceId;
  final String action;
  final Map<String, dynamic> params;
  final int? timeoutMs;
  final String? reason;

  /// `pending`, `approved`, or `rejected`.
  final String status;
  final DateTime? createdAt;
  final DateTime? decidedAt;
  final String? decidedBy;
  final Object? result;
  final String? error;

  bool get isPending => status == 'pending';
}

/// Platform-specific one-click install and uninstall commands for a device enrollment.
class EnrollmentCommands {
  const EnrollmentCommands({
    this.linuxRoot = '',
    this.linuxUser = '',
    this.macos = '',
    this.windows = '',
    this.docker = '',
    this.uninstall = '',
  });

  EnrollmentCommands.fromJson(Map<String, dynamic> json)
    : linuxRoot = json['linuxRoot'] as String? ?? '',
      linuxUser = json['linuxUser'] as String? ?? '',
      macos = json['macos'] as String? ?? '',
      windows = json['windows'] as String? ?? '',
      docker = json['docker'] as String? ?? '',
      uninstall = json['uninstall'] as String? ?? '';

  final String linuxRoot;
  final String linuxUser;
  final String macos;
  final String windows;
  final String docker;
  final String uninstall;

  String forPlatform(String platform, {bool linuxUseRoot = true}) {
    final chosen = switch (platform) {
      'linux' => linuxUseRoot ? (linuxRoot.isNotEmpty ? linuxRoot : linuxUser) : (linuxUser.isNotEmpty ? linuxUser : linuxRoot),
      'macos' => macos,
      'windows' => windows,
      'docker' => docker,
      _ => linuxRoot,
    };
    if (chosen.isNotEmpty) return chosen;
    for (final candidate in [linuxRoot, linuxUser, macos, windows, docker]) {
      if (candidate.isNotEmpty) return candidate;
    }
    return '';
  }
}

/// A short-lived enrollment ticket that generates one-click agent install commands.
class DeviceEnrollment {
  DeviceEnrollment.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String? ?? '',
      clusterId = json['clusterId'] as String? ?? '',
      platform = _text(json['platform']) ?? 'linux',
      profile = _text(json['profile']) ?? 'personal',
      installMode = _text(json['installMode']) ?? 'auto',
      transportMode = _text(json['transportMode']) ?? 'relay',
      requestedDeviceId = _text(json['requestedDeviceId']),
      requestedCustomName = _text(json['requestedCustomName']),
      status = _text(json['status']) ?? 'pending',
      createdAt = _time(json['createdAt']),
      expiresAt = _time(json['expiresAt']),
      maxUses = (json['maxUses'] as num?)?.toInt() ?? 1,
      usedCount = (json['usedCount'] as num?)?.toInt() ?? 0,
      lastClaimedIp = _text(json['lastClaimedIp']),
      lastClaimedAt = _time(json['lastClaimedAt']),
      enrolledDeviceIds = _strings(json['enrolledDeviceIds']),
      enrollCode = json['enrollCode'] as String? ?? '',
      commands = EnrollmentCommands.fromJson(_map(json['commands']));

  final String id;
  final String clusterId;

  /// `linux`, `macos`, `windows`, or `docker`.
  final String platform;

  /// `personal`, `corp`, `readonly`, or `desktop`.
  final String profile;

  /// `auto`, `system`, `user`, or `foreground`.
  final String installMode;

  /// `relay` or `direct`.
  final String transportMode;
  final String? requestedDeviceId;
  final String? requestedCustomName;

  /// `pending`, `claimed`, `completed`, `expired`, or `revoked`.
  final String status;
  final DateTime? createdAt;
  final DateTime? expiresAt;
  final int maxUses;
  final int usedCount;
  final String? lastClaimedIp;
  final DateTime? lastClaimedAt;
  final List<String> enrolledDeviceIds;
  final String enrollCode;
  final EnrollmentCommands commands;

  bool get isActive => status == 'pending' || status == 'claimed';
}

/// Snapshot returned by `GET /api/devices`.
class DevicesOverview {
  const DevicesOverview({
    this.config = const DeviceControlConfig(),
    this.devices = const [],
    this.approvals = const [],
    this.enrollments = const [],
    this.raw = '',
  });

  DevicesOverview.fromJson(Map<String, dynamic> json)
    : config = DeviceControlConfig.fromJson(_map(json['config'])),
      devices = [for (final item in _list(json['devices'])) DeviceTwin.fromJson(_map(item))],
      approvals = [for (final item in _list(json['approvals'])) DeviceApproval.fromJson(_map(item))],
      enrollments = [for (final item in _list(json['enrollments'])) DeviceEnrollment.fromJson(_map(item))],
      raw = jsonEncode(json);

  final DeviceControlConfig config;
  final List<DeviceTwin> devices;
  final List<DeviceApproval> approvals;
  final List<DeviceEnrollment> enrollments;
  final String raw;

  List<DeviceApproval> get pendingApprovals => [for (final item in approvals) if (item.isPending) item];
  int get pendingApprovalsCount => pendingApprovals.length;
  int get onlineDevicesCount => devices.where((device) => device.isOnline).length;
  List<DeviceEnrollment> get activeEnrollments => [for (final item in enrollments) if (item.isActive) item];
  List<DeviceTwin> get tier1Devices => [for (final device in devices) if (device.isTier1) device];
  List<DeviceTwin> get mcuDevices => [for (final device in devices) if (device.isMcu) device];
}

/// Live enrollment status and newly onboarded device twins returned by `GET /api/devices/enrollments/:id`.
class DeviceEnrollmentDetail {
  DeviceEnrollmentDetail.fromJson(Map<String, dynamic> json)
    : enrollment = DeviceEnrollment.fromJson(_map(json['enrollment'])),
      devices = [for (final item in _list(json['devices'])) DeviceTwin.fromJson(_map(item))];

  final DeviceEnrollment enrollment;
  final List<DeviceTwin> devices;
}

/// Result of `POST /api/devices/:id/ping`.
class DevicePingResult {
  DevicePingResult.fromJson(Map<String, dynamic> json)
    : ok = json['ok'] == true,
      deviceId = json['deviceId'] as String? ?? '',
      latencyMs = (json['latencyMs'] as num?)?.toInt() ?? 0,
      status = _text(json['status']) ?? 'offline',
      route = _text(json['route']) ?? 'relay',
      error = _text(json['error']);

  final bool ok;
  final String deviceId;
  final int latencyMs;
  final String status;
  final String route;
  final String? error;
}

/// Result of Tier 1-driven Tier 2 MCU installation returned by `POST /api/devices/mcu/install`.
class McuInstallResult {
  McuInstallResult.fromJson(Map<String, dynamic> json)
    : twin = DeviceTwin.fromJson(_map(json['twin'])),
      deployed = json['deployed'] == true,
      deployMethod = _text(json['deployMethod']) ?? 'staged_manual',
      deployDetail = json['deployDetail'] as String? ?? '',
      workspaceDir = json['workspaceDir'] as String? ?? '',
      configHeader = json['configHeader'] as String? ?? '',
      installScript = json['installScript'] as String? ?? '',
      mcuE2eKeyHex = json['mcuE2eKeyHex'] as String? ?? '';

  final DeviceTwin twin;
  final bool deployed;

  /// `tier1_rpc` or `staged_manual`.
  final String deployMethod;
  final String deployDetail;
  final String workspaceDir;
  final String configHeader;
  final String installScript;
  final String mcuE2eKeyHex;
}
