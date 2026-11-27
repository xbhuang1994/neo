/// Settings for Antigravity's Google account, with logging in and out.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../platform/host.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets.dart';

/// Antigravity's Google account, with logging in and out.
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

  /// While a login runs, look at it again shortly; when it ends, read the account again.
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

  Future<void> _logIn() async {
    _code.clear();
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      final login = await widget.api.startLogin();
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
                  login.running ? strings.loginRunning : (login.state == 'done' ? strings.loginDone : strings.loginFailed),
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
                    child: Text(
                      link,
                      style: typo.mono.copyWith(color: palette.accent),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Tappable(
                    tooltip: strings.copyLink,
                    padding: const EdgeInsets.all(6),
                    onTap: () {
                      unawaited(copyToClipboard(link));
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
              child: Text(shown.trim(), style: typo.mono.copyWith(color: palette.secondary, fontSize: 11.5)),
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
    if (view == null) return placeholder(context, strings.antigravityAccount);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final login = view.login;
    final account = view.account;
    final idle = !busy && login?.running != true;
    return Selectable(
      child: Group(
        title: strings.antigravityAccount,
        footer: strings.accountsFooter,
        children: [
        Padding(
          key: const ValueKey('accounts-antigravity'),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(child: Text('Antigravity', style: typo.headline)),
                  if (view.installed && view.problem == null)
                    ActionButton(
                      key: const ValueKey('login-antigravity'),
                      label: strings.logIn,
                      plain: true,
                      onPressed: idle ? () => unawaited(_logIn()) : null,
                    ),
                ],
              ),
              if (!view.installed)
                Text(strings.notInstalledShort, style: typo.footnote)
              else if (view.problem != null)
                Text(view.problem!, style: typo.footnote.copyWith(color: palette.orange))
              else if (account == null)
                Text(strings.notLoggedIn, style: typo.footnote)
              else
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          account.email.isEmpty ? 'Google' : 'Google · ${account.email}',
                          style: typo.body,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (account.removable)
                        ActionButton(
                          key: const ValueKey('logout-antigravity'),
                          label: strings.logOut,
                          plain: true,
                          destructive: true,
                          onPressed: idle ? () => unawaited(run(widget.api.logout, done: strings.loggedOut)) : null,
                        ),
                    ],
                  ),
                ),
              if (view.note != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(view.note!, style: typo.footnote.copyWith(color: palette.tertiary)),
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
    ),
    );
  }
}
