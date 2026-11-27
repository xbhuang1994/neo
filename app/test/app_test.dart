import 'dart:async';
import 'dart:typed_data';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/main.dart';
import 'package:neo_agent/src/api/models.dart';
import 'package:neo_agent/src/platform/host.dart';
import 'package:neo_agent/src/qr/qr_view.dart';
import 'package:neo_agent/src/state/app_state.dart';
import 'package:neo_agent/src/ui/chat_page.dart';
import 'package:neo_agent/src/ui/theme.dart' show cjkFont;
import 'package:neo_agent/src/ui/widgets.dart';

import 'fake_backend.dart';

const wide = Size(1100, 800);
const narrow = Size(420, 800);

/// Let what is under way finish: answers arrive, frames follow.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

class Running {
  Running(this.tester, this.state);

  final WidgetTester tester;
  final AppState state;

  /// End the app, so that nothing of it outlives the test.
  Future<void> close() async {
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await tester.pump(const Duration(milliseconds: 10));
  }
}

Future<Running> open(WidgetTester tester, FakeBackend backend, {Size size = wide, Locale locale = const Locale('zh'), FakeHost? host, FilePicker? picker, Brightness? brightness, bool bundledCjk = false}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final state = stateOver(backend, host: host);
  await state.start();
  await tester.pumpWidget(NeoAgentApp(state: state, locale: locale, brightness: brightness, bundledCjk: bundledCjk, picker: picker ?? () async => []));
  await settle(tester);
  return Running(tester, state);
}

/// Scroll a widget to the middle of its list and lay out, so that a tap on it lands.
Future<void> show(WidgetTester tester, Finder finder) async {
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pump();
}

Finder nav(int index) => find.byKey(ValueKey('nav-$index'));
Finder button(String label) => find.bySemanticsLabel(label);

void main() {
  testWidgets('floats what is at work at the bottom right and turns through it', (tester) async {
    final backend = FakeBackend();
    final app = await open(tester, backend);
    final ticker = find.byKey(const ValueKey('activity-ticker'));
    expect(ticker, findsNothing);

    backend.activity = {'router': true, 'workers': <Map<String, dynamic>>[]};
    await app.state.refresh();
    await tester.pump();
    expect(find.text('router 正在思考中…'), findsOneWidget);
    // At the bottom right, above the composer.
    final box = tester.getRect(ticker);
    expect(box.right, greaterThan(wide.width - 40));
    expect(box.bottom, lessThan(tester.getRect(find.byType(CupertinoTextField)).top));

    backend.activity = {
      'router': true,
      'workers': [
        {'ticketId': 't1', 'title': '修复首页', 'doing': 'bash · cargo test'},
        {'ticketId': 't2', 'title': '', 'doing': '后台 · make train'},
      ],
    };
    await app.state.refresh();
    await tester.pump();
    expect(find.text('1/3'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('修复首页 · bash · cargo test'), findsOneWidget);
    expect(find.text('2/3'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('后台 · make train'), findsOneWidget);

    // On another page it floats there too; and it goes once nothing is at work.
    await tester.tap(nav(1));
    await tester.pump();
    expect(ticker, findsOneWidget);
    backend.activity = {'router': false, 'workers': <Map<String, dynamic>>[]};
    await app.state.refresh();
    await tester.pump();
    expect(ticker, findsNothing);

    // A backend too old to say shows nothing.
    backend.activity = null;
    await app.state.refresh();
    await tester.pump();
    expect(ticker, findsNothing);
    expect(app.state.link, Link.online);
    await app.close();
  });

  testWidgets('sends a message and shows the answer', (tester) async {
    final backend = FakeBackend();
    final app = await open(tester, backend);
    expect(find.text('开始对话'), findsOneWidget);
    expect(find.text('已连接'), findsWidgets);
    // Nothing to send yet.
    await tester.tap(button('发送'));
    await settle(tester);
    expect(backend.chats, isEmpty);

    await tester.enterText(find.byType(CupertinoTextField), '  修一下首页的错别字  ');
    await tester.pump();
    await tester.tap(button('发送'));
    await settle(tester);
    expect(backend.chats.single['text'], '修一下首页的错别字');
    expect(backend.chats.single['messageId'], matches(RegExp(r'^web:[0-9a-f]{24}$')));
    expect(find.text('修一下首页的错别字'), findsOneWidget);
    expect(find.text('On it.'), findsOneWidget);
    expect(find.text('开始对话'), findsNothing);
    expect(tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text, isEmpty);
    // Who said it and when.
    expect(find.textContaining('你 · '), findsOneWidget);
    expect(find.textContaining('Neo · '), findsOneWidget);

    // What arrives later shows by itself.
    backend.say('assistant', '首页的错别字已修正。');
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(find.text('首页的错别字已修正。'), findsOneWidget);
    await app.close();
  });

  testWidgets('attaches files within the limits and sends a failed message again as the same message', (tester) async {
    final backend = FakeBackend();
    var round = 0;
    final rounds = [
      [OutgoingFile('a.txt', 'text/plain', Uint8List(10)), OutgoingFile('big.bin', '', Uint8List(maxFileBytes + 1))],
      [OutgoingFile('b.png', 'image/png', Uint8List(2048)), OutgoingFile('c.md', 'text/markdown', Uint8List(3)), OutgoingFile('d.md', 'text/markdown', Uint8List(3))],
    ];
    final app = await open(tester, backend, picker: () async => rounds[round++]);
    await tester.tap(button('添加附件'));
    await settle(tester);
    expect(find.text('a.txt'), findsOneWidget);
    expect(find.text('big.bin'), findsNothing);
    expect(find.text('big.bin 超过 5 MiB'), findsOneWidget);
    await tester.tap(button('添加附件'));
    await settle(tester);
    expect([find.text('b.png'), find.text('c.md')].every((finder) => finder.evaluate().length == 1), isTrue);
    expect(find.text('d.md'), findsNothing);
    expect(find.text('最多添加 3 个附件'), findsOneWidget);
    expect(find.text('2.0 KB'), findsOneWidget);

    // A refused message stays written, and its second sending carries the same id.
    backend.chatError = 'The Antigravity CLI (agy) was not found.';
    await tester.enterText(find.byType(CupertinoTextField), '看看这些文件');
    await tester.pump();
    await tester.tap(button('发送'));
    await settle(tester);
    expect(find.text('The Antigravity CLI (agy) was not found.'), findsOneWidget);
    expect(tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text, '看看这些文件');
    expect(find.text('a.txt'), findsOneWidget);
    await tester.tap(button('发送'));
    await settle(tester);
    expect(backend.chats, hasLength(2));
    expect(backend.chats[1]['messageId'], backend.chats[0]['messageId']);
    expect((backend.chats[1]['attachments'] as List).map((file) => file['name']), ['a.txt', 'b.png', 'c.md']);
    expect(find.text('a.txt'), findsNothing, reason: 'the draft is cleared once sent');
    await app.close();
  });

  testWidgets('shows messages with their files, code and folding', (tester) async {
    final backend = FakeBackend();
    backend.say(
      'user',
      '看这两个文件\n\n<attachment name="notes.md">\n# Notes\n</attachment>\n\n<attachment name="data.bin" mediaType="application/zip" path="/d/2-data.bin">\nFile saved at the path above.\n</attachment>',
      source: 'wechat',
      files: [
        {'name': 'notes.md', 'mediaType': 'text/markdown', 'kind': 'text'},
        {'name': 'data.bin', 'mediaType': 'application/zip', 'kind': 'file'},
      ],
    );
    backend.say('assistant', '{"status":"ok","count":2}');
    backend.say('assistant', List.generate(30, (line) => '第 $line 行').join('\n'));
    final app = await open(tester, backend);
    // A person's message shows without the blocks that carried its files; those show as files.
    expect(find.text('看这两个文件'), findsOneWidget);
    expect(find.textContaining('<attachment'), findsNothing);
    expect(find.text('notes.md'), findsOneWidget);
    expect(find.text('data.bin'), findsOneWidget);
    expect(find.textContaining('你 · 微信 · '), findsOneWidget);
    // JSON is indented in a code block.
    expect(find.text('JSON'), findsOneWidget);
    expect(find.text('{\n  "status": "ok",\n  "count": 2\n}'), findsOneWidget);
    // A long message is folded until asked for.
    expect(find.byType(CodeBlock), findsOneWidget);
    expect(find.text('展开全部'), findsOneWidget);
    await tester.tap(find.text('展开全部'));
    await tester.pump();
    expect(find.text('收起'), findsOneWidget);
    await app.close();
  });

  testWidgets('says what is in the way of the connection, and takes a token', (tester) async {
    final backend = FakeBackend(token: 'secret-token-0123456789');
    final host = FakeHost(pageOrigin: Uri.parse('http://backend.test'));
    final app = await open(tester, backend, host: host);
    expect(find.text('需要访问令牌'), findsWidgets);
    // The notice leads to where the token is entered.
    await tester.tap(find.widgetWithText(CupertinoButton, '设置'));
    await settle(tester);
    expect(find.text('此页面由服务器提供。服务器设置了访问令牌时，请在这里填写。'), findsOneWidget);
    await tester.enterText(find.byType(CupertinoTextField), 'secret-token-0123456789');
    await tester.tap(find.widgetWithText(CupertinoButton, '连接'));
    await settle(tester);
    expect(app.state.link, Link.online);
    expect(host.prefs['token'], 'secret-token-0123456789');
    expect(find.text('需要访问令牌'), findsNothing);
    expect(find.text('内核与模型'.toUpperCase()), findsOneWidget);

    // A backend that stops answering is said so, and what was shown stays.
    backend.down = true;
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    await tester.tap(nav(0));
    await settle(tester);
    expect(find.text('连接失败'), findsWidgets);
    backend.down = false;
    await tester.tap(find.widgetWithText(CupertinoButton, '重试'));
    await settle(tester);
    expect(find.text('连接失败'), findsNothing);
    // A kernel that cannot run is named.
    backend.kernelProblem = 'The Antigravity CLI (agy) was not found.';
    await tester.pump(const Duration(seconds: 10));
    await settle(tester);
    expect(find.text('执行内核不可用'), findsOneWidget);
    expect(find.text('The Antigravity CLI (agy) was not found.'), findsOneWidget);
    await app.close();
  });

  testWidgets('resets the conversation after asking', (tester) async {
    final backend = FakeBackend()..say('user', '你好');
    final app = await open(tester, backend);
    await tester.tap(button('重置会话'));
    await settle(tester);
    expect(find.text('重置会话？'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await settle(tester);
    expect(backend.resets, 0);
    await tester.tap(button('重置会话'));
    await settle(tester);
    await tester.tap(find.text('重置'));
    await settle(tester);
    expect(backend.resets, 1);
    expect(find.text('你好'), findsNothing);
    expect(find.text('开始对话'), findsOneWidget);
    await app.close();
  });

  testWidgets('draws the reset dialog in the bundled Chinese font', (tester) async {
    final backend = FakeBackend()..say('user', '你好');
    final app = await open(tester, backend, bundledCjk: true);
    await tester.tap(button('重置会话'));
    await settle(tester);
    // The dialog sets its own font, so without the fallback its Chinese shows as empty boxes on the web.
    for (final label in ['重置会话？', '取消', '重置']) {
      final drawn = tester.widget<RichText>(find.descendant(of: find.text(label), matching: find.byType(RichText)));
      expect(drawn.text.style?.fontFamilyFallback, contains(cjkFont), reason: label);
    }
    await tester.tap(find.text('取消'));
    await settle(tester);
    await app.close();
  });

  testWidgets('lists the tasks and shows one in detail', (tester) async {
    final backend = FakeBackend()
      ..addWorker(
        't-open',
        '训练模型',
        {'stage': 'person', 'action': 'answer'},
        report: {'state': 'progress', 'summary': '正在训练。', 'at': '2026-05-01T09:10:00.000Z'},
        question: '用哪个数据集？',
        background: [
          {'id': 'bg_1', 'type': 'bash', 'label': 'make train', 'startedAt': '2026-05-01T09:00:00.000Z'},
        ],
        recent: [
          {'id': 1, 'role': 'assistant', 'text': '开始训练。'},
          {'id': 2, 'role': 'toolResult', 'text': '```\nepoch 1\n```'},
        ],
      )
      ..addWorker('t-done', '修复错别字', {'stage': 'ended'}, outcome: 'completed', report: {'state': 'ready', 'summary': '已修复。', 'at': '2026-05-01T08:00:00.000Z'});
    final app = await open(tester, backend);
    // The sidebar counts the open ones.
    expect(find.descendant(of: nav(1), matching: find.text('1')), findsOneWidget);
    await tester.tap(nav(1));
    await settle(tester);
    expect(find.text('1 个进行中 · 共 2 个'), findsOneWidget);
    expect(find.text('等待回复'), findsOneWidget);
    expect(find.text('已完成'), findsOneWidget);
    expect(find.text('选择一个任务查看详情'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('worker-t-open')));
    await settle(tester);
    expect(find.text('t-open'), findsOneWidget);
    expect(find.text('/data/work/t-open'), findsOneWidget);
    expect(find.text('用哪个数据集？'), findsOneWidget);
    expect(find.text('bg_1 · make train'), findsOneWidget);
    expect(find.text('正在训练。'), findsOneWidget);
    expect(find.text('最近活动 (2)'), findsOneWidget);
    expect(find.text('开始训练。'), findsOneWidget);
    expect(find.text('epoch 1'), findsOneWidget);
    // The detail follows the backend.
    backend.details['t-open']!['recent'] = [
      {'id': 3, 'role': 'assistant', 'text': '训练完成。'},
    ];
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(find.text('训练完成。'), findsOneWidget);
    await app.close();
  });

  testWidgets('uses tabs on a narrow window, with the detail over the list', (tester) async {
    final backend = FakeBackend()..addWorker('t1', '训练模型', {'stage': 'working'}, streaming: true);
    final app = await open(tester, backend, size: narrow);
    expect(find.text('Neo'), findsNothing, reason: 'no sidebar');
    await tester.tap(nav(1));
    await settle(tester);
    expect(find.text('正在执行'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('worker-t1')));
    await settle(tester);
    expect(find.text('t1'), findsOneWidget);
    expect(find.byKey(const ValueKey('worker-t1')), findsNothing);
    await tester.tap(find.byIcon(CupertinoIcons.chevron_back));
    await settle(tester);
    expect(find.byKey(const ValueKey('worker-t1')), findsOneWidget);
    await app.close();
  });

  testWidgets('chooses Antigravity models, applies them when saved, and installs agy with progress', (tester) async {
    final backend = FakeBackend()..antigravityProblem = 'The Antigravity CLI (agy) was not found.';
    final app = await open(tester, backend);
    await tester.tap(nav(3));
    await settle(tester);
    expect(find.text('Antigravity'), findsWidgets);
    expect(find.text('跟随内核默认'), findsNWidgets(2));

    // When agy is missing, it can be installed from here while showing installer progress.
    final install = find.byKey(const ValueKey('install-antigravity'));
    await show(tester, install);
    expect(find.textContaining('Antigravity: The Antigravity CLI (agy) was not found.'), findsOneWidget);
    backend.installGate = Completer();
    backend.installProgress = 'Downloading Antigravity CLI… 42%';
    await tester.tap(install);
    await settle(tester);
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(find.text(backend.installProgress!), findsOneWidget);
    expect(find.descendant(of: install, matching: find.byType(CupertinoActivityIndicator)), findsOneWidget);
    backend.installGate!.complete();
    await settle(tester);
    expect(backend.installed, ['antigravity']);
    expect(find.textContaining('Antigravity 已安装'), findsOneWidget);
    expect(install, findsNothing);

    // Pick orchestrator and worker models; changes apply only when saved.
    Future<void> save() async {
      final saving = find.byKey(const ValueKey('save-models'));
      await show(tester, saving);
      await tester.tap(saving);
      await settle(tester);
    }

    await tester.tap(find.byKey(const ValueKey('model-评估与调度模型')));
    await settle(tester);
    await tester.tap(find.textContaining('Gemini 3.8 Flash (Low)'));
    await settle(tester);
    expect(find.text('antigravity/gemini-3.8-flash-low'), findsOneWidget);
    expect(backend.models['eval'], isNull);

    await tester.tap(find.byKey(const ValueKey('model-Worker 模型')));
    await settle(tester);
    await tester.tap(find.textContaining('Gemini 3.8 Pro (High)'));
    await settle(tester);
    expect(find.text('antigravity/gemini-3.8-pro-high'), findsOneWidget);

    await save();
    expect(backend.models, {
      'eval': {'provider': 'antigravity', 'model': 'gemini-3.8-flash-low'},
      'executor': {'provider': 'antigravity', 'model': 'gemini-3.8-pro-high'},
    });
    expect(find.text('已保存'), findsOneWidget);
    await app.close();
  });

  testWidgets('polls until Antigravity finishes listing its models', (tester) async {
    final backend = FakeBackend()..antigravityListing = true;
    final app = await open(tester, backend);
    await tester.tap(nav(3));
    await settle(tester);
    expect(find.text('正在读取模型列表…'), findsOneWidget);
    backend.antigravityListing = false;
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(find.text('正在读取模型列表…'), findsNothing);
    final workerModel = find.byKey(const ValueKey('model-Worker 模型'));
    await show(tester, workerModel);
    await tester.tap(workerModel);
    await settle(tester);
    await tester.tap(find.textContaining('Gemini 3.8 Flash (Low)'));
    await settle(tester);
    final saving = find.byKey(const ValueKey('save-models'));
    await show(tester, saving);
    await tester.tap(saving);
    await settle(tester);
    expect(backend.models['executor'], {'provider': 'antigravity', 'model': 'gemini-3.8-flash-low'});
    await app.close();
  });

  testWidgets('logs Antigravity in with a pasted code, shows the Google account, and logs out', (tester) async {
    final backend = FakeBackend();
    final app = await open(tester, backend);
    await tester.tap(nav(3));
    await settle(tester);

    // Logging in shows the link and passes back the pasted code.
    final login = find.byKey(const ValueKey('login-antigravity'));
    await show(tester, login);
    await tester.tap(login);
    await settle(tester);
    expect(find.text('https://auth.example/authorize?x=1'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('login-code')), ' code#state ');
    await tester.tap(find.byKey(const ValueKey('login-submit')));
    await settle(tester);
    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(backend.pasted, ['code#state']);
    expect(find.text('登录成功'), findsWidgets);
    expect(find.text('Google · me@example.com'), findsOneWidget);

    final logout = find.byKey(const ValueKey('logout-antigravity'));
    await show(tester, logout);
    await tester.tap(logout);
    await settle(tester);
    expect(find.text('已登出'), findsOneWidget);
    expect(find.text('未登录'), findsOneWidget);
    await app.close();
  });

  testWidgets('changes the general settings', (tester) async {
    final backend = FakeBackend();
    final app = await open(tester, backend);
    await tester.tap(nav(3));
    await settle(tester);
    // The pause applies at once.
    final pause = find.byType(CupertinoSwitch).first;
    await show(tester, pause);
    await tester.tap(pause);
    await settle(tester);
    expect(backend.general['paused'], true);
    await tester.pump(const Duration(seconds: 10));
    await settle(tester);
    expect(find.text('已暂停'), findsWidgets);

    // Recovery mode switch also applies immediately.
    final recoverySwitch = find.byKey(const ValueKey('recovery-mode-switch'));
    await show(tester, recoverySwitch);
    await tester.tap(recoverySwitch);
    await settle(tester);
    expect(backend.general['recoveryMode'], false);
    await tester.tap(recoverySwitch);
    await settle(tester);
    expect(backend.general['recoveryMode'], true);

    // Everything else is saved together.
    await show(tester, button('+').first);
    await tester.tap(button('+').first);
    await tester.pump();
    final blocked = find.widgetWithText(CupertinoTextField, 'docker shutdown');
    await show(tester, blocked);
    await tester.enterText(blocked, 'docker，kubectl  shutdown');
    await show(tester, find.text('自动受理'));
    // The segment, not its label, takes the tap.
    await tester.tap(find.text('自动受理'));
    await tester.pump();
    await show(tester, find.text('添加规则'));
    await tester.tap(find.text('添加规则'));
    await tester.pump();
    final names = find.widgetWithText(CupertinoTextField, '名称').last;
    await show(tester, names);
    await tester.enterText(names, '文档');
    final instructions = find.widgetWithText(CupertinoTextField, '说明').last;
    await show(tester, instructions);
    await tester.enterText(instructions, '被要求时修正文档错别字。');
    final save = find.widgetWithText(CupertinoButton, '保存').last;
    await show(tester, save);
    await tester.tap(save);
    await settle(tester);
    final executor = backend.general['executor'] as Map;
    expect(executor['maxWorkers'], 4);
    expect(executor['blockedCommands'], ['docker', 'kubectl', 'shutdown']);
    expect((backend.general['eval'] as Map)['mode'], 'auto');
    final rules = (backend.general['policy'] as Map)['rules'] as List;
    expect(rules.map((rule) => (rule['id'], rule['name'], rule['enabled'])), [('copy', 'Copy fixes', true), ('rule-2', '文档', true)]);
    expect(rules.last['instruction'], '被要求时修正文档错别字。');
    // Who may write is sent back as it came.
    expect((backend.general['policy'] as Map)['sources'], {
      'chat': {
        'allowed': [
          {'id': 'web:local'},
        ],
      },
    });
    expect(find.text('本应用'), findsOneWidget);
    await app.close();
  });

  testWidgets('binds WeChat by QR code and verification code', (tester) async {
    final backend = FakeBackend();
    final app = await open(tester, backend);
    await tester.tap(nav(3));
    await settle(tester);
    final connect = find.widgetWithText(CupertinoButton, '连接微信');
    await show(tester, connect);
    expect(find.text('未连接'), findsOneWidget);
    await tester.tap(connect);
    await settle(tester);
    expect(find.byType(QrView), findsOneWidget);
    expect(tester.widget<QrView>(find.byType(QrView)).content, 'weixin://fixture-bind');
    expect(find.text('等待扫码'), findsOneWidget);
    // The phone asks for a code: the page follows by itself.
    backend.wechat = {'state': 'verify', 'message': '输入手机微信显示的验证码。', 'qrContent': 'weixin://fixture-bind'};
    await tester.pump(const Duration(milliseconds: 1600));
    await settle(tester);
    expect(find.text('需要验证码'), findsOneWidget);
    final code = find.widgetWithText(CupertinoTextField, '验证码');
    await show(tester, code);
    await tester.enterText(code, '12');
    await tester.tap(find.widgetWithText(CupertinoButton, '提交'));
    await settle(tester);
    expect(find.text('验证码必须为数字'), findsOneWidget);
    await tester.enterText(code, '1234');
    await tester.tap(find.widgetWithText(CupertinoButton, '提交'));
    await settle(tester);
    expect(find.text('绑定账号: wechat:bound-user'), findsOneWidget);
    expect(find.byType(QrView), findsNothing);
    final disconnect = find.widgetWithText(CupertinoButton, '断开');
    await show(tester, disconnect);
    await tester.tap(disconnect);
    await settle(tester);
    expect(find.text('未连接'), findsOneWidget);
    await app.close();
  });

  testWidgets('speaks English where the system does, in dark appearance too', (tester) async {
    final backend = FakeBackend()..addWorker('t1', 'Train the model', {'stage': 'person', 'action': 'review'});
    final app = await open(tester, backend, locale: const Locale('en'), brightness: Brightness.dark);
    expect(find.text('Chat'), findsWidgets);
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.text('Start a conversation'), findsOneWidget);
    expect(find.text('Connected'), findsWidgets);
    await tester.tap(nav(1));
    await settle(tester);
    expect(find.text('Ready for review'), findsOneWidget);
    expect(find.text('1 active · 1 in all'), findsOneWidget);
    await app.close();
  });

  testWidgets('on a desktop waits for its own backend and says when another one runs', (tester) async {
    final backend = FakeBackend(token: 'made-by-the-app-0123456789');
    final host = FakeHost(isDesktop: true);
    final app = await open(tester, backend, host: host);
    expect(find.text('正在启动本机服务…'), findsWidgets);
    expect(find.byType(CupertinoActivityIndicator), findsOneWidget);
    host.backend.notifier.value = const BackendStatus(BackendPhase.running, port: 4321, token: 'made-by-the-app-0123456789');
    await settle(tester);
    expect(find.text('已连接'), findsWidgets);
    expect(find.text('开始对话'), findsOneWidget);
    host.backend.notifier.value = const BackendStatus(BackendPhase.alreadyRunning, message: 'Neo is already running on port 3082.');
    await settle(tester);
    expect(find.text('Neo 已在运行'), findsWidgets);
    expect(find.text('同一台电脑只能运行一个 Neo。请切换到已打开的窗口，或先退出正在运行的服务。'), findsOneWidget);
    // The connection can be pointed at a server instead.
    await tester.tap(nav(3));
    await settle(tester);
    await tester.tap(find.text('远程服务器'));
    await settle(tester);
    await tester.enterText(find.widgetWithText(CupertinoTextField, 'http://192.168.1.10:3082'), 'not an address!');
    await tester.tap(find.widgetWithText(CupertinoButton, '连接'));
    await settle(tester);
    expect(find.text('地址应形如 http://主机:端口'), findsOneWidget);
    await tester.enterText(find.widgetWithText(CupertinoTextField, 'http://192.168.1.10:3082'), 'backend.test');
    await tester.enterText(find.byType(CupertinoTextField).last, 'made-by-the-app-0123456789');
    await tester.tap(find.widgetWithText(CupertinoButton, '连接'));
    await settle(tester);
    expect((app.state.link, host.backend.stopped, host.prefs['mode']), (Link.online, true, 'remote'));
    await app.close();
  });

  testWidgets('stops active and failed tasks from task detail, and hides stop for completed or ended tasks', (tester) async {
    final backend = FakeBackend()
      ..addWorker(
        't-run',
        '执行子任务',
        {'stage': 'working'},
        streaming: true,
        background: [
          {'id': 'task_1', 'type': 'task', 'label': 'subagent', 'startedAt': '2026-05-01T09:00:00.000Z'},
          {'id': 'bg_1', 'type': 'bash', 'label': 'make train', 'startedAt': '2026-05-01T09:00:00.000Z'},
        ],
      )
      ..addWorker('t-fail', '异常失败任务', {'stage': 'person', 'action': 'failed'})
      ..addWorker('t-done', '已完成任务', {'stage': 'ended'}, outcome: 'completed')
      ..addWorker('t-ended', '已终止任务', {'stage': 'ended'}, outcome: 'stopped');
    final app = await open(tester, backend, bundledCjk: true);
    await tester.tap(nav(1));
    await settle(tester);

    final stopButton = find.byKey(const ValueKey('stop-worker'));

    // 1. Running task shows Stop button; cancelling dialog keeps it running; confirming marks it 已结束.
    await tester.tap(find.byKey(const ValueKey('worker-t-run')));
    await settle(tester);
    expect(stopButton, findsOneWidget);
    await tester.tap(stopButton);
    await settle(tester);
    for (final label in ['终止任务？', '取消', '终止']) {
      final drawn = tester.widget<RichText>(find.descendant(of: find.text(label), matching: find.byType(RichText)));
      expect(drawn.text.style?.fontFamilyFallback, contains(cjkFont), reason: label);
    }
    await tester.tap(find.text('取消'));
    await settle(tester);
    expect(backend.stopped, isEmpty);
    expect(stopButton, findsOneWidget);

    await tester.tap(stopButton);
    await settle(tester);
    await tester.tap(find.text('终止'));
    await settle(tester);
    expect(backend.stopped, ['t-run']);
    expect(stopButton, findsNothing);
    expect(find.text('已结束'), findsWidgets);
    expect(find.text('make train'), findsNothing);

    // 2. Failed task can also be terminated and becomes 已结束 without the Stop button afterwards.
    await tester.tap(find.byKey(const ValueKey('worker-t-fail')));
    await settle(tester);
    expect(stopButton, findsOneWidget);
    await tester.tap(stopButton);
    await settle(tester);
    await tester.tap(find.text('终止'));
    await settle(tester);
    expect(backend.stopped, ['t-run', 't-fail']);
    expect(stopButton, findsNothing);

    // 3. Completed and already-ended tasks cannot be terminated again.
    await tester.tap(find.byKey(const ValueKey('worker-t-done')));
    await settle(tester);
    expect(stopButton, findsNothing);
    await tester.tap(find.byKey(const ValueKey('worker-t-ended')));
    await settle(tester);
    expect(stopButton, findsNothing);

    await app.close();
  });
}
