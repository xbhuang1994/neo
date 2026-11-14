/// Settings: how the app connects, the kernel and its models, the general settings, WeChat, and what runs.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../qr/qr_view.dart';
import '../state/app_state.dart';
import 'scope.dart';
import 'theme.dart';
import 'widgets.dart';

/// A titled group of rows on a rounded card, with an optional explanation below it.
class Group extends StatelessWidget {
  const Group({super.key, this.title, this.footer, required this.children});

  final String? title;
  final String? footer;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: grid * 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) Padding(padding: const EdgeInsets.only(left: 14, bottom: 7), child: Text(title!.toUpperCase(), style: typo.section.copyWith(fontSize: 12, letterSpacing: 0.3))),
          Container(
            decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(radius)),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (final (index, child) in children.indexed) ...[
                  if (index > 0) Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
                  child,
                ],
              ],
            ),
          ),
          if (footer != null) Padding(padding: const EdgeInsets.fromLTRB(14, 7, 14, 0), child: Text(footer!, style: typo.footnote.copyWith(fontSize: 12))),
        ],
      ),
    );
  }
}

/// A row of a group: a label, and a control at its end or below it.
class Field extends StatelessWidget {
  const Field({super.key, required this.label, this.trailing, this.below, this.onTap});

  final String label;
  final Widget? trailing;
  final Widget? below;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final typo = Typo.of(context);
    final row = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 24),
            child: Row(
              children: [
                Flexible(flex: 2, child: Text(label, style: typo.body)),
                const SizedBox(width: grid * 1.5),
                if (trailing != null) Expanded(flex: 3, child: Align(alignment: Alignment.centerRight, child: trailing!)) else const Spacer(),
              ],
            ),
          ),
          if (below != null) ...[const SizedBox(height: 8), below!],
        ],
      ),
    );
    return onTap == null ? row : Tappable(onTap: onTap, borderRadius: 0, child: row);
  }
}

/// A single-line or multi-line text box in the settings' style.
class Box extends StatelessWidget {
  const Box({super.key, required this.controller, this.placeholder, this.lines = 1, this.obscure = false, this.mono = false, this.onChanged, this.keyboard});

  final TextEditingController controller;
  final String? placeholder;
  final int lines;
  final bool obscure;
  final bool mono;
  final ValueChanged<String>? onChanged;
  final TextInputType? keyboard;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return CupertinoTextField(
      controller: controller,
      placeholder: placeholder,
      minLines: lines == 1 ? null : 2,
      maxLines: obscure ? 1 : lines,
      obscureText: obscure,
      autocorrect: false,
      enableSuggestions: false,
      keyboardType: keyboard,
      onChanged: onChanged,
      style: mono ? typo.mono.copyWith(color: palette.label, fontSize: 13) : typo.body,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(8)),
    );
  }
}

/// A whole number with a button to either side.
class Stepper extends StatelessWidget {
  const Stepper({super.key, required this.value, required this.min, required this.max, required this.onChanged, this.step = 1, this.unit = ''});

  final int value;
  final int min;
  final int max;
  final int step;
  final String unit;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    Widget button(IconData icon, int next, String label) => Tappable(
      tooltip: label,
      onTap: next < min || next > max ? null : () => onChanged(next),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      borderRadius: 7,
      child: Icon(icon, size: 15, color: palette.label),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('$value$unit', style: typo.body.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
        const SizedBox(width: 10),
        Container(
          decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(8)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [button(CupertinoIcons.minus, value - step, '−'), Container(width: 0.5, height: 16, color: palette.separator), button(CupertinoIcons.plus, value + step, '+')]),
        ),
      ],
    );
  }
}

/// Ask for one of a list of choices on a sheet. The choice comes back wrapped, so that a choice that is itself null
/// is told from a dismissed sheet, which answers null.
Future<(T,)?> pickOption<T>(BuildContext context, {required String title, required List<(T, String)> options, required T current}) {
  final strings = Strings.read(context);
  return showCupertinoModalPopup<(T,)>(
    context: context,
    builder: (sheet) {
      final palette = Palette.of(sheet);
      final typo = Typo.of(sheet);
      return Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: 460, maxHeight: MediaQuery.sizeOf(sheet).height * 0.7),
          child: Container(
            margin: const EdgeInsets.all(grid * 2),
            decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(14), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 30, offset: Offset(0, 10))]),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
                  child: Row(
                    children: [
                      Expanded(child: Text(title, style: typo.headline)),
                      CupertinoButton(padding: const EdgeInsets.symmetric(horizontal: 10), minimumSize: const Size(0, 30), onPressed: () => Navigator.of(sheet).pop(), child: Text(strings.cancel, style: typo.body.copyWith(color: palette.accent))),
                    ],
                  ),
                ),
                Container(height: 0.5, color: palette.separator),
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    itemCount: options.length,
                    itemBuilder: (context, index) {
                      final (value, label) = options[index];
                      return Tappable(
                        borderRadius: 0,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                        onTap: () => Navigator.of(sheet).pop((value,)),
                        child: Row(
                          children: [
                            Expanded(child: Text(label, style: typo.body, maxLines: 2, overflow: TextOverflow.ellipsis)),
                            if (value == current) Icon(CupertinoIcons.checkmark_alt, size: 18, color: palette.accent),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// The value of a choice row: what is chosen, and a mark that it opens a list.
class Choice extends StatelessWidget {
  const Choice(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(child: Text(text, style: Typo.of(context).body.copyWith(color: palette.secondary), maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.end)),
        const SizedBox(width: 4),
        Icon(CupertinoIcons.chevron_up_chevron_down, size: 13, color: palette.tertiary),
      ],
    );
  }
}

/// A filled button that shows a spinner while its action runs.
class ActionButton extends StatelessWidget {
  const ActionButton({super.key, required this.label, required this.onPressed, this.busy = false, this.destructive = false, this.plain = false});

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final bool destructive;
  final bool plain;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final color = destructive ? palette.red : palette.accent;
    final enabled = onPressed != null && !busy;
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      minimumSize: const Size(0, 34),
      borderRadius: BorderRadius.circular(8),
      color: plain ? palette.fill : color,
      disabledColor: palette.fill,
      onPressed: enabled ? onPressed : null,
      child: busy
          ? const CupertinoActivityIndicator(radius: 8)
          : Text(label, style: Typo.of(context).headline.copyWith(fontSize: 14, color: !enabled ? palette.tertiary : plain ? color : CupertinoColors.white)),
    );
  }
}

/// The settings page.
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final online = state.link == Link.online && state.client != null;
    return ColoredBox(
      color: palette.grouped,
      child: Column(
        children: [
          PageHeader(title: strings.settings, subtitle: const LinkPill()),
          Expanded(
            child: CupertinoScrollbar(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: grid * 2.5, vertical: grid * 3),
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 640),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const ConnectionSettings(),
                          if (online) ...[
                            // A new backend is new settings: each section starts over with its client.
                            ModelsSettings(key: ValueKey(('models', state.client)), api: state.client!),
                            GeneralSettingsSection(key: ValueKey(('general', state.client)), api: state.client!),
                            WeChatSettings(key: ValueKey(('wechat', state.client)), api: state.client!),
                            const AboutSection(),
                          ],
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// How the app reaches its backend.
class ConnectionSettings extends StatefulWidget {
  const ConnectionSettings({super.key});

  @override
  State<ConnectionSettings> createState() => _ConnectionSettingsState();
}

class _ConnectionSettingsState extends State<ConnectionSettings> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _token = TextEditingController();
  bool? _local;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_local == null) {
      final config = AppScope.of(context).config;
      _local = config.local;
      _url.text = config.url;
      _token.text = config.token;
    }
  }

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _apply() async {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    if (!_local! && state.host.isDesktop && parseServerAddress(_url.text) == null) {
      setState(() => _error = strings.invalidAddress);
      return;
    }
    setState(() => _error = null);
    await state.applyConnection(ConnectionConfig(local: _local! && state.host.isDesktop, url: state.host.isDesktop ? _url.text.trim() : state.config.url, token: _token.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final desktop = state.host.isDesktop;
    final local = _local! && desktop;
    return Group(
      title: strings.connection,
      footer: !desktop ? strings.connectionHintWeb : local ? strings.connectionHintLocal : strings.connectionHintRemote,
      children: [
        if (desktop)
          Padding(
            padding: const EdgeInsets.all(12),
            child: SizedBox(
              width: double.infinity,
              child: CupertinoSlidingSegmentedControl<bool>(
                groupValue: local,
                children: {true: Text(strings.thisComputer), false: Text(strings.remoteServer)},
                onValueChanged: (value) {
                  setState(() => _local = value ?? true);
                  if (value == true) unawaited(_apply());
                },
              ),
            ),
          ),
        if (desktop && !local) Field(label: strings.serverAddress, below: Box(controller: _url, placeholder: 'http://192.168.1.10:3082', keyboard: TextInputType.url)),
        if (!local) Field(label: strings.accessToken, below: Box(controller: _token, obscure: true)),
        if (!local)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                if (_error != null) Expanded(child: Text(_error!, style: Typo.of(context).footnote.copyWith(color: Palette.of(context).red))) else const Spacer(),
                ActionButton(label: strings.connect, onPressed: () => unawaited(_apply())),
              ],
            ),
          ),
      ],
    );
  }
}

/// Loads something from the backend when shown, and shows a spinner or what went wrong meanwhile.
abstract class LoadingState<W extends StatefulWidget, T> extends State<W> {
  T? data;
  String? loadError;
  String? notice;
  bool noticeGood = false;
  bool busy = false;

  Future<T> load();

  @override
  void initState() {
    super.initState();
    unawaited(reload());
  }

  Future<void> reload() async {
    try {
      final loaded = await load();
      if (mounted) {
        setState(() {
          data = loaded;
          loadError = null;
        });
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => loadError = error.message);
    }
  }

  /// Run a change, show its outcome, and keep what the backend answered.
  Future<void> run(Future<T> Function() change, {String? done}) async {
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      final changed = await change();
      if (!mounted) return;
      setState(() {
        data = changed;
        notice = done;
        noticeGood = true;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        notice = error.message;
        noticeGood = false;
      });
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget placeholder(BuildContext context, String title) {
    final strings = Strings.read(context);
    return Group(
      title: title,
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: loadError == null
              ? Row(children: [const CupertinoActivityIndicator(radius: 8), const SizedBox(width: 10), Text(strings.loading, style: Typo.of(context).footnote)])
              : Row(
                  children: [
                    Expanded(child: Text('${strings.loadFailed}: $loadError', style: Typo.of(context).footnote.copyWith(color: Palette.of(context).red))),
                    ActionButton(label: strings.retry, plain: true, onPressed: () => unawaited(reload())),
                  ],
                ),
        ),
      ],
    );
  }
}

/// The kernel, and the model of each role.
class ModelsSettings extends StatefulWidget {
  const ModelsSettings({super.key, required this.api});

  final ApiClient api;

  @override
  State<ModelsSettings> createState() => _ModelsSettingsState();
}

class _ModelsSettingsState extends LoadingState<ModelsSettings, ModelSettings> {
  RoleModel? _eval;
  RoleModel? _executor;
  RoleModel? _advisor;

  @override
  Future<ModelSettings> load() async => _take(await widget.api.models());

  ModelSettings _take(ModelSettings settings) {
    _eval = settings.eval;
    _executor = settings.executor;
    _advisor = settings.advisor;
    return settings;
  }

  String _name(String kernel) => kernel == 'claude' ? 'Claude Code' : 'Oh My Pi';

  Future<void> _pickModel(String title, RoleModel? current, String fallback, ValueChanged<RoleModel?> set) async {
    final settings = data!;
    final strings = Strings.read(context);
    final known = settings.available.any((option) => option.provider == current?.provider && option.id == current?.model);
    final options = <(RoleModel?, String)>[
      (null, fallback),
      for (final option in settings.available) (RoleModel(option.provider, option.id, current?.thinkingLevel), '${option.name} · ${option.provider}/${option.id}'),
      if (current != null && !known) (current, '${current.provider}/${current.model} (${strings.current})'),
    ];
    final currentKey = current == null ? null : options.map((option) => option.$1).firstWhere((option) => option?.provider == current.provider && option?.model == current.model, orElse: () => current);
    final picked = await pickOption<RoleModel?>(context, title: title, options: options, current: currentKey);
    if (picked != null && mounted) setState(() => set(picked.$1));
  }

  Future<void> _pickThinking(RoleModel model, ValueChanged<RoleModel?> set) async {
    final strings = Strings.read(context);
    final levels = data!.thinkingLevels;
    final picked = await pickOption<String>(context, title: strings.thinking, options: [for (final level in levels) (level, level)], current: model.thinkingLevel ?? 'auto');
    if (picked != null && mounted) setState(() => set(model.withThinking(picked.$1 == 'auto' ? null : picked.$1)));
  }

  List<Widget> _role(String title, RoleModel? model, String fallback, ValueChanged<RoleModel?> set) {
    final strings = Strings.read(context);
    return [
      Field(
        key: ValueKey('model-$title'),
        label: title,
        trailing: Choice(model == null ? fallback : '${model.provider}/${model.model}'),
        onTap: busy ? null : () => unawaited(_pickModel(title, model, fallback, set)),
      ),
      if (model != null)
        Field(label: '  ${strings.thinking}', trailing: Choice(model.thinkingLevel ?? 'auto'), onTap: busy ? null : () => unawaited(_pickThinking(model, set))),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final settings = data;
    if (settings == null) return placeholder(context, strings.kernelAndModels);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final changed = _eval != settings.eval || _executor != settings.executor || _advisor != settings.advisor;
    final problems = [for (final kernel in settings.kernels) if (kernel.problem != null) '${_name(kernel.id)}: ${kernel.problem}'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Group(
          title: strings.kernelAndModels,
          footer: '${settings.kernel == 'claude' ? strings.kernelHintClaude : strings.kernelHintOmp} ${strings.kernelSwitchHint}',
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  CupertinoSlidingSegmentedControl<String>(
                    groupValue: settings.kernel,
                    children: {for (final kernel in const ['omp', 'claude']) kernel: Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text(_name(kernel)))},
                    onValueChanged: (kernel) {
                      if (kernel == null || kernel == settings.kernel || busy) return;
                      unawaited(run(() async => _take(await widget.api.setKernel(kernel)), done: _name(kernel)));
                    },
                  ),
                  for (final problem in problems) Padding(padding: const EdgeInsets.only(top: 8), child: Text(problem, style: typo.footnote.copyWith(color: palette.orange))),
                  if (settings.problem != null && problems.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(settings.problem!, style: typo.footnote.copyWith(color: palette.orange))),
                ],
              ),
            ),
            ..._role(strings.orchestratorModel, _eval, strings.followKernelDefault, (model) => _eval = model),
            ..._role(strings.workerModel, _executor, strings.followKernelDefault, (model) => _executor = model),
            if (settings.supportsAdvisor) ..._role(strings.advisorModel, _advisor, strings.off, (model) => _advisor = model),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(child: notice == null ? const SizedBox.shrink() : Text(notice!, style: typo.footnote.copyWith(color: noticeGood ? palette.green : palette.red))),
                  ActionButton(
                    label: strings.save,
                    busy: busy,
                    onPressed: changed ? () => unawaited(run(() async => _take(await widget.api.saveModels(eval: _eval, executor: _executor, advisor: _advisor)), done: strings.saved)) : null,
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// The pause, workers and their directories, proactive assessment and its rules, and who may write.
class GeneralSettingsSection extends StatefulWidget {
  const GeneralSettingsSection({super.key, required this.api});

  final ApiClient api;

  @override
  State<GeneralSettingsSection> createState() => _GeneralSettingsState();
}

class _GeneralSettingsState extends LoadingState<GeneralSettingsSection, GeneralSettings> {
  final TextEditingController _directory = TextEditingController();
  final TextEditingController _prepare = TextEditingController();
  final TextEditingController _shell = TextEditingController();
  final TextEditingController _blocked = TextEditingController();
  final Map<Rule, (TextEditingController, TextEditingController)> _rules = {};
  bool _dirty = false;

  @override
  Future<GeneralSettings> load() async => _take(await widget.api.general());

  GeneralSettings _take(GeneralSettings settings) {
    _directory.text = settings.directory;
    _prepare.text = settings.prepare;
    _shell.text = settings.prepareShell;
    _blocked.text = settings.blockedCommands.join(' ');
    for (final (name, instruction) in _rules.values) {
      name.dispose();
      instruction.dispose();
    }
    _rules
      ..clear()
      ..addEntries([for (final rule in settings.rules) MapEntry(rule, (TextEditingController(text: rule.name), TextEditingController(text: rule.instruction)))]);
    _dirty = false;
    return settings;
  }

  @override
  void dispose() {
    for (final controller in [_directory, _prepare, _shell, _blocked]) {
      controller.dispose();
    }
    for (final (name, instruction) in _rules.values) {
      name.dispose();
      instruction.dispose();
    }
    super.dispose();
  }

  void _edit(VoidCallback change) => setState(() {
    change();
    _dirty = true;
    notice = null;
  });

  Future<void> _save() async {
    final settings = data!;
    final strings = Strings.read(context);
    settings
      ..directory = _directory.text
      ..prepare = _prepare.text
      ..prepareShell = _shell.text
      ..blockedCommands = _blocked.text.split(RegExp(r'[\s,，、]+')).where((name) => name.isNotEmpty).toList();
    for (final MapEntry(key: rule, value: (name, instruction)) in _rules.entries) {
      rule
        ..name = name.text.trim()
        ..instruction = instruction.text.trim();
    }
    await run(() async => _take(await widget.api.saveGeneral({'eval': settings.evalJson(), 'executor': settings.executorJson(), 'policy': settings.policyJson()})), done: strings.saved);
  }

  void _addRule() {
    final settings = data!;
    var number = settings.rules.length + 1;
    while (settings.rules.any((rule) => rule.id == 'rule-$number')) {
      number++;
    }
    final rule = Rule(id: 'rule-$number', name: '', enabled: true, instruction: '');
    _edit(() {
      settings.rules.add(rule);
      _rules[rule] = (TextEditingController(), TextEditingController());
    });
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final settings = data;
    if (settings == null) return placeholder(context, strings.general);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    void typed(String _) {
      if (!_dirty) setState(() => _dirty = true);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Group(
          title: strings.general,
          footer: strings.pauseHint,
          children: [
            Field(
              label: strings.pauseProcessing,
              trailing: CupertinoSwitch(
                value: settings.paused,
                // The pause applies at once, by itself.
                onChanged: busy ? null : (paused) => unawaited(run(() async => _take(await widget.api.saveGeneral({'paused': paused})))),
              ),
            ),
            Field(
              label: strings.maxWorkers,
              trailing: Stepper(value: settings.maxWorkers, min: settings.maxWorkersRange.$1, max: settings.maxWorkersRange.$2, onChanged: (value) => _edit(() => settings.maxWorkers = value)),
            ),
          ],
        ),
        Group(
          title: strings.workDirectory,
          footer: strings.blockedHint,
          children: [
            Field(label: strings.workDirectory, below: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Box(controller: _directory, mono: true, onChanged: typed, placeholder: settings.defaultDirectory), const SizedBox(height: 6), Text(strings.workDirectoryHint(settings.defaultDirectory), style: typo.caption)])),
            Field(label: strings.prepareCommand, below: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Box(controller: _prepare, mono: true, lines: 4, onChanged: typed), const SizedBox(height: 6), Text(strings.prepareHint, style: typo.caption)])),
            Field(label: strings.prepareShell, below: Box(controller: _shell, mono: true, onChanged: typed, placeholder: strings.prepareShellHint)),
            Field(label: strings.blockedCommands, below: Box(controller: _blocked, mono: true, onChanged: typed, placeholder: 'docker shutdown')),
          ],
        ),
        Group(
          title: strings.proactive,
          footer: strings.proactiveHint,
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: SizedBox(
                width: double.infinity,
                child: CupertinoSlidingSegmentedControl<String>(
                  groupValue: settings.evalMode,
                  children: {'off': Text(strings.modeOff), 'observe': Text(strings.modeObserve), 'auto': Text(strings.modeAuto)},
                  onValueChanged: (mode) => _edit(() => settings.evalMode = mode ?? settings.evalMode),
                ),
              ),
            ),
            Field(
              label: strings.evalTimeout,
              trailing: Stepper(value: settings.evalTimeoutSeconds, min: settings.evalTimeoutRange.$1, max: settings.evalTimeoutRange.$2, step: 30, unit: ' ${strings.seconds}', onChanged: (value) => _edit(() => settings.evalTimeoutSeconds = value)),
            ),
          ],
        ),
        Group(
          title: strings.rules,
          footer: strings.rulesHint,
          children: [
            for (final rule in settings.rules)
              Padding(
                key: ValueKey('rule-${rule.id}'),
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(child: Box(controller: _rules[rule]!.$1, placeholder: strings.ruleName, onChanged: typed)),
                        const SizedBox(width: 10),
                        CupertinoSwitch(value: rule.enabled, onChanged: (enabled) => _edit(() => rule.enabled = enabled)),
                        const SizedBox(width: 4),
                        Tappable(
                          tooltip: strings.removeRule,
                          padding: const EdgeInsets.all(7),
                          onTap: () => _edit(() {
                            settings.rules.remove(rule);
                            final removed = _rules.remove(rule);
                            removed?.$1.dispose();
                            removed?.$2.dispose();
                          }),
                          child: Icon(CupertinoIcons.trash, size: 17, color: palette.red),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Box(controller: _rules[rule]!.$2, placeholder: strings.ruleInstruction, lines: 5, onChanged: typed),
                  ],
                ),
              ),
            Tappable(
              borderRadius: 0,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              onTap: _addRule,
              child: Row(children: [Icon(CupertinoIcons.add_circled, size: 18, color: palette.accent), const SizedBox(width: 8), Text(strings.addRule, style: typo.body.copyWith(color: palette.accent))]),
            ),
          ],
        ),
        Group(
          title: strings.allowedSenders,
          footer: strings.allowedSendersHint,
          children: [
            for (final sender in settings.chatSenders)
              Field(label: sender == 'web:local' ? strings.thisApp : strings.wechat, trailing: Text(sender, style: typo.mono.copyWith(color: palette.secondary), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: grid * 3),
          child: Row(
            children: [
              Expanded(child: notice == null ? const SizedBox.shrink() : Text(notice!, style: typo.footnote.copyWith(color: noticeGood ? palette.green : palette.red))),
              ActionButton(label: strings.save, busy: busy, onPressed: _dirty ? () => unawaited(_save()) : null),
            ],
          ),
        ),
      ],
    );
  }
}

/// The WeChat binding: its state, the QR code of a login, the verification code, and the buttons for each.
class WeChatSettings extends StatefulWidget {
  const WeChatSettings({super.key, required this.api});

  final ApiClient api;

  @override
  State<WeChatSettings> createState() => _WeChatSettingsState();
}

class _WeChatSettingsState extends LoadingState<WeChatSettings, WeChatStatus> {
  final TextEditingController _code = TextEditingController();
  Timer? _poll;

  @override
  Future<WeChatStatus> load() => widget.api.wechat();

  @override
  void initState() {
    super.initState();
    // A login moves on the phone: follow it while one is under way.
    _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) {
      if (data == null || data!.loggingIn) unawaited(reload());
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final status = data;
    if (status == null) return placeholder(context, strings.wechat);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final (label, color) = switch (status.state) {
      'connected' => (strings.wechatStateConnected, palette.green),
      'waiting' => (strings.wechatStateWaiting, palette.orange),
      'scaned' => (strings.wechatStateScanned, palette.orange),
      'verify' => (strings.wechatStateVerify, palette.orange),
      'error' => (strings.wechatStateError, palette.red),
      _ => (strings.wechatStateDisconnected, palette.gray),
    };
    return Group(
      title: strings.wechat,
      children: [
        Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [Pill(label, color: color, dot: true), const SizedBox(width: 10), Expanded(child: Text(status.message, style: typo.footnote))]),
              if (status.qrContent != null) ...[
                const SizedBox(height: 14),
                Center(
                  child: Column(
                    children: [
                      Container(
                        decoration: BoxDecoration(color: CupertinoColors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: palette.separator, width: 0.5)),
                        padding: const EdgeInsets.all(12),
                        child: QrView(status.qrContent!, size: 220),
                      ),
                      const SizedBox(height: 8),
                      Text(strings.wechatScanHint, style: typo.footnote),
                    ],
                  ),
                ),
              ],
              if (status.state == 'verify') ...[
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(child: Box(controller: _code, placeholder: strings.wechatVerifyPlaceholder, keyboard: TextInputType.number)),
                    const SizedBox(width: 10),
                    ActionButton(
                      label: strings.wechatSubmitCode,
                      busy: busy,
                      onPressed: () => unawaited(run(() async {
                        final next = await widget.api.wechatVerify(_code.text.trim());
                        _code.clear();
                        return next;
                      })),
                    ),
                  ],
                ),
              ],
              if (status.senderId != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text('${strings.wechatBoundAs}: ${status.senderId}', style: typo.mono.copyWith(color: palette.secondary))),
              if (notice != null && !noticeGood) Padding(padding: const EdgeInsets.only(top: 10), child: Notice(notice!)),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (status.senderId != null || status.loggingIn) ...[
                    ActionButton(label: strings.wechatDisconnect, plain: true, destructive: true, busy: busy, onPressed: () => unawaited(run(widget.api.wechatDisconnect))),
                    const SizedBox(width: 10),
                  ],
                  if (status.state != 'connected')
                    ActionButton(label: status.loggingIn || status.state == 'error' ? strings.wechatNewCode : strings.wechatConnect, busy: busy, onPressed: () => unawaited(run(widget.api.wechatConnect))),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The version, and how each part of the backend is doing.
class AboutSection extends StatelessWidget {
  const AboutSection({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final health = state.health;
    if (health == null) return const SizedBox.shrink();
    return Group(
      title: strings.about,
      children: [
        Field(label: strings.version, trailing: Text(health.version, style: typo.body.copyWith(color: palette.secondary))),
        for (final component in health.components)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6, right: 9),
                  child: Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: switch (component.state) { 'ready' => palette.green, 'error' => palette.red, _ => palette.orange })),
                ),
                SizedBox(width: 96, child: Text(strings.component(component.name), style: typo.body)),
                Expanded(child: Text(component.detail, style: typo.footnote, textAlign: TextAlign.end)),
              ],
            ),
          ),
      ],
    );
  }
}
