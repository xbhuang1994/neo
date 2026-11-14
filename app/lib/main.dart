import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/foundation.dart';

import 'src/l10n/strings.dart';
import 'src/platform/host.dart';
import 'src/state/app_state.dart';
import 'src/ui/chat_page.dart';
import 'src/ui/scope.dart';
import 'src/ui/shell.dart';
import 'src/ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final host = Host.create();
  // A second app asks the first to come to the front, and ends.
  if (!await host.claimSingleInstance(() => unawaited(host.focusWindow()))) {
    host.quit();
    return;
  }
  final state = AppState(host);
  unawaited(state.start());
  runApp(NeoAgentApp(state: state, bundledCjk: kIsWeb));
}

/// The app.
class NeoAgentApp extends StatelessWidget {
  const NeoAgentApp({super.key, required this.state, this.bundledCjk = false, this.locale, this.brightness, this.picker = pickFiles});

  final AppState state;
  final bool bundledCjk;

  /// The language to show; the system's unless given.
  final Locale? locale;

  /// Light or dark; the system's unless given.
  final Brightness? brightness;
  final FilePicker picker;

  @override
  Widget build(BuildContext context) {
    return CupertinoApp(
      title: 'Neo Agent',
      debugShowCheckedModeBanner: false,
      theme: appTheme(brightness: brightness, bundledCjk: bundledCjk),
      locale: locale,
      supportedLocales: const [Locale('zh'), Locale('en')],
      localizationsDelegates: GlobalCupertinoLocalizations.delegates,
      scrollBehavior: const CupertinoScrollBehavior(),
      builder: (context, child) => StringsScope(
        strings: Strings.of(Localizations.localeOf(context)),
        child: AppScope(state: state, child: child!),
      ),
      home: CupertinoPageScaffold(resizeToAvoidBottomInset: true, child: Shell(picker: picker)),
    );
  }
}
