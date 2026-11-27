import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/main.dart';
import 'package:neo_agent/src/state/app_state.dart';
import 'package:neo_agent/src/ui/widgets.dart';

import 'fake_backend.dart';

const _wide = Size(1200, 820);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

class _ClipboardSpy {
  String? text;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        text = (call.arguments as Map?)?['text'] as String?;
        return null;
      }
      if (call.method == 'Clipboard.getData') {
        return text == null ? null : <String, dynamic>{'text': text};
      }
      if (call.method == 'Clipboard.hasStrings') {
        return <String, dynamic>{'value': text != null && text!.isNotEmpty};
      }
      return null;
    });
  }

  void uninstall() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
  }
}

Future<AppState> _openApp(WidgetTester tester, FakeBackend backend, {Locale locale = const Locale('zh')}) async {
  tester.view.physicalSize = _wide;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final state = stateOver(backend);
  await state.start();
  await tester.pumpWidget(NeoAgentApp(state: state, locale: locale, picker: () async => []));
  await _settle(tester);
  return state;
}

Future<void> _closeApp(WidgetTester tester, AppState state) async {
  Selectable.clearActiveSelection();
  await tester.pumpWidget(const SizedBox());
  state.dispose();
  await tester.pump(const Duration(milliseconds: 10));
}

Future<void> _dragMouse(WidgetTester tester, Offset start, Offset end) async {
  final gesture = await tester.startGesture(start, kind: PointerDeviceKind.mouse);
  await tester.pump(const Duration(milliseconds: 20));
  await gesture.moveTo(Offset.lerp(start, end, 0.5)!);
  await tester.pump(const Duration(milliseconds: 20));
  await gesture.moveTo(end);
  await tester.pump(const Duration(milliseconds: 20));
  await gesture.up();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _dragText(WidgetTester tester, Finder finder) async {
  final rect = tester.getRect(finder);
  await _dragMouse(tester, Offset(rect.left + 1, rect.center.dy), Offset(rect.right - 1, rect.center.dy));
}

LogicalKeyboardKey _primaryModifier(TargetPlatform platform) =>
    platform == TargetPlatform.macOS ? LogicalKeyboardKey.metaLeft : LogicalKeyboardKey.controlLeft;

Future<void> _sendShortcut(WidgetTester tester, TargetPlatform platform, LogicalKeyboardKey key) async {
  final mod = _primaryModifier(platform);
  final os = platform.name.toLowerCase();
  await tester.sendKeyDownEvent(mod, platform: os);
  await tester.sendKeyDownEvent(key, platform: os);
  await tester.sendKeyUpEvent(key, platform: os);
  await tester.sendKeyUpEvent(mod, platform: os);
  await tester.pump(const Duration(milliseconds: 30));
}

Future<void> _sendCopy(WidgetTester tester, TargetPlatform platform) => _sendShortcut(tester, platform, LogicalKeyboardKey.keyC);

Future<void> _sendCut(WidgetTester tester, TargetPlatform platform) => _sendShortcut(tester, platform, LogicalKeyboardKey.keyX);

Future<void> _sendSelectAll(WidgetTester tester, TargetPlatform platform) => _sendShortcut(tester, platform, LogicalKeyboardKey.keyA);

Future<void> _sendWindowEditAction(WidgetTester tester, String action) async {
  const codec = StandardMethodCodec();
  final data = codec.encodeMethodCall(MethodCall('editAction', action));
  final completer = Completer<void>();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage('neo_agent/window', data, (_) {
    if (!completer.isCompleted) completer.complete();
  });
  await completer.future;
  await tester.pump(const Duration(milliseconds: 30));
}

const _desktopPlatforms = TargetPlatformVariant({TargetPlatform.macOS, TargetPlatform.windows, TargetPlatform.linux});

void main() {
  testWidgets(
    'ChatPage copies messages, code blocks, LinkNotice, and composer error via shortcut across desktop platforms',
    variant: _desktopPlatforms,
    (tester) async {
      final platform = defaultTargetPlatform;
      final clipboard = _ClipboardSpy()..install();
      addTearDown(clipboard.uninstall);

      final backend = FakeBackend()
        ..kernelProblem = 'agy binary not found in PATH'
        ..chatError = 'backend rejected message: E_RATE_LIMIT'
        ..say('user', '请检查快捷键复制')
        ..say('assistant', '测试复制内容：\n\n```bash\ncurl -fsSL https://neo.example.test/install.sh | sh\n```')
        ..activity = {'router': true, 'workers': <Map<String, dynamic>>[]};
      final state = await _openApp(tester, backend);

      // 1. Focus composer first, then drag-select assistant code block and copy.
      await tester.enterText(find.byType(CupertinoTextField), 'draft message');
      await tester.pump();
      clipboard.text = null;
      await _dragText(tester, find.text('curl -fsSL https://neo.example.test/install.sh | sh'));
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'curl -fsSL https://neo.example.test/install.sh | sh');

      // On Windows/Linux, Ctrl+Insert must also copy.
      if (platform != TargetPlatform.macOS) {
        clipboard.text = null;
        await _sendShortcut(tester, platform, LogicalKeyboardKey.insert);
        expect(clipboard.text, 'curl -fsSL https://neo.example.test/install.sh | sh');
      }

      // 2. Select-all in ChatPage excludes ActivityTicker text.
      clipboard.text = null;
      await _sendSelectAll(tester, platform);
      await _sendCopy(tester, platform);
      expect(clipboard.text, contains('curl -fsSL https://neo.example.test/install.sh | sh'));
      expect(clipboard.text, isNot(contains('router 正在思考中')));

      // 3. LinkNotice kernel problem text is selectable and copyable.
      clipboard.text = null;
      await _dragText(tester, find.text('agy binary not found in PATH'));
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'agy binary not found in PATH');

      // 4. Composer error Notice is selectable and copyable.
      await tester.tap(find.bySemanticsLabel('发送'));
      await _settle(tester);
      expect(find.text('backend rejected message: E_RATE_LIMIT'), findsOneWidget);
      clipboard.text = null;
      await _dragText(tester, find.text('backend rejected message: E_RATE_LIMIT'));
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'backend rejected message: E_RATE_LIMIT');

      await _closeApp(tester, state);
    },
  );

  testWidgets(
    'DevicesPage and DeviceEnrollSheet (including box padding drag) copy via shortcut',
    variant: _desktopPlatforms,
    (tester) async {
      final platform = defaultTargetPlatform;
      final clipboard = _ClipboardSpy()..install();
      addTearDown(clipboard.uninstall);

      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal-cluster', relayUrl: 'https://neo.example.test:18443')
        ..addDevice('edge-node-01')
        ..addDeviceApproval(
          'apr-1',
          shortCode: 'APR-991',
          deviceId: 'edge-node-01',
          action: 'exec',
          params: const {'cmd': 'systemctl restart neo'},
          reason: 'high risk service restart',
        );
      final state = await _openApp(tester, backend);

      // Navigate to Devices tab.
      await tester.tap(find.byKey(const ValueKey('nav-2')));
      await _settle(tester);

      // 1. Copy relay URL directly from DevicesPage.
      clipboard.text = null;
      await _dragText(tester, find.text('https://neo.example.test:18443'));
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'https://neo.example.test:18443');

      // 2. Copy approval reason from DevicesPage.
      clipboard.text = null;
      await _dragText(tester, find.text('high risk service restart'));
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'high risk service restart');

      // 3. Open Add Device sheet, generate Windows command, start drag inside the 12px command box padding.
      await tester.tap(find.byKey(const ValueKey('header-add-device-btn')));
      await _settle(tester);
      await tester.tap(find.text('Windows'));
      await _settle(tester);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await _settle(tester);

      final cmdBox = tester.getRect(find.byKey(const ValueKey('enroll-command-box')));
      clipboard.text = null;
      // Start 3px inside the container's left edge (inside the 12px padding outside Text bounds).
      await _dragMouse(tester, Offset(cmdBox.left + 3, cmdBox.center.dy), Offset(cmdBox.right - 3, cmdBox.center.dy));
      await _sendCopy(tester, platform);
      expect(clipboard.text, isNotNull);
      expect(clipboard.text, contains('irm '));

      // Close modal cleanly before teardown.
      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await _settle(tester);
      await _closeApp(tester, state);
    },
  );

  testWidgets(
    'SettingsPage copies text while preserving TextField copy/cut and obscured secret protection',
    variant: _desktopPlatforms,
    (tester) async {
      final platform = defaultTargetPlatform;
      final clipboard = _ClipboardSpy()..install();
      addTearDown(clipboard.uninstall);

      final backend = FakeBackend()..account = {'email': 'demo@example.test', 'removable': false};
      final state = await _openApp(tester, backend);

      // Navigate to Settings tab.
      await tester.tap(find.byKey(const ValueKey('nav-3')));
      await _settle(tester);

      // 1. Copy non-editable text on SettingsPage (Antigravity account email).
      final emailFinder = find.text('Google · demo@example.test');
      expect(emailFinder, findsOneWidget);
      clipboard.text = null;
      await _dragText(tester, emailFinder);
      await _sendCopy(tester, platform);
      expect(clipboard.text, contains('demo@example.test'));

      // 2. Navigate to uninitialized DevicesPage to test both plain and obscured Box inside Selectable.
      await tester.tap(find.byKey(const ValueKey('nav-2')));
      await _settle(tester);

      final relayField = find.byKey(const ValueKey('init-relay-url'));
      await tester.tap(relayField);
      await tester.pump();
      await _sendSelectAll(tester, platform);
      clipboard.text = null;
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'https://neo.1inch.cn:18443');

      // Cut works on normal editable field.
      await _sendCut(tester, platform);
      expect(tester.widget<CupertinoTextField>(find.descendant(of: relayField, matching: find.byType(CupertinoTextField))).controller!.text, isEmpty);

      // Obscured secret field must NOT copy its secret value.
      final secretField = find.byKey(const ValueKey('init-cluster-secret'));
      await tester.enterText(secretField, 'super-secret-token');
      await tester.pump();
      await _sendSelectAll(tester, platform);
      clipboard.text = null;
      await _sendCopy(tester, platform);
      expect(clipboard.text, isNull);

      await _closeApp(tester, state);
    },
  );

  testWidgets(
    'Fallback copies active selection when focus drifts after window deactivation, and tab switch clears stale selection',
    variant: _desktopPlatforms,
    (tester) async {
      final platform = defaultTargetPlatform;
      final clipboard = _ClipboardSpy()..install();
      addTearDown(clipboard.uninstall);

      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal-cluster', relayUrl: 'https://neo.example.test:18443')
        ..say('assistant', 'focus-drift-copy-payload');
      final state = await _openApp(tester, backend);

      await _dragText(tester, find.text('focus-drift-copy-payload'));
      expect(Selectable.hasActiveSelection, isTrue);

      // Simulate desktop window deactivation -> focus lost while visual selection stays -> window resumed without refocusing SelectableRegion.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      expect(Selectable.hasActiveSelection, isTrue);
      clipboard.text = null;
      await _sendCopy(tester, platform);
      expect(clipboard.text, 'focus-drift-copy-payload');

      // Switching tabs must clear stale selection from the hidden IndexedStack tab.
      await tester.tap(find.byKey(const ValueKey('nav-2')));
      await _settle(tester);
      expect(Selectable.hasActiveSelection, isFalse);
      clipboard.text = null;
      await _sendCopy(tester, platform);
      expect(clipboard.text, isNull);

      await _closeApp(tester, state);
    },
  );

  testWidgets(
    'macOS native Edit menu channel dispatches copy, cut, paste, and selectAll',
    variant: const TargetPlatformVariant({TargetPlatform.macOS}),
    (tester) async {
      final clipboard = _ClipboardSpy()..install();
      addTearDown(clipboard.uninstall);

      final backend = FakeBackend()..say('assistant', 'macos-menu-copy-text');
      final state = await _openApp(tester, backend);

      // 1. Copy from SelectableRegion via native Edit -> Copy.
      await _dragText(tester, find.text('macos-menu-copy-text'));
      clipboard.text = null;
      await _sendWindowEditAction(tester, 'copy');
      expect(clipboard.text, 'macos-menu-copy-text');

      // 2. SelectAll + Cut + Paste in Composer text field via native Edit menu.
      final composerField = find.byType(CupertinoTextField);
      await tester.enterText(composerField, 'hello macos');
      await tester.pump();
      await _sendWindowEditAction(tester, 'selectAll');
      clipboard.text = null;
      await _sendWindowEditAction(tester, 'cut');
      expect(clipboard.text, 'hello macos');
      expect(tester.widget<CupertinoTextField>(composerField).controller!.text, isEmpty);

      clipboard.text = 'pasted from menu';
      await _sendWindowEditAction(tester, 'paste');
      expect(tester.widget<CupertinoTextField>(composerField).controller!.text, 'pasted from menu');

      await _closeApp(tester, state);
    },
  );

  testWidgets('Transcript preserves scroll position across unrelated activity refreshes', (tester) async {
    final backend = FakeBackend();
    for (var i = 0; i < 30; i++) {
      backend.say(i.isEven ? 'user' : 'assistant', 'message line $i with enough content to fill the transcript viewport');
    }
    final state = await _openApp(tester, backend);

    final listFinder = find.byType(ListView);
    final scrollable = tester.state<ScrollableState>(find.descendant(of: listFinder, matching: find.byType(Scrollable)));
    final initialMax = scrollable.position.maxScrollExtent;
    expect(initialMax, greaterThan(100));

    // Scroll slightly upward (within 40px of bottom so _follow stays true) and trigger an unrelated activity refresh.
    final targetOffset = initialMax - 30;
    scrollable.position.jumpTo(targetOffset);
    await tester.pump();
    expect(scrollable.position.pixels, closeTo(targetOffset, 1));

    backend.activity = {'router': true, 'workers': <Map<String, dynamic>>[]};
    await state.refresh();
    await _settle(tester);

    // Must not jump back to maxScrollExtent when messages did not change.
    expect(scrollable.position.pixels, closeTo(targetOffset, 1));

    await _closeApp(tester, state);
  });
}
