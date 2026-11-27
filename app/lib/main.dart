import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'src/l10n/strings.dart';
import 'src/platform/host.dart';
import 'src/state/app_state.dart';
import 'src/ui/chat_page.dart';
import 'src/ui/scope.dart';
import 'src/ui/shell.dart';
import 'src/ui/theme.dart';
import 'src/ui/widgets.dart';

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
      title: 'Neo',
      debugShowCheckedModeBanner: false,
      theme: appTheme(brightness: brightness, bundledCjk: bundledCjk),
      locale: locale,
      supportedLocales: const [Locale('zh'), Locale('en')],
      localizationsDelegates: GlobalCupertinoLocalizations.delegates,
      scrollBehavior: const CupertinoScrollBehavior(),
      builder: (context, child) => StringsScope(
        strings: Strings.of(Localizations.localeOf(context)),
        child: AppScope(state: state, child: _CopyShortcutScope(child: child!)),
      ),
      home: CupertinoPageScaffold(resizeToAvoidBottomInset: true, child: Shell(picker: picker)),
    );
  }
}

/// Ensures Cmd/Ctrl+C and native macOS Edit menu actions reliably copy selected text
/// across pages, dialogs, drifted focus states, and non-HTTPS Web origins.
class _CopyShortcutScope extends StatefulWidget {
  const _CopyShortcutScope({required this.child});

  final Widget child;

  @override
  State<_CopyShortcutScope> createState() => _CopyShortcutScopeState();
}

class _CopyShortcutScopeState extends State<_CopyShortcutScope> {
  static const _windowChannel = MethodChannel('neo_agent/window');
  late final _AppCopyAction _copyAction = _AppCopyAction();

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_handleKeyEvent);
    _windowChannel.setMethodCallHandler(_handleWindowCall);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_handleKeyEvent);
    _windowChannel.setMethodCallHandler(null);
    super.dispose();
  }

  bool _isCopyShortcut(KeyEvent event) {
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isAltPressed || keyboard.isShiftPressed) return false;
    final apple = defaultTargetPlatform == TargetPlatform.macOS || defaultTargetPlatform == TargetPlatform.iOS;
    if (apple) {
      return event.logicalKey == LogicalKeyboardKey.keyC && keyboard.isMetaPressed && !keyboard.isControlPressed;
    }
    return (event.logicalKey == LogicalKeyboardKey.keyC || event.logicalKey == LogicalKeyboardKey.insert) &&
        keyboard.isControlPressed &&
        !keyboard.isMetaPressed;
  }

  bool _handleKeyEvent(KeyEvent event) {
    if (event is! KeyDownEvent || !_isCopyShortcut(event) || !Selectable.hasActiveSelection) return false;
    final primaryContext = FocusManager.instance.primaryFocus?.context;
    if (primaryContext != null) {
      if (primaryContext.findAncestorStateOfType<EditableTextState>() != null) return false;
      if (Actions.maybeFind<CopySelectionTextIntent>(primaryContext) != null) return false;
    }
    return Selectable.copyActiveSelection();
  }

  Future<void> _handleWindowCall(MethodCall call) async {
    if (call.method != 'editAction') return;
    final action = call.arguments;
    if (action is! String) return;
    final primaryContext = FocusManager.instance.primaryFocus?.context;
    switch (action) {
      case 'copy':
        if (primaryContext != null && Actions.maybeFind<CopySelectionTextIntent>(primaryContext) != null) {
          Actions.maybeInvoke<CopySelectionTextIntent>(primaryContext, CopySelectionTextIntent.copy);
        } else {
          Selectable.copyActiveSelection();
        }
      case 'cut':
        if (primaryContext != null) {
          Actions.maybeInvoke<CopySelectionTextIntent>(primaryContext, const CopySelectionTextIntent.cut(SelectionChangedCause.keyboard));
        }
      case 'paste':
        if (primaryContext != null) {
          Actions.maybeInvoke<PasteTextIntent>(primaryContext, const PasteTextIntent(SelectionChangedCause.keyboard));
        }
      case 'selectAll':
        if (primaryContext != null && Actions.maybeFind<SelectAllTextIntent>(primaryContext) != null) {
          Actions.maybeInvoke<SelectAllTextIntent>(primaryContext, const SelectAllTextIntent(SelectionChangedCause.keyboard));
        } else {
          Selectable.selectAllActive();
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Actions(
      actions: <Type, Action<Intent>>{
        CopySelectionTextIntent: _copyAction,
      },
      child: widget.child,
    );
  }
}

class _AppCopyAction extends ContextAction<CopySelectionTextIntent> {
  @override
  bool isEnabled(CopySelectionTextIntent intent, [BuildContext? context]) {
    if (callingAction != null) return true;
    return !intent.collapseSelection && Selectable.hasActiveSelection;
  }

  @override
  Object? invoke(CopySelectionTextIntent intent, [BuildContext? context]) {
    final targetContext = context ?? FocusManager.instance.primaryFocus?.context;
    final editable = targetContext?.findAncestorStateOfType<EditableTextState>();
    if (editable != null) {
      if (kIsWeb) {
        final selection = editable.textEditingValue.selection;
        if (!editable.widget.selectionEnabled || !selection.isValid || selection.isCollapsed || editable.widget.obscureText) {
          return null;
        }
        final text = editable.textEditingValue.text;
        if (intent.collapseSelection) {
          if (editable.widget.readOnly) return null;
          unawaited(copyToClipboard(selection.textInside(text)));
          editable.userUpdateTextEditingValue(
            TextEditingValue(
              text: selection.textBefore(text) + selection.textAfter(text),
              selection: TextSelection.collapsed(offset: selection.start),
            ),
            intent.cause,
          );
          return null;
        }
        unawaited(copyToClipboard(selection.textInside(text)));
        return null;
      }
      if (callingAction != null) return callingAction!.invoke(intent);
      if (intent.collapseSelection) {
        editable.cutSelection(intent.cause);
      } else {
        editable.copySelection(intent.cause);
      }
      return null;
    }

    if (intent.collapseSelection) return null;
    if (Selectable.copyActiveSelection()) return null;
    return callingAction?.invoke(intent);
  }
}
