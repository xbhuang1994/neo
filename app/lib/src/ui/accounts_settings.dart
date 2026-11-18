/// Settings for the kernels' model access: the custom providers they share, and each kernel's accounts with logging
/// in and out.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets.dart';

const _kernels = ['omp', 'claude', 'antigravity', 'hermes'];

String kernelName(String kernel) => switch (kernel) {
  'claude' => 'Claude Code',
  'antigravity' => 'Antigravity',
  'hermes' => 'Hermes',
  _ => 'Oh My Pi',
};

/// Ask for a few lines of text on a dialog; null when cancelled.
Future<List<String>?> askText(BuildContext context, {required String title, required List<(String, bool)> fields}) {
  final strings = Strings.read(context);
  final controllers = [for (final _ in fields) TextEditingController()];
  return showCupertinoDialog<List<String>>(
    context: context,
    builder: (dialog) {
      final fonts = fallbackFonts(dialog);
      return CupertinoAlertDialog(
        title: Text(title, style: fonts),
        content: Column(
          children: [
            for (final (index, (placeholder, obscure)) in fields.indexed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: CupertinoTextField(
                  controller: controllers[index],
                  placeholder: placeholder,
                  obscureText: obscure,
                  autocorrect: false,
                  enableSuggestions: false,
                  autofocus: index == 0,
                ),
              ),
          ],
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.of(dialog).pop(), child: Text(strings.cancel, style: fonts)),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.of(dialog).pop([for (final controller in controllers) controller.text.trim()]),
            child: Text(strings.ok, style: fonts),
          ),
        ],
      );
    },
  ).whenComplete(() {
    for (final controller in controllers) {
      controller.dispose();
    }
  });
}

/// The custom providers the kernels share.
class ProvidersSettings extends StatefulWidget {
  const ProvidersSettings({super.key, required this.api});

  final ApiClient api;

  @override
  State<ProvidersSettings> createState() => _ProvidersSettingsState();
}

class _ProvidersSettingsState extends LoadingState<ProvidersSettings, ProvidersView> {
  @override
  Future<ProvidersView> load() => widget.api.providers();

  /// What goes back for a provider left as it is: everything the backend sent, and no key, so it keeps its own.
  List<Map<String, dynamic>> _unchanged({String? except}) => [
    for (final provider in data!.providers)
      if (provider.name != except) Map<String, dynamic>.of(provider.raw),
  ];

  Future<void> _edit(CustomProvider? provider) async {
    final strings = Strings.read(context);
    final edited = await showCupertinoModalPopup<_Edited>(
      context: context,
      builder: (_) => _ProviderEditor(view: data!, provider: provider),
    );
    if (edited == null || !mounted) return;
    final list = _unchanged(except: provider?.name);
    if (edited.provider != null) {
      final index = provider == null ? list.length : data!.providers.indexWhere((known) => known.name == provider.name);
      list.insert(index.clamp(0, list.length), edited.provider!);
    }
    await run(() => widget.api.saveProviders(list), done: strings.saved);
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final view = data;
    if (view == null) return placeholder(context, strings.customProviders);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Group(
      title: strings.customProviders,
      footer: strings.providersFooter,
      children: [
        if (view.providers.isEmpty)
          Padding(
            padding: const EdgeInsets.all(14),
            child: Text(strings.noProviders, style: typo.footnote),
          ),
        for (final provider in view.providers)
          Tappable(
            key: ValueKey('provider-${provider.name}'),
            borderRadius: 0,
            onTap: busy ? null : () => unawaited(_edit(provider)),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(provider.name, style: typo.headline),
                      Text('${provider.api} · ${provider.baseUrl}', style: typo.footnote, maxLines: 1, overflow: TextOverflow.ellipsis),
                      Text(
                        '${provider.models.length} ${strings.providerModels} · ${provider.kernels.isEmpty ? '—' : provider.kernels.map(kernelName).join(', ')}'
                        '${provider.keyHint == null ? '' : ' · ${strings.apiKey} ${provider.keyHint}'}',
                        style: typo.footnote.copyWith(color: palette.tertiary),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (provider.modelsProblem != null)
                        Text(provider.modelsProblem!, style: typo.footnote.copyWith(color: palette.orange), maxLines: 2, overflow: TextOverflow.ellipsis),
                    ],
                  ),
                ),
                Icon(CupertinoIcons.chevron_right, size: 14, color: palette.tertiary),
              ],
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: notice == null ? const SizedBox.shrink() : Text(notice!, style: typo.footnote.copyWith(color: noticeGood ? palette.green : palette.red)),
              ),
              ActionButton(
                key: const ValueKey('refresh-providers'),
                label: strings.refreshModels,
                plain: true,
                onPressed: busy || view.providers.isEmpty ? null : () => unawaited(run(() => widget.api.refreshProviders(), done: strings.saved)),
              ),
              const SizedBox(width: 8),
              ActionButton(
                key: const ValueKey('import-providers'),
                label: strings.importFromOmp,
                plain: true,
                onPressed: busy ? null : () => unawaited(run(() => widget.api.importProviders())),
              ),
              const SizedBox(width: 8),
              ActionButton(key: const ValueKey('add-provider'), label: strings.addProvider, busy: busy, onPressed: busy ? null : () => unawaited(_edit(null))),
            ],
          ),
        ),
      ],
    );
  }

  @override
  Future<void> run(Future<ProvidersView> Function() change, {String? done}) async {
    // An import says how many it added, which is set while it runs.
    await super.run(change, done: done);
    if (mounted && done == null && data?.imported != null) {
      setState(() {
        notice = Strings.read(context).importedProviders(data!.imported!);
        noticeGood = true;
      });
    }
  }
}

/// What the editor answers: the provider to save, or none to delete it.
class _Edited {
  const _Edited(this.provider);

  final Map<String, dynamic>? provider;
}

class _ProviderEditor extends StatefulWidget {
  const _ProviderEditor({required this.view, this.provider});

  final ProvidersView view;
  final CustomProvider? provider;

  @override
  State<_ProviderEditor> createState() => _ProviderEditorState();
}

class _ProviderEditorState extends State<_ProviderEditor> {
  late final _name = TextEditingController(text: widget.provider?.name ?? '');
  late final _url = TextEditingController(text: widget.provider?.baseUrl ?? '');
  late final _key = TextEditingController();
  late final _headers = TextEditingController(text: widget.provider?.headers.entries.map((entry) => '${entry.key}: ${entry.value}').join('\n') ?? '');
  late final _models = TextEditingController(
    text:
        widget.provider?.models
            .map((model) {
              final id = model['id'] as String? ?? '';
              final name = model['name'] as String? ?? '';
              return name.isEmpty || name == id ? id : '$id | $name';
            })
            .join('\n') ??
        '',
  );
  late String _api = widget.provider?.api ?? 'openai-completions';
  late Set<String> _used = {...?widget.provider?.kernels};
  bool _noKey = false;

  @override
  void initState() {
    super.initState();
    if (widget.provider == null) {
      _used = {
        for (final kernel in _kernels)
          if (widget.view.kernelServes(kernel, _api)) kernel,
      };
    }
  }

  @override
  void dispose() {
    for (final controller in [_name, _url, _key, _headers, _models]) {
      controller.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic> _result() {
    final before = widget.provider;
    final known = {for (final model in before?.models ?? const <Map<String, dynamic>>[]) model['id']: model};
    final listed = widget.view.listsModels(_api);
    final models = <Map<String, dynamic>>[if (listed) ...?before?.models];
    for (final line in listed ? const <String>[] : _models.text.split('\n')) {
      final parts = line.split('|');
      final id = parts.first.trim();
      if (id.isEmpty) continue;
      final name = parts.length > 1 ? parts.sublist(1).join('|').trim() : '';
      // A model kept from before keeps what the app does not edit, such as its context window.
      models.add({...?known[id], 'id': id, 'name': name});
    }
    final headers = <String, String>{};
    for (final line in _headers.text.split('\n')) {
      final at = line.indexOf(':');
      if (at > 0) headers[line.substring(0, at).trim()] = line.substring(at + 1).trim();
    }
    return {
      ...?before?.raw,
      'name': _name.text.trim(),
      'api': _api,
      'baseUrl': _url.text.trim(),
      'headers': headers,
      'models': models,
      'kernels': [
        for (final kernel in _kernels)
          if (_used.contains(kernel) && widget.view.kernelServes(kernel, _api)) kernel,
      ],
      if (before != null && before.name != _name.text.trim()) 'previousName': before.name,
      if (_noKey) 'apiKey': null else if (_key.text.trim().isNotEmpty) 'apiKey': _key.text.trim(),
    };
  }

  Future<void> _pickApi() async {
    final strings = Strings.read(context);
    final apis = {...widget.view.apis, _api}.toList();
    final picked = await pickOption<String>(context, title: strings.providerApi, options: [for (final api in apis) (api, api)], current: _api);
    if (picked != null && mounted) {
      setState(() {
        _api = picked.$1;
        _used = {
          for (final kernel in _kernels)
            if (widget.view.kernelServes(kernel, _api)) kernel,
        };
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final provider = widget.provider;
    Widget label(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(2, 12, 2, 6),
      child: Text(text, style: typo.footnote),
    );
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 560, maxHeight: MediaQuery.sizeOf(context).height * 0.9),
        child: Container(
          margin: const EdgeInsets.all(grid * 2),
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: BorderRadius.circular(14),
            boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 30, offset: Offset(0, 10))],
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
                child: Row(
                  children: [
                    Expanded(child: Text(provider == null ? strings.addProvider : strings.editProvider, style: typo.headline)),
                    CupertinoButton(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 30),
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(strings.cancel, style: typo.body.copyWith(color: palette.accent)),
                    ),
                  ],
                ),
              ),
              Container(height: 0.5, color: palette.separator),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      label(strings.providerName),
                      Box(key: const ValueKey('provider-name'), controller: _name, placeholder: 'my-provider'),
                      label(strings.providerApi),
                      Tappable(
                        onTap: () => unawaited(_pickApi()),
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                        child: Row(
                          children: [
                            Expanded(child: Text(_api, style: typo.body)),
                            Icon(CupertinoIcons.chevron_up_chevron_down, size: 13, color: palette.tertiary),
                          ],
                        ),
                      ),
                      label(strings.baseUrl),
                      Box(
                        key: const ValueKey('provider-url'),
                        controller: _url,
                        placeholder: 'https://example.com/v1',
                        mono: true,
                        keyboard: TextInputType.url,
                      ),
                      label(strings.apiKey),
                      if (!_noKey)
                        Box(
                          key: const ValueKey('provider-key'),
                          controller: _key,
                          placeholder: provider?.keyHint == null ? strings.apiKeyPlaceholder : strings.apiKeyKeep(provider!.keyHint!),
                          obscure: true,
                        ),
                      Row(
                        children: [
                          Expanded(child: Text(strings.removeKey, style: typo.footnote)),
                          CupertinoSwitch(value: _noKey, onChanged: (value) => setState(() => _noKey = value)),
                        ],
                      ),
                      if (widget.view.listsModels(_api)) ...[
                        label('${strings.providerModels} — ${provider == null || provider.models.isEmpty ? strings.modelsAfterSave : strings.modelsListed}'),
                        if (provider != null && provider.models.isNotEmpty)
                          Container(
                            key: const ValueKey('provider-listed-models'),
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(8)),
                            child: Text(
                              provider.models.map((model) => model['id'] as String? ?? '').join('\n'),
                              style: typo.mono.copyWith(color: palette.secondary),
                            ),
                          ),
                        if (provider?.modelsProblem != null)
                          Padding(padding: const EdgeInsets.only(top: 6), child: Text(provider!.modelsProblem!, style: typo.footnote.copyWith(color: palette.orange))),
                      ] else ...[
                        label('${strings.providerModels} — ${strings.providerModelsHint}'),
                        Box(key: const ValueKey('provider-models'), controller: _models, lines: 6, mono: true, placeholder: 'model-id | Display name'),
                      ],
                      label('${strings.headers} — ${strings.headersHint}'),
                      Box(controller: _headers, lines: 3, mono: true, placeholder: 'User-Agent: neo'),
                      label(strings.usedBy),
                      for (final kernel in _kernels)
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                widget.view.kernelServes(kernel, _api) ? kernelName(kernel) : '${kernelName(kernel)} · ${strings.unsupportedApi}',
                                style: typo.body.copyWith(color: widget.view.kernelServes(kernel, _api) ? palette.label : palette.tertiary),
                              ),
                            ),
                            CupertinoSwitch(
                              value: _used.contains(kernel) && widget.view.kernelServes(kernel, _api),
                              onChanged: widget.view.kernelServes(kernel, _api) ? (on) => setState(() => on ? _used.add(kernel) : _used.remove(kernel)) : null,
                            ),
                          ],
                        ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          if (provider != null)
                            ActionButton(
                              label: strings.delete,
                              destructive: true,
                              plain: true,
                              onPressed: () => Navigator.of(context).pop(const _Edited(null)),
                            ),
                          const Spacer(),
                          ActionButton(
                            key: const ValueKey('save-provider'),
                            label: strings.save,
                            onPressed: () => Navigator.of(context).pop(_Edited(_result())),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Each kernel's accounts, with logging in and out.
class AccountsSettings extends StatefulWidget {
  const AccountsSettings({super.key, required this.api});

  final ApiClient api;

  @override
  State<AccountsSettings> createState() => _AccountsSettingsState();
}

class _AccountsSettingsState extends LoadingState<AccountsSettings, AccountsView> {
  final _code = TextEditingController();
  Timer? _poll;
  bool _sending = false;

  @override
  Future<AccountsView> load() async {
    final view = await widget.api.accounts();
    _follow(view.login);
    return view;
  }

  @override
  void dispose() {
    _poll?.cancel();
    _code.dispose();
    super.dispose();
  }

  /// While a login runs, look at it again shortly; when it ends, read the accounts again.
  void _follow(LoginRun? login) {
    _poll?.cancel();
    if (login == null || !login.running) return;
    _poll = Timer(const Duration(milliseconds: 1500), () async {
      try {
        final fresh = await widget.api.login();
        if (!mounted) return;
        _show(fresh);
      } on ApiException {
        _follow(data?.login);
      }
    });
  }

  void _show(LoginRun? login) {
    final strings = Strings.read(context);
    final ended = data?.login?.running == true && login != null && !login.running;
    setState(() {
      data = AccountsView.withLogin(data!, login);
      if (ended) {
        notice = login.state == 'done' ? strings.loginDone : strings.loginFailed;
        noticeGood = login.state == 'done';
      }
    });
    if (ended) {
      unawaited(reload());
    } else {
      _follow(login);
    }
  }

  Future<void> _logIn(KernelAccounts kernel) async {
    final strings = Strings.read(context);
    String? provider;
    if (kernel.login.length == 1 && !kernel.anyProvider) {
      provider = kernel.login.first.$1;
    } else {
      final picked = await pickOption<String?>(
        context,
        title: '${strings.logIn} · ${kernelName(kernel.id)}',
        options: [for (final (id, name) in kernel.login) (id, name), if (kernel.anyProvider) (null, strings.otherProvider)],
        current: '',
      );
      if (picked == null || !mounted) return;
      provider = picked.$1;
      if (provider == null) {
        final typed = await askText(context, title: strings.providerId, fields: [(strings.providerId, false)]);
        if (typed == null || typed.first.isEmpty || !mounted) return;
        provider = typed.first;
      }
    }
    _code.clear();
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      final login = await widget.api.startLogin(kernel.id, provider);
      if (mounted) _show(login);
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          notice = error.message;
          noticeGood = false;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _send() async {
    final text = _code.text.trim();
    if (text.isEmpty) return;
    setState(() => _sending = true);
    try {
      final login = await widget.api.loginInput(text);
      _code.clear();
      if (mounted) _show(login);
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          notice = error.message;
          noticeGood = false;
        });
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _addKey(KernelAccounts kernel) async {
    final strings = Strings.read(context);
    final typed = await askText(
      context,
      title: '${strings.addApiKey} · ${kernelName(kernel.id)}',
      fields: [(strings.providerId, false), (strings.apiKey, true)],
    );
    if (typed == null || typed.any((text) => text.isEmpty) || !mounted) return;
    await run(() => widget.api.addApiKey(kernel.id, typed[0], typed[1]), done: strings.keyAdded);
  }

  Widget _loginPanel(LoginRun login) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final lines = login.output.split('\n');
    final shown = lines.length > 14 ? lines.sublist(lines.length - 14).join('\n') : login.output;
    return Padding(
      key: const ValueKey('login-panel'),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              if (login.running) const Padding(padding: EdgeInsets.only(right: 8), child: CupertinoActivityIndicator(radius: 7)),
              Expanded(
                child: Text(
                  login.running
                      ? strings.loginRunning('${kernelName(login.kernel)} · ${login.provider}')
                      : (login.state == 'done' ? strings.loginDone : strings.loginFailed),
                  style: typo.headline.copyWith(color: login.running ? palette.label : (login.state == 'done' ? palette.green : palette.red)),
                ),
              ),
              if (login.running)
                ActionButton(
                  label: strings.cancel,
                  plain: true,
                  onPressed: () => unawaited(() async {
                    try {
                      final ended = await widget.api.cancelLogin();
                      if (mounted) _show(ended);
                    } on ApiException catch (_) {}
                  }()),
                ),
            ],
          ),
          for (final link in login.links)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Selectable(
                      child: Text(
                        link,
                        style: typo.mono.copyWith(color: palette.accent),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                  Tappable(
                    tooltip: strings.copyLink,
                    padding: const EdgeInsets.all(6),
                    onTap: () {
                      unawaited(Clipboard.setData(ClipboardData(text: link)));
                      setState(() {
                        notice = strings.copied;
                        noticeGood = true;
                      });
                    },
                    child: Icon(CupertinoIcons.doc_on_doc, size: 16, color: palette.accent),
                  ),
                ],
              ),
            ),
          if (shown.trim().isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(8)),
              child: Selectable(
                child: Text(shown.trim(), style: typo.mono.copyWith(color: palette.secondary, fontSize: 11.5)),
              ),
            ),
          if (login.running)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Box(key: const ValueKey('login-code'), controller: _code, placeholder: strings.pasteCode, mono: true),
                  ),
                  const SizedBox(width: 8),
                  ActionButton(key: const ValueKey('login-submit'), label: strings.submit, busy: _sending, onPressed: () => unawaited(_send())),
                ],
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final view = data;
    if (view == null) return placeholder(context, strings.kernelAccounts);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final login = view.login;
    final idle = !busy && login?.running != true;
    return Group(
      title: strings.kernelAccounts,
      footer: strings.accountsFooter,
      children: [
        for (final kernel in view.kernels)
          Padding(
            key: ValueKey('accounts-${kernel.id}'),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(kernelName(kernel.id), style: typo.headline)),
                    if (kernel.installed && kernel.problem == null) ...[
                      if (kernel.apiKeys) ActionButton(label: strings.addApiKey, plain: true, onPressed: idle ? () => unawaited(_addKey(kernel)) : null),
                      if (kernel.apiKeys) const SizedBox(width: 8),
                      ActionButton(
                        key: ValueKey('login-${kernel.id}'),
                        label: strings.logIn,
                        plain: true,
                        onPressed: idle && kernel.login.isNotEmpty ? () => unawaited(_logIn(kernel)) : null,
                      ),
                    ],
                  ],
                ),
                if (!kernel.installed)
                  Text(strings.notInstalledShort, style: typo.footnote)
                else if (kernel.problem != null)
                  Text(kernel.problem!, style: typo.footnote.copyWith(color: palette.orange))
                else if (kernel.accounts.isEmpty)
                  Text(strings.notLoggedIn, style: typo.footnote),
                for (final account in kernel.accounts)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            [account.provider, if (account.label.isNotEmpty) account.label, account.kind].join(' · '),
                            style: typo.body,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (account.removable)
                          ActionButton(
                            label: strings.logOut,
                            plain: true,
                            destructive: true,
                            onPressed: idle ? () => unawaited(run(() => widget.api.logout(kernel.id, account.id), done: strings.loggedOut)) : null,
                          ),
                      ],
                    ),
                  ),
                if (kernel.note != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(kernel.note!, style: typo.footnote.copyWith(color: palette.tertiary)),
                  ),
              ],
            ),
          ),
        if (login != null && (login.running || login.output.isNotEmpty)) _loginPanel(login),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
            child: Text(notice!, style: typo.footnote.copyWith(color: noticeGood ? palette.green : palette.red)),
          ),
      ],
    );
  }
}
