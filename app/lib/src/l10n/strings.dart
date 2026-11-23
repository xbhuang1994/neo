/// The app's words, in Chinese and in English. Written by hand: an abstract class, one subclass per language, and no
/// generated code.
library;

import 'package:flutter/widgets.dart';

/// Every text the app shows.
abstract class Strings {
  const Strings();

  /// The words for a locale: Chinese for any Chinese locale, English otherwise.
  static Strings of(Locale locale) => locale.languageCode == 'zh' ? const ZhStrings() : const EnStrings();

  /// The words of the nearest [StringsScope].
  static Strings read(BuildContext context) => context.dependOnInheritedWidgetOfExactType<StringsScope>()?.strings ?? const ZhStrings();

  String get appName => 'Neo';

  // Navigation
  String get chat;
  String get workers;
  String get settings;

  // Connection
  String get online;
  String get offline;
  String get connecting;
  String get startingBackend;
  String get backendFailed;
  String get alreadyRunning;
  String get alreadyRunningHint;
  String get tokenNeeded;
  String get retry;
  String get paused;

  // Activity ticker
  String get routerThinking;

  // Chat
  String get chatEmptyTitle;
  String get chatEmptyHint;
  String get you;
  String get messagePlaceholder;
  String get send;
  String get attach;
  String get sendShortcut;
  String get expand;
  String get collapse;
  String get resetConversation;
  String get resetConfirmTitle;
  String get resetConfirmBody;
  String get reset;
  String get cancel;
  String get ok;
  String get viaWeChat;
  String tooManyFiles(int most);
  String fileTooLarge(String name, int megabytes);
  String textTooLong(int most);
  String get sendFailed;
  String get kernelMissing;

  // Workers
  String get workersEmpty;
  String workersSummary(int active, int total);
  String get selectWorker;
  String get statusRunning;
  String get statusBackground;
  String get statusCompleted;
  String get statusEnded;
  String get statusDeliveryFailed;
  String get statusWaitingAnswer;
  String get statusReview;
  String get statusBlocked;
  String get statusFailed;
  String get statusIdle;
  String get statusQueued;
  String get statusWorking;
  String get ticket;
  String get session;
  String get sessionRunning;
  String get sessionLoaded;
  String get sessionUnloaded;
  String get assignment;
  String get none;
  String get pendingInputs;
  String get backgroundJobs;
  String get directory;
  String get needsAttention;
  String get latestReport;
  String get recentActivity;
  String get noActivity;
  String get subagent;
  String get shell;
  String pendingCount(int count);
  String get inputsDelivered;
  String backgroundCount(int count);
  String runningFor(Duration elapsed);
  String get notStarted;
  String get stopWorker;
  String get stoppingWorker;
  String get stopWorkerConfirmTitle;
  String get stopWorkerConfirmBody;
  String get stopWorkerConfirm;
  String get stopWorkerFailed;

  // Settings
  String get connection;
  String get thisComputer;
  String get remoteServer;
  String get serverAddress;
  String get accessToken;
  String get connect;
  String get connectionHintLocal;
  String get connectionHintRemote;
  String get connectionHintWeb;
  String get invalidAddress;
  String get kernelAndModels;
  String get kernel;
  String get kernelHintAntigravity;
  String get orchestratorModel;
  String get workerModel;
  String get listingModels;
  String get install;
  String get installing;
  String installed(String kernel);
  String get antigravitySignIn;
  String get followKernelDefault;
  String get current;
  String get save;
  String get saved;
  String get saving;
  String get general;
  String get pauseProcessing;
  String get pauseHint;
  String get recoveryMode;
  String get enableRecoveryMode;
  String get recoveryModeHint;
  String get maxWorkers;
  String get workDirectory;
  String workDirectoryHint(String fallback);
  String get prepareCommand;
  String get prepareHint;
  String get prepareShell;
  String get prepareShellHint;
  String get blockedCommands;
  String get blockedHint;
  String get proactive;
  String get proactiveMode;
  String get modeOff;
  String get modeObserve;
  String get modeAuto;
  String get proactiveHint;
  String get evalTimeout;
  String get seconds;
  String get rules;
  String get rulesHint;
  String get ruleName;
  String get ruleInstruction;
  String get addRule;
  String get removeRule;
  String get allowedSenders;
  String get allowedSendersHint;
  String get thisApp;
  String get wechat;
  String get wechatConnect;
  String get wechatDisconnect;
  String get wechatNewCode;
  String get wechatVerifyPlaceholder;
  String get wechatSubmitCode;
  String get wechatScanHint;
  String get wechatBoundAs;
  String get wechatStateDisconnected;
  String get wechatStateWaiting;
  String get wechatStateScanned;
  String get wechatStateVerify;
  String get wechatStateConnected;
  String get wechatStateError;
  String get about;
  String get version;
  String get components;
  String get loading;
  String get loadFailed;

  /// A worker report's or assignment's state, in words.
  String reportState(String state);

  /// A component's name, in words.
  String component(String name);

  // Account
  String get antigravityAccount;
  String get accountsFooter;
  String get notLoggedIn;
  String get logIn;
  String get logOut;
  String get loginRunning;
  String get loginDone;
  String get loginFailed;
  String get pasteCode;
  String get submit;
  String get copyLink;
  String get copied;
  String get notInstalledShort;
  String get loggedOut;
}

/// Gives the widgets below it their words.
class StringsScope extends InheritedWidget {
  const StringsScope({super.key, required this.strings, required super.child});

  final Strings strings;

  @override
  bool updateShouldNotify(StringsScope oldWidget) => oldWidget.strings.runtimeType != strings.runtimeType;
}

/// Chinese, the default.
class ZhStrings extends Strings {
  const ZhStrings();

  @override
  String get chat => '对话';
  @override
  String get workers => '任务';
  @override
  String get settings => '设置';

  @override
  String get online => '已连接';
  @override
  String get offline => '连接失败';
  @override
  String get connecting => '正在连接…';
  @override
  String get startingBackend => '正在启动本机服务…';
  @override
  String get backendFailed => '本机服务无法启动';
  @override
  String get alreadyRunning => 'Neo 已在运行';
  @override
  String get alreadyRunningHint => '同一台电脑只能运行一个 Neo。请切换到已打开的窗口，或先退出正在运行的服务。';
  @override
  String get tokenNeeded => '需要访问令牌';
  @override
  String get retry => '重试';
  @override
  String get paused => '已暂停';
  @override
  String get routerThinking => 'router 正在思考中…';

  @override
  String get chatEmptyTitle => '开始对话';
  @override
  String get chatEmptyHint => '说出要做的事，Neo 会建立任务并交给 Worker 完成。';
  @override
  String get you => '你';
  @override
  String get messagePlaceholder => '输入消息…';
  @override
  String get send => '发送';
  @override
  String get attach => '添加附件';
  @override
  String get sendShortcut => '⌘/Ctrl + Enter 发送';
  @override
  String get expand => '展开全部';
  @override
  String get collapse => '收起';
  @override
  String get resetConversation => '重置会话';
  @override
  String get resetConfirmTitle => '重置会话？';
  @override
  String get resetConfirmBody => '对话记录与模型上下文将被清空；任务、Worker 和微信绑定保留。';
  @override
  String get reset => '重置';
  @override
  String get cancel => '取消';
  @override
  String get ok => '好';
  @override
  String get viaWeChat => '微信';
  @override
  String tooManyFiles(int most) => '最多添加 $most 个附件';
  @override
  String fileTooLarge(String name, int megabytes) => '$name 超过 $megabytes MiB';
  @override
  String textTooLong(int most) => '消息不能超过 $most 字';
  @override
  String get sendFailed => '发送失败';
  @override
  String get kernelMissing => '执行内核不可用';

  @override
  String get workersEmpty => '暂无任务。对话中的明确请求被接受后会显示在这里。';
  @override
  String workersSummary(int active, int total) => '$active 个进行中 · 共 $total 个';
  @override
  String get selectWorker => '选择一个任务查看详情';
  @override
  String get statusRunning => '正在执行';
  @override
  String get statusBackground => '后台运行';
  @override
  String get statusCompleted => '已完成';
  @override
  String get statusEnded => '已结束';
  @override
  String get statusDeliveryFailed => '投递失败';
  @override
  String get statusWaitingAnswer => '等待回复';
  @override
  String get statusReview => '待确认结果';
  @override
  String get statusBlocked => '已阻塞';
  @override
  String get statusFailed => '执行失败';
  @override
  String get statusIdle => '空闲';
  @override
  String get statusQueued => '排队等待';
  @override
  String get statusWorking => '工作中';
  @override
  String get ticket => '任务 ID';
  @override
  String get session => '会话';
  @override
  String get sessionRunning => '正在执行';
  @override
  String get sessionLoaded => '已加载，空闲';
  @override
  String get sessionUnloaded => '未加载';
  @override
  String get assignment => '指派';
  @override
  String get none => '无';
  @override
  String get pendingInputs => '待投递输入';
  @override
  String get backgroundJobs => '后台任务';
  @override
  String get directory => '工作目录';
  @override
  String get needsAttention => '需要关注';
  @override
  String get latestReport => '最新报告';
  @override
  String get recentActivity => '最近活动';
  @override
  String get noActivity => '暂无记录。';
  @override
  String get subagent => '子代理';
  @override
  String get shell => 'Shell';
  @override
  String pendingCount(int count) => '$count 条待投递';
  @override
  String get inputsDelivered => '输入已投递';
  @override
  String backgroundCount(int count) => '$count 个后台任务';
  @override
  String runningFor(Duration elapsed) => elapsed.inMinutes < 1 ? '刚开始' : elapsed.inHours < 1 ? '已运行 ${elapsed.inMinutes} 分钟' : '已运行 ${elapsed.inHours} 小时 ${elapsed.inMinutes % 60} 分钟';
  @override
  String get notStarted => '未启动';
  @override
  String get stopWorker => '终止任务';
  @override
  String get stoppingWorker => '正在终止…';
  @override
  String get stopWorkerConfirmTitle => '终止任务？';
  @override
  String get stopWorkerConfirmBody => '将立即终止该任务及其所有子任务和后台进程，并将任务标记为「已结束」。';
  @override
  String get stopWorkerConfirm => '终止';
  @override
  String get stopWorkerFailed => '终止失败';

  @override
  String get connection => '连接';
  @override
  String get thisComputer => '本机';
  @override
  String get remoteServer => '远程服务器';
  @override
  String get serverAddress => '服务器地址';
  @override
  String get accessToken => '访问令牌';
  @override
  String get connect => '连接';
  @override
  String get connectionHintLocal => '使用随应用启动的本机服务，数据保存在这台电脑上。';
  @override
  String get connectionHintRemote => '连接到以服务器模式部署的 Neo。非本机地址需要访问令牌。';
  @override
  String get connectionHintWeb => '此页面由服务器提供。服务器设置了访问令牌时，请在这里填写。';
  @override
  String get invalidAddress => '地址应形如 http://主机:端口';
  @override
  String get kernelAndModels => '内核与模型';
  @override
  String get kernel => '执行内核';
  @override
  String get kernelHintAntigravity => '运行 Antigravity CLI（agy）：使用它已登录的 Google 账号与 agy models 列出的模型；后台任务与子代理结束时会唤醒 worker，但不能单独取消。';
  @override
  String get orchestratorModel => '评估与调度模型';
  @override
  String get workerModel => 'Worker 模型';
  @override
  String get listingModels => '正在读取模型列表…';
  @override
  String get install => '安装';
  @override
  String get installing => '正在安装…';
  @override
  String installed(String kernel) => '$kernel 已安装';
  @override
  String get antigravitySignIn => '首次使用前，在终端运行一次 agy 登录 Google 账号。';
  @override
  String get followKernelDefault => '跟随内核默认';
  @override
  String get current => '当前';
  @override
  String get save => '保存';
  @override
  String get saved => '已保存';
  @override
  String get saving => '正在保存…';
  @override
  String get general => '通用';
  @override
  String get pauseProcessing => '暂停处理';
  @override
  String get pauseHint => '暂停后不评估、不启动任务、不发送回复；消息照常接收。';
  @override
  String get recoveryMode => '自动恢复';
  @override
  String get enableRecoveryMode => '开启恢复模式';
  @override
  String get recoveryModeHint => '开启后，独立守护进程在检测到 Neo 长时间不可用时会自动调用后端 Worker 修复并重启；关闭后不自动触发修复。';
  @override
  String get maxWorkers => '同时运行的 Worker';
  @override
  String get workDirectory => '任务目录';
  @override
  String workDirectoryHint(String fallback) => '每个任务在此目录下有自己的文件夹。留空使用 $fallback';
  @override
  String get prepareCommand => '准备命令';
  @override
  String get prepareHint => '任务文件夹建立前在任务目录中运行，例如克隆仓库到 \$NEO_AGENT_DIR。';
  @override
  String get prepareShell => '准备命令的 Shell';
  @override
  String get prepareShellHint => '留空使用系统默认（sh 或 cmd.exe）';
  @override
  String get blockedCommands => '屏蔽的命令';
  @override
  String get blockedHint => 'Worker 不得运行的命令名，用空格分隔，例如 docker shutdown';
  @override
  String get proactive => '主动评估';
  @override
  String get proactiveMode => '模式';
  @override
  String get modeOff => '关闭';
  @override
  String get modeObserve => '仅观察';
  @override
  String get modeAuto => '自动受理';
  @override
  String get proactiveHint => '对非直接请求的消息：关闭则忽略，仅观察只记录判断，自动受理按规则建立任务。';
  @override
  String get evalTimeout => '评估时限';
  @override
  String get seconds => '秒';
  @override
  String get rules => '规则';
  @override
  String get rulesHint => '规则描述哪些事情可以主动受理。';
  @override
  String get ruleName => '名称';
  @override
  String get ruleInstruction => '说明';
  @override
  String get addRule => '添加规则';
  @override
  String get removeRule => '删除';
  @override
  String get allowedSenders => '允许的发送者';
  @override
  String get allowedSendersHint => '绑定微信后，其账号自动加入；解除绑定时移除。';
  @override
  String get thisApp => '本应用';
  @override
  String get wechat => '微信';
  @override
  String get wechatConnect => '连接微信';
  @override
  String get wechatDisconnect => '断开';
  @override
  String get wechatNewCode => '重新获取二维码';
  @override
  String get wechatVerifyPlaceholder => '验证码';
  @override
  String get wechatSubmitCode => '提交';
  @override
  String get wechatScanHint => '用微信扫一扫，并在手机上确认。';
  @override
  String get wechatBoundAs => '绑定账号';
  @override
  String get wechatStateDisconnected => '未连接';
  @override
  String get wechatStateWaiting => '等待扫码';
  @override
  String get wechatStateScanned => '已扫码';
  @override
  String get wechatStateVerify => '需要验证码';
  @override
  String get wechatStateConnected => '已连接';
  @override
  String get wechatStateError => '出错';
  @override
  String get about => '关于';
  @override
  String get version => '版本';
  @override
  String get components => '运行状态';
  @override
  String get loading => '正在加载…';
  @override
  String get loadFailed => '加载失败';

  @override
  String reportState(String state) => switch (state) {
    'progress' => '进行中',
    'waiting' => '等待中',
    'ready' => '已就绪',
    'blocked' => '已阻塞',
    'failed' => '失败',
    'dropped' => '已交回',
    'pending' => '待启动',
    'running' => '运行中',
    'ended' => '已结束',
    _ => state,
  };

  @override
  String component(String name) => switch (name) {
    'runtime' => '运行时',
    'kernel' => '执行内核',
    'watchdog' => '看护',
    'environment' => '执行环境',
    'effects' => '任务队列',
    'passes' => '调度',
    'wechat' => '微信',
    _ => name,
  };

  // Account
  @override
  String get antigravityAccount => 'Antigravity 账号';
  @override
  String get accountsFooter => '登录在后端所在机器上进行：打开链接完成授权，再把页面给出的代码粘贴回来；若浏览器跳到 localhost 打不开，把地址栏的完整网址粘贴回来即可。';
  @override
  String get notLoggedIn => '未登录';
  @override
  String get logIn => '登录';
  @override
  String get logOut => '登出';
  @override
  String get loginRunning => '正在登录 Antigravity';
  @override
  String get loginDone => '登录成功';
  @override
  String get loginFailed => '登录失败';
  @override
  String get pasteCode => '粘贴代码或跳转后的网址';
  @override
  String get submit => '提交';
  @override
  String get copyLink => '复制链接';
  @override
  String get copied => '已复制';
  @override
  String get notInstalledShort => '未安装';
  @override
  String get loggedOut => '已登出';
}

/// English.
class EnStrings extends Strings {
  const EnStrings();

  @override
  String get chat => 'Chat';
  @override
  String get workers => 'Tasks';
  @override
  String get settings => 'Settings';

  @override
  String get online => 'Connected';
  @override
  String get offline => 'Not connected';
  @override
  String get connecting => 'Connecting…';
  @override
  String get startingBackend => 'Starting the local service…';
  @override
  String get backendFailed => 'The local service could not start';
  @override
  String get alreadyRunning => 'Neo is already running';
  @override
  String get alreadyRunningHint => 'Only one Neo runs on a computer. Switch to the window that is open, or quit the running service first.';
  @override
  String get tokenNeeded => 'An access token is needed';
  @override
  String get retry => 'Retry';
  @override
  String get paused => 'Paused';
  @override
  String get routerThinking => 'Router is thinking…';

  @override
  String get chatEmptyTitle => 'Start a conversation';
  @override
  String get chatEmptyHint => 'Say what needs doing. Neo opens a task and hands it to a worker.';
  @override
  String get you => 'You';
  @override
  String get messagePlaceholder => 'Message…';
  @override
  String get send => 'Send';
  @override
  String get attach => 'Attach files';
  @override
  String get sendShortcut => '⌘/Ctrl + Enter to send';
  @override
  String get expand => 'Show all';
  @override
  String get collapse => 'Show less';
  @override
  String get resetConversation => 'Reset conversation';
  @override
  String get resetConfirmTitle => 'Reset the conversation?';
  @override
  String get resetConfirmBody => 'The transcript and the model\'s context are cleared. Tasks, workers and the WeChat binding stay.';
  @override
  String get reset => 'Reset';
  @override
  String get cancel => 'Cancel';
  @override
  String get ok => 'OK';
  @override
  String get viaWeChat => 'WeChat';
  @override
  String tooManyFiles(int most) => 'At most $most attachments';
  @override
  String fileTooLarge(String name, int megabytes) => '$name is larger than $megabytes MiB';
  @override
  String textTooLong(int most) => 'A message has at most $most characters';
  @override
  String get sendFailed => 'Could not send';
  @override
  String get kernelMissing => 'The kernel cannot run';

  @override
  String get workersEmpty => 'No tasks yet. A request accepted in the conversation shows here.';
  @override
  String workersSummary(int active, int total) => '$active active · $total in all';
  @override
  String get selectWorker => 'Select a task to see its details';
  @override
  String get statusRunning => 'Running';
  @override
  String get statusBackground => 'In background';
  @override
  String get statusCompleted => 'Completed';
  @override
  String get statusEnded => 'Ended';
  @override
  String get statusDeliveryFailed => 'Delivery failed';
  @override
  String get statusWaitingAnswer => 'Waiting for an answer';
  @override
  String get statusReview => 'Ready for review';
  @override
  String get statusBlocked => 'Blocked';
  @override
  String get statusFailed => 'Failed';
  @override
  String get statusIdle => 'Idle';
  @override
  String get statusQueued => 'Queued';
  @override
  String get statusWorking => 'Working';
  @override
  String get ticket => 'Task ID';
  @override
  String get session => 'Session';
  @override
  String get sessionRunning => 'Running';
  @override
  String get sessionLoaded => 'Loaded, idle';
  @override
  String get sessionUnloaded => 'Not loaded';
  @override
  String get assignment => 'Assignment';
  @override
  String get none => 'None';
  @override
  String get pendingInputs => 'Inputs waiting';
  @override
  String get backgroundJobs => 'Background jobs';
  @override
  String get directory => 'Directory';
  @override
  String get needsAttention => 'Needs attention';
  @override
  String get latestReport => 'Latest report';
  @override
  String get recentActivity => 'Recent activity';
  @override
  String get noActivity => 'Nothing yet.';
  @override
  String get subagent => 'Subagent';
  @override
  String get shell => 'Shell';
  @override
  String pendingCount(int count) => '$count waiting';
  @override
  String get inputsDelivered => 'Inputs delivered';
  @override
  String backgroundCount(int count) => '$count in background';
  @override
  String runningFor(Duration elapsed) => elapsed.inMinutes < 1 ? 'just started' : elapsed.inHours < 1 ? 'running ${elapsed.inMinutes} min' : 'running ${elapsed.inHours} h ${elapsed.inMinutes % 60} min';
  @override
  String get notStarted => 'Not started';
  @override
  String get stopWorker => 'Stop task';
  @override
  String get stoppingWorker => 'Stopping…';
  @override
  String get stopWorkerConfirmTitle => 'Stop this task?';
  @override
  String get stopWorkerConfirmBody => 'This stops the task together with all its subagents and background jobs, and marks it as ended.';
  @override
  String get stopWorkerConfirm => 'Stop';
  @override
  String get stopWorkerFailed => 'Could not stop the task';

  @override
  String get connection => 'Connection';
  @override
  String get thisComputer => 'This computer';
  @override
  String get remoteServer => 'Remote server';
  @override
  String get serverAddress => 'Server address';
  @override
  String get accessToken => 'Access token';
  @override
  String get connect => 'Connect';
  @override
  String get connectionHintLocal => 'Uses the service that starts with the app. Data stays on this computer.';
  @override
  String get connectionHintRemote => 'Connects to a Neo deployed as a server. An address on another machine needs an access token.';
  @override
  String get connectionHintWeb => 'This page is served by the server. Enter the access token here if the server has one.';
  @override
  String get invalidAddress => 'An address looks like http://host:port';
  @override
  String get kernelAndModels => 'Kernel and models';
  @override
  String get kernel => 'Kernel';
  @override
  String get kernelHintAntigravity => 'Runs the Antigravity CLI (agy): it uses the Google account agy is signed in to and the models agy models lists; background jobs and subagents wake the worker when they end but cannot be cancelled one by one.';
  @override
  String get orchestratorModel => 'Assessment and routing model';
  @override
  String get workerModel => 'Worker model';
  @override
  String get listingModels => 'Listing models…';
  @override
  String get install => 'Install';
  @override
  String get installing => 'Installing…';
  @override
  String installed(String kernel) => '$kernel is installed';
  @override
  String get antigravitySignIn => 'Before first use, run agy once in a terminal to sign in with Google.';
  @override
  String get followKernelDefault => 'Kernel default';
  @override
  String get current => 'current';
  @override
  String get save => 'Save';
  @override
  String get saved => 'Saved';
  @override
  String get saving => 'Saving…';
  @override
  String get general => 'General';
  @override
  String get pauseProcessing => 'Pause processing';
  @override
  String get pauseHint => 'While paused nothing is assessed, started or sent; messages are still received.';
  @override
  String get recoveryMode => 'Recovery mode';
  @override
  String get enableRecoveryMode => 'Enable recovery mode';
  @override
  String get recoveryModeHint => 'When enabled, the independent recovery daemon invokes the configured worker to repair and restart Neo after prolonged downtime; when off, automatic repair is skipped.';
  @override
  String get maxWorkers => 'Workers at once';
  @override
  String get workDirectory => 'Task directory';
  @override
  String workDirectoryHint(String fallback) => 'Each task gets its own folder here. Empty uses $fallback';
  @override
  String get prepareCommand => 'Prepare command';
  @override
  String get prepareHint => 'Runs in the task directory before a task\'s folder exists, for example to clone a repository into \$NEO_AGENT_DIR.';
  @override
  String get prepareShell => 'Shell for the prepare command';
  @override
  String get prepareShellHint => 'Empty uses the system\'s (sh or cmd.exe)';
  @override
  String get blockedCommands => 'Blocked commands';
  @override
  String get blockedHint => 'Command names workers must not run, separated by spaces, such as docker shutdown';
  @override
  String get proactive => 'Proactive assessment';
  @override
  String get proactiveMode => 'Mode';
  @override
  String get modeOff => 'Off';
  @override
  String get modeObserve => 'Observe';
  @override
  String get modeAuto => 'Accept';
  @override
  String get proactiveHint => 'For messages that are not direct requests: off ignores them, observe records a judgement, accept opens tasks by the rules.';
  @override
  String get evalTimeout => 'Assessment time limit';
  @override
  String get seconds => 's';
  @override
  String get rules => 'Rules';
  @override
  String get rulesHint => 'Rules say what may be taken up proactively.';
  @override
  String get ruleName => 'Name';
  @override
  String get ruleInstruction => 'Instruction';
  @override
  String get addRule => 'Add a rule';
  @override
  String get removeRule => 'Remove';
  @override
  String get allowedSenders => 'Allowed senders';
  @override
  String get allowedSendersHint => 'A bound WeChat account is added by itself, and removed when it is unbound.';
  @override
  String get thisApp => 'This app';
  @override
  String get wechat => 'WeChat';
  @override
  String get wechatConnect => 'Connect WeChat';
  @override
  String get wechatDisconnect => 'Disconnect';
  @override
  String get wechatNewCode => 'New QR code';
  @override
  String get wechatVerifyPlaceholder => 'Code';
  @override
  String get wechatSubmitCode => 'Submit';
  @override
  String get wechatScanHint => 'Scan with WeChat and confirm on the phone.';
  @override
  String get wechatBoundAs => 'Bound account';
  @override
  String get wechatStateDisconnected => 'Not connected';
  @override
  String get wechatStateWaiting => 'Waiting for the scan';
  @override
  String get wechatStateScanned => 'Scanned';
  @override
  String get wechatStateVerify => 'Code needed';
  @override
  String get wechatStateConnected => 'Connected';
  @override
  String get wechatStateError => 'Error';
  @override
  String get about => 'About';
  @override
  String get version => 'Version';
  @override
  String get components => 'Status';
  @override
  String get loading => 'Loading…';
  @override
  String get loadFailed => 'Could not load';

  @override
  String reportState(String state) => switch (state) {
    'progress' => 'in progress',
    'waiting' => 'waiting',
    'ready' => 'ready',
    'blocked' => 'blocked',
    'failed' => 'failed',
    'dropped' => 'handed back',
    'pending' => 'pending',
    'running' => 'running',
    'ended' => 'ended',
    _ => state,
  };

  @override
  String component(String name) => switch (name) {
    'runtime' => 'Runtime',
    'kernel' => 'Kernel',
    'watchdog' => 'Watchdog',
    'environment' => 'Environment',
    'effects' => 'Queue',
    'passes' => 'Routing',
    'wechat' => 'WeChat',
    _ => name,
  };

  // Account
  @override
  String get antigravityAccount => 'Antigravity account';
  @override
  String get accountsFooter => 'Logging in runs on the backend\'s machine: open the link, authorize, and paste back the code the page shows. If the browser lands on a localhost address that does not open, paste that whole address.';
  @override
  String get notLoggedIn => 'Not logged in';
  @override
  String get logIn => 'Log in';
  @override
  String get logOut => 'Log out';
  @override
  String get loginRunning => 'Logging in to Antigravity';
  @override
  String get loginDone => 'Logged in';
  @override
  String get loginFailed => 'Login failed';
  @override
  String get pasteCode => 'Paste the code or the address you landed on';
  @override
  String get submit => 'Submit';
  @override
  String get copyLink => 'Copy link';
  @override
  String get copied => 'Copied';
  @override
  String get notInstalledShort => 'Not installed';
  @override
  String get loggedOut => 'Logged out';
}
