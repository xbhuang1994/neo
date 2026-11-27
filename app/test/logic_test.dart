import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/src/api/client.dart';
import 'package:neo_agent/src/api/models.dart';
import 'package:neo_agent/src/l10n/strings.dart';
import 'package:neo_agent/src/platform/host.dart';
import 'package:neo_agent/src/state/app_state.dart';
import 'package:neo_agent/src/ui/format.dart';
import 'package:neo_agent/src/ui/theme.dart';
import 'package:flutter/widgets.dart';

import 'fake_backend.dart';

void main() {
  group('message formatting', () {
    test('shows JSON indented, fenced blocks as code, settings-like lines as code, and the rest as text', () {
      final json = formatMessage(' {"a":1,"b":[true,null]} ');
      expect(json, hasLength(1));
      expect((json.single as CodeSegment).language, 'JSON');
      expect(json.single.text, '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
      // Broken JSON is not swallowed.
      expect(formatMessage('{"a":').single, isA<TextSegment>());

      final fenced = formatMessage('Run this:\n```bash\nmake test\n```\nThen:\n```\nplain\n```');
      expect(fenced.map((segment) => segment.runtimeType), [TextSegment, CodeSegment, TextSegment, CodeSegment]);
      expect([fenced[0].text, fenced[1].text, fenced[2].text, fenced[3].text], ['Run this:', 'make test', 'Then:', 'plain']);
      expect([(fenced[1] as CodeSegment).language, (fenced[3] as CodeSegment).language], ['bash', 'code']);

      expect((formatMessage('name = neo\nport = 3082').single as CodeSegment).language, 'config');
      expect(formatMessage('name = neo').single, isA<TextSegment>());
      expect(formatMessage('Hello there.\nAll done.').single, isA<TextSegment>());
    });

    test('folds long messages and strips attachment blocks from what a person wrote', () {
      expect(isLong('x' * 700), isFalse);
      expect(isLong('x' * 701), isTrue);
      expect(isLong(List.filled(12, 'line').join('\n')), isFalse);
      expect(isLong(List.filled(13, 'line').join('\n')), isTrue);
      const text =
          'See these.\n\n<attachment name="shot.png" mediaType="image/png" path="/d/1-shot.png">\nFile saved at the path above.\n</attachment>\n\n<attachment name="notes.md">\n# Notes\n</attachment>';
      expect(withoutAttachments(text), 'See these.');
      expect(withoutAttachments('请查看附件。\n\n<attachment name="a.bin" mediaType="x" path="/p">\nsaved\n</attachment>'), '');
      expect(withoutAttachments('No files, but <attachment> is mentioned.'), 'No files, but <attachment> is mentioned.');
    });

    test('writes times, sizes and media types for people', () {
      final now = DateTime(2026, 5, 1, 12);
      expect(clockTime(DateTime(2026, 5, 1, 9, 5), now: now), '09:05');
      expect(clockTime(DateTime(2026, 4, 30, 23, 59), now: now), '4/30 23:59');
      expect([byteSize(812), byteSize(1434), byteSize(5 * 1024 * 1024)], ['812 B', '1.4 KB', '5.0 MB']);
      expect([mediaTypeOf('a.PNG'), mediaTypeOf('notes.md'), mediaTypeOf('archive'), mediaTypeOf('x.bin')], ['image/png', 'text/markdown', '', '']);
    });
  });

  group('connection', () {
    test('reads a server address as typed', () {
      expect(parseServerAddress('192.168.1.10:3082').toString(), 'http://192.168.1.10:3082');
      expect(parseServerAddress(' https://neo.example.com/app/ ').toString(), 'https://neo.example.com');
      expect(parseServerAddress('http://localhost:3082/').toString(), 'http://localhost:3082');
      expect([parseServerAddress(''), parseServerAddress('ftp://x'), parseServerAddress('http://'), parseServerAddress('not an address!')], [null, null, null, null]);
      expect(parseServerAddress('[::1]:3082').toString(), 'http://[::1]:3082');
    });

    test('makes message ids the backend takes, each one new', () {
      final ids = {for (var i = 0; i < 50; i++) newMessageId()};
      expect(ids, hasLength(50));
      expect(ids.every((id) => RegExp(r'^web:[0-9a-f]{24}$').hasMatch(id)), isTrue);
    });
  });

  group('api client', () {
    test('sends the token, reads errors in the backend\'s words, and tells no answer from a refusal', () async {
      final backend = FakeBackend(token: 'secret-token-0123456789');
      final api = backend.api();
      expect((await api.health()).version, '0.2.0');
      expect(backend.calls, ['GET /api/health']);

      final anonymous = backend.api('');
      await expectLater(anonymous.messages(), throwsA(isA<ApiException>().having((e) => e.unauthorized, 'unauthorized', isTrue).having((e) => e.message, 'message', 'A valid access token is required')));
      await expectLater(api.worker('missing'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404).having((e) => e.message, 'message', 'Worker not found')));
      backend.down = true;
      await expectLater(api.messages(), throwsA(isA<ApiException>().having((e) => e.unreachable, 'unreachable', isTrue)));
    });

    test('carries a chat message with its files and id', () async {
      final backend = FakeBackend();
      final api = backend.api();
      await api.chat('Hello', [OutgoingFile('a.txt', 'text/plain', utf8.encode('hi'))], 'web:abc');
      expect(backend.chats.single, {
        'text': 'Hello',
        'messageId': 'web:abc',
        'attachments': [
          {'name': 'a.txt', 'mediaType': 'text/plain', 'data': 'aGk='},
        ],
      });
      await api.chat('No files', [], 'web:def');
      expect(backend.chats.last.containsKey('attachments'), isFalse);
      final (messages, raw) = await api.messages();
      expect(messages.map((message) => (message.fromUser, message.text)), [(true, 'Hello'), (false, 'On it.'), (true, 'No files'), (false, 'On it.')]);
      expect(jsonDecode(raw), hasLength(4));
    });
  });

  group('models', () {
    test('reads a worker with its stage, report and jobs', () {
      final worker = Worker.fromJson({
        'ticketId': 't1',
        'title': 'Train',
        'stage': {'stage': 'person', 'action': 'answer'},
        'session': {'loaded': true, 'streaming': false},
        'background': [
          {'id': 'bg_1', 'type': 'bash', 'label': 'make train', 'startedAt': '2026-05-01T09:00:00.000Z'},
        ],
        'assignment': {'id': 'a1', 'state': 'running'},
        'progress': {'state': 'progress', 'summary': 'Training.', 'at': '2026-05-01T09:10:00.000Z'},
        'attention': {'id': 'q', 'question': 'Which dataset?'},
        'pendingInputs': 2,
        'recent': [
          {'id': 3, 'role': 'assistant', 'text': 'Looking.', 'at': 1777626600000},
        ],
      });
      expect((worker.stage, worker.action, worker.active, worker.tone), ('person', 'answer', true, WorkerTone.person));
      expect((worker.question, worker.pendingInputs, worker.background.single.label, worker.report?.state), ('Which dataset?', 2, 'make train', 'progress'));
      expect(worker.recent.single.at, DateTime.fromMillisecondsSinceEpoch(1777626600000));
      // Missing parts read as nothing rather than failing.
      final bare = Worker.fromJson({'ticketId': 't2', 'title': 'x'});
      expect((bare.stage, bare.report, bare.background.length, bare.tone), ('working', null, 0, WorkerTone.working));
      expect(Worker.fromJson({'stage': {'stage': 'ended'}, 'outcome': 'completed'}).tone, WorkerTone.ended);
      expect(Worker.fromJson({'stage': {'stage': 'idle'}, 'session': {'streaming': true}}).tone, WorkerTone.working);
    });

    test('reads a message with images and files, and survives a broken image', () {
      final message = ChatMessage.fromJson({
        'id': 4,
        'role': 'user',
        'text': 'See',
        'at': 1777626600000,
        'source': 'wechat',
        'images': [
          {'name': 'ok.png', 'mediaType': 'image/png', 'data': 'iVBORw=='},
          {'name': 'bad.png', 'mediaType': 'image/png', 'data': '@@'},
        ],
        'files': [
          {'name': 'notes.md', 'mediaType': 'text/markdown', 'kind': 'text'},
        ],
      });
      expect((message.fromUser, message.source, message.images.single.name, message.files.single.kind), (true, 'wechat', 'ok.png', 'text'));
      expect(message.images.single.bytes, [0x89, 0x50, 0x4E, 0x47]);
    });

    test('sends general settings back block by block', () {
      final settings = GeneralSettings.fromJson({
        'paused': true,
        'recoveryMode': false,
        'eval': {'mode': 'auto', 'timeoutSeconds': 60},
        'executor': {'maxWorkers': 5, 'directory': '/work', 'prepare': 'git clone x', 'prepareShell': 'pwsh', 'blockedCommands': ['docker']},
        'policy': {
          'rules': [
            {'id': 'a', 'name': 'A', 'enabled': false, 'instruction': 'Do A.'},
          ],
          'sources': {
            'chat': {
              'allowed': [
                {'id': 'web:local'},
                {'id': 'wechat:u1'},
              ],
            },
          },
        },
        'limits': {'maxWorkers': [1, 16]},
      });
      expect((settings.paused, settings.recoveryMode, settings.evalMode, settings.maxWorkers, settings.maxWorkersRange, settings.evalTimeoutRange), (true, false, 'auto', 5, (1, 16), (30, 600)));
      expect(GeneralSettings.fromJson(const {}).recoveryMode, true);
      expect(settings.chatSenders, ['web:local', 'wechat:u1']);
      settings
        ..prepareShell = ' '
        ..rules.single.enabled = true;
      expect(settings.executorJson(), {'maxWorkers': 5, 'directory': '/work', 'prepare': 'git clone x', 'blockedCommands': ['docker']});
      expect(settings.evalJson(), {'mode': 'auto', 'timeoutSeconds': 60});
      expect((settings.policyJson()['rules'] as List).single, {'id': 'a', 'name': 'A', 'enabled': true, 'instruction': 'Do A.'});
      expect(RoleModel.fromJson({'provider': 'antigravity', 'model': 'm'})?.toJson(), {'provider': 'antigravity', 'model': 'm'});
      expect(RoleModel.fromJson(null), isNull);
      expect(const RoleModel('antigravity', 'm'), const RoleModel('antigravity', 'm'));
    });
  });

  group('state', () {
    test('follows the backend: connects, notices changes, and says what is in the way', () async {
      final backend = FakeBackend(token: 'secret-token-0123456789');
      final host = FakeHost(pageOrigin: Uri.parse('http://backend.test'));
      final state = stateOver(backend, host: host, pollEvery: const Duration(hours: 1));
      var notified = 0;
      state.addListener(() => notified++);
      await state.start();
      await state.refresh();
      // The page's server wants a token the browser has not stored yet.
      expect((state.link, state.config.local, state.config.url), (Link.tokenNeeded, false, 'http://backend.test'));
      await state.applyConnection(const ConnectionConfig(local: false, url: 'http://backend.test', token: 'secret-token-0123456789'));
      await state.refresh();
      expect((state.link, state.health?.version, host.prefs['token']), (Link.online, '0.2.0', 'secret-token-0123456789'));

      backend.say('user', 'Hello');
      backend.addWorker('t1', 'Train', {'stage': 'working'}, streaming: true, recent: [{'id': 1, 'role': 'assistant', 'text': 'Looking.'}]);
      await state.refresh();
      expect((state.messages.single.text, state.workers.single.title, state.activeWorkers), ('Hello', 'Train', 1));
      // Nothing new, nothing announced.
      final before = notified;
      await state.refresh();
      expect(notified, before);

      state.selectWorker('t1');
      await state.refresh();
      expect(state.detail?.recent.single.text, 'Looking.');
      state.selectWorker('gone');
      await state.refresh();
      expect(state.detail, isNull);

      backend.down = true;
      await state.refresh();
      expect((state.link, state.messages.single.text), (Link.offline, 'Hello'), reason: 'what was last known stays on screen');
      backend.down = false;
      await state.refresh();
      expect(state.link, Link.online);
      state.dispose();
    });

    test('on a desktop starts the local backend and follows its phases', () async {
      final backend = FakeBackend(token: 'made-by-the-app-0123456789');
      final host = FakeHost(isDesktop: true);
      final state = stateOver(backend, host: host, pollEvery: const Duration(hours: 1));
      await state.start();
      expect((state.link, host.backend.starts, state.client), (Link.starting, 1, null));
      host.backend.notifier.value = const BackendStatus(BackendPhase.running, port: 4000, token: 'made-by-the-app-0123456789');
      await state.refresh();
      expect((state.link, state.client?.base.toString(), state.client?.token), (Link.online, 'http://127.0.0.1:4000', 'made-by-the-app-0123456789'));
      host.backend.notifier.value = const BackendStatus(BackendPhase.alreadyRunning, message: 'Neo is already running on port 3082.');
      expect((state.link, state.linkDetail, state.client), (Link.alreadyRunning, 'Neo is already running on port 3082.', null));
      host.backend.notifier.value = const BackendStatus(BackendPhase.failed, message: 'neo-agent was not found beside the app');
      expect(state.link, Link.backendFailed);
      state.retry();
      expect(host.backend.starts, 2);
      // A remote server instead: the local backend is stopped.
      await state.applyConnection(const ConnectionConfig(local: false, url: 'backend.test', token: 'made-by-the-app-0123456789'));
      await state.refresh();
      expect((host.backend.stopped, state.link, host.prefs['mode']), (true, Link.online, 'remote'));
      state.dispose();
    });
  });

  test('has every text in both languages', () {
    expect(Strings.of(const Locale('zh', 'CN')), isA<ZhStrings>());
    expect(Strings.of(const Locale('en', 'US')), isA<EnStrings>());
    expect(Strings.of(const Locale('fr')), isA<EnStrings>());
    const zh = ZhStrings(), en = EnStrings();
    expect([zh.chat, en.chat, zh.workersSummary(2, 5), en.workersSummary(2, 5)], ['对话', 'Chat', '2 个进行中 · 共 5 个', '2 active · 5 in all']);
    expect([zh.reportState('ready'), en.reportState('ready'), zh.reportState('other'), zh.component('kernel'), en.component('x')], ['已就绪', 'ready', 'other', '执行内核', 'x']);
    expect(zh.appName, en.appName);
  });

  group('web build', () {
    test('pins CanvasKit and font fallbacks to local origins without remote URLs', () {
      final bootstrap = File('web/flutter_bootstrap.js').readAsStringSync();
      expect(bootstrap, contains('{{flutter_js}}'));
      expect(bootstrap, contains('{{flutter_build_config}}'));
      expect(bootstrap, contains('canvasKitBaseUrl'));
      expect(bootstrap, contains('fontFallbackBaseUrl'));
      // Emoji slices stay self-hosted locally and load on demand via FontFallbackManager (never blocking FontManifest startup).
      expect(bootstrap, isNot(contains('assets/FontManifest.json')));
      expect(bootstrap, isNot(contains('http://')));
      expect(bootstrap, isNot(contains('https://')));

      final webTheme = appTheme(bundledCjk: true).textTheme.textStyle.fontFamilyFallback;
      expect(webTheme, equals(webFallbackFonts));
      expect(webTheme, containsAll([cjkFont, ...emojiFonts, variationSelectorFont]));
      expect(appTheme(bundledCjk: false).textTheme.textStyle.fontFamilyFallback, isNull);

      final referenced = RegExp(r"'([^']+\.(?:woff2|ttf))'")
          .allMatches(bootstrap)
          .map((match) => match.group(1)!)
          .toSet();
      expect(referenced.length, 22);
      for (final rel in referenced) {
        final file = File('web/fonts/fallback/$rel');
        expect(file.existsSync(), isTrue, reason: 'Missing local fallback font: $rel');
        expect(file.lengthSync(), greaterThan(0), reason: 'Empty local fallback font: $rel');
      }

      for (var i = 0; i < 10; i++) {
        expect(
          referenced.where((path) => path.startsWith('notocoloremoji/v39/') && path.endsWith('.$i.woff2')),
          hasLength(1),
        );
      }
      expect(referenced.where((path) => path.startsWith('notosanssymbols/')), hasLength(1));
      expect(referenced.where((path) => path.startsWith('notosanssymbols2/')), hasLength(6));
      expect(referenced.where((path) => path.startsWith('notosansmath/')), hasLength(1));
      expect(referenced.where((path) => path.startsWith('notosans/')), hasLength(1));
      expect(referenced.where((path) => path.startsWith('roboto/')), hasLength(1));
      expect(referenced.where((path) => path.startsWith('notosanssc/')), hasLength(1));
      expect(referenced, contains('_empty.ttf'));

      final variationSelectors = File('fonts/VariationSelectors.ttf');
      expect(variationSelectors.existsSync(), isTrue);
      expect(variationSelectors.lengthSync(), greaterThan(0));
    });
  });

  group('performance invariants', () {
    test('formatMessage caches parsed segments and isLong matches edge cases', () {
      const sample = 'Run:\n```dart\nprint(1);\n```\nDone.';
      final first = formatMessage(sample);
      final second = formatMessage(sample);
      expect(identical(first, second), isTrue);
      expect(isLong(List.filled(12, 'a').join('\n')), isFalse);
      expect(isLong(List.filled(13, 'a').join('\n')), isTrue);
    });

    test('ChatMessage.parseList reuses unchanged messages and image buffers', () {
      final raw1 = [
        {
          'id': 1,
          'role': 'user',
          'text': 'See shot',
          'at': 1777626600000,
          'source': 'web-panel',
          'images': [
            {'name': 'shot.png', 'mediaType': 'image/png', 'data': 'iVBORw=='},
          ],
        },
      ];
      final list1 = ChatMessage.parseList(raw1);
      final raw2 = [
        ...raw1,
        {'id': 2, 'role': 'assistant', 'text': 'Done.', 'at': 1777626660000, 'source': 'chat-reply'},
      ];
      final list2 = ChatMessage.parseList(raw2, previous: list1);
      expect(list2, hasLength(2));
      expect(identical(list2[0], list1[0]), isTrue);
      expect(identical(list2[0].images.single.bytes, list1[0].images.single.bytes), isTrue);
    });

    test('AppState bumps only changed aspect revisions and pauses polling when hidden', () async {
      final backend = FakeBackend();
      final state = stateOver(backend, pollEvery: const Duration(milliseconds: 50));
      await state.start();
      await state.refresh();

      final msgRev0 = state.messagesRev;
      final actRev0 = state.activityRev;
      final devRev0 = state.devicesRev;

      // Only activity changes -> only activityRev advances.
      backend.activity = {'router': true, 'workers': <Map<String, dynamic>>[]};
      await state.refresh();
      expect(state.activityRev, greaterThan(actRev0));
      expect(state.messagesRev, msgRev0);
      expect(state.devicesRev, devRev0);

      // Backgrounding pauses periodic polling; foregrounding resumes and refreshes.
      state.setForeground(false);
      final callsWhenHidden = backend.calls.length;
      await Future<void>.delayed(const Duration(milliseconds: 160));
      expect(backend.calls.length, callsWhenHidden);

      state.setForeground(true);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(backend.calls.length, greaterThan(callsWhenHidden));

      state.dispose();
    });

    for (final supportPoll in [true, false]) {
      test('paginates messages and workers in 20-item pages, merges live updates, handles errors, and resets (poll=$supportPoll)', () async {
        final backend = FakeBackend()..supportPoll = supportPoll;
        for (var i = 0; i < 45; i++) {
          backend.say(i.isEven ? 'user' : 'assistant', 'Message #$i');
        }
        // 2 active + 43 ended workers.
        backend.addWorker('w-active-2', 'Active 2', {'stage': 'working'}, streaming: true);
        backend.addWorker('w-active-1', 'Active 1', {'stage': 'person', 'action': 'answer'});
        for (var i = 43; i >= 1; i--) {
          backend.addWorker('w-ended-$i', 'Ended $i', {'stage': 'ended'}, outcome: 'completed');
        }

        final state = stateOver(backend, pollEvery: const Duration(hours: 1));
        await state.start();
        await state.refresh();

        // Initial load fetches only the latest 20 messages and top 20 workers with accurate totals.
        expect(state.messages, hasLength(20));
        expect(state.messages.first.id, 25);
        expect(state.messages.last.id, 44);
        expect(state.messagesHasMore, isTrue);
        expect(state.messagesTotal, 45);
        expect(state.remainingOlderMessages, 25);

        expect(state.workers, hasLength(20));
        expect(state.workers.first.ticketId, 'w-active-2');
        expect(state.workers.last.ticketId, 'w-ended-26');
        expect(state.workersHasMore, isTrue);
        expect(state.workersTotal, 45);
        expect(state.activeWorkers, 2);
        expect(state.remainingMoreWorkers, 25);

        // Load earlier messages: transient error surfaces cleanly and retry succeeds.
        backend.messagesPageError = 'temporary history error';
        await state.loadMoreMessages();
        expect(state.loadMoreMessagesError, 'temporary history error');
        expect(state.messages, hasLength(20));

        await state.loadMoreMessages();
        expect(state.loadMoreMessagesError, isNull);
        expect(state.messages, hasLength(40));
        expect(state.messages.first.id, 5);
        expect(state.messages.last.id, 44);
        expect(state.messagesHasMore, isTrue);
        expect(state.remainingOlderMessages, 5);

        // Live new message arrives via poll and merges without discarding loaded older messages.
        backend.say('assistant', 'Live reply #45');
        await state.refresh();
        expect(state.messages, hasLength(41));
        expect(state.messages.first.id, 5);
        expect(state.messages.last.id, 45);
        expect(state.messagesHasMore, isTrue);
        expect(state.messagesTotal, 46);

        // Load final page of older messages.
        await state.loadMoreMessages();
        expect(state.messages, hasLength(46));
        expect(state.messages.first.id, 0);
        expect(state.messages.last.id, 45);
        expect(state.messagesHasMore, isFalse);
        expect(state.remainingOlderMessages, 0);

        // Load more workers: transient error + retry.
        backend.workersPageError = 'temporary worker error';
        await state.loadMoreWorkers();
        expect(state.loadMoreWorkersError, 'temporary worker error');
        expect(state.workers, hasLength(20));

        await state.loadMoreWorkers();
        expect(state.loadMoreWorkersError, isNull);
        expect(state.workers, hasLength(40));
        expect(state.workers.last.ticketId, 'w-ended-6');
        expect(state.workersHasMore, isTrue);

        // New active worker appears at top; poll merges without duplicating or dropping loaded tail.
        backend.workers.insert(0, {
          'ticketId': 'w-active-3',
          'title': 'Active 3',
          'stage': {'stage': 'working'},
          'outcome': null,
          'updatedAt': '2026-05-01T10:00:00.000Z',
          'session': {'loaded': true, 'streaming': true},
          'background': <dynamic>[],
          'assignment': {'id': 'a-3', 'state': 'running'},
          'pendingInputs': 0,
        });
        await state.refresh();
        expect(state.workers, hasLength(41));
        expect(state.workers.first.ticketId, 'w-active-3');
        expect(state.workers.last.ticketId, 'w-ended-6');
        expect(state.activeWorkers, 3);
        expect(state.workersTotal, 46);
        expect(state.workersHasMore, isTrue);

        // Load remaining workers.
        await state.loadMoreWorkers();
        expect(state.workers, hasLength(46));
        expect(state.workers.last.ticketId, 'w-ended-1');
        expect(state.workersHasMore, isFalse);

        // Resetting conversation clears history and pagination state.
        await state.resetConversation();
        expect(state.messages, isEmpty);
        expect(state.messagesHasMore, isFalse);
        expect(state.messagesTotal, 0);

        state.dispose();
      });
    }

    test('stays backward-compatible with older backends that ignore pagination parameters', () async {
      final backend = FakeBackend()..legacyPagination = true;
      for (var i = 0; i < 25; i++) {
        backend.say('user', 'Legacy msg $i');
        backend.addWorker('legacy-$i', 'Legacy worker $i', {'stage': i == 0 ? 'working' : 'ended'}, outcome: i == 0 ? null : 'completed');
      }
      final state = stateOver(backend, pollEvery: const Duration(hours: 1));
      await state.start();
      await state.refresh();
      expect(state.messages, hasLength(25));
      expect(state.messagesHasMore, isFalse);
      expect(state.messagesTotal, 25);
      expect(state.workers, hasLength(25));
      expect(state.workersHasMore, isFalse);
      expect(state.workersTotal, 25);
      expect(state.activeWorkers, 1);
      state.dispose();
    });
  });
}
