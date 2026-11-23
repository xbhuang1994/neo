@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/src/api/client.dart';
import 'package:neo_agent/src/platform/host.dart';
import 'package:neo_agent/src/platform/host_io.dart';

/// Wait until the backend is in [phase], or fail after a while.
Future<BackendStatus> reach(Sidecar sidecar, BackendPhase phase, {bool Function(BackendStatus status)? and}) async {
  final done = Completer<BackendStatus>();
  void check() {
    final status = sidecar.status.value;
    if (status.phase == phase && (and == null || and(status)) && !done.isCompleted) done.complete(status);
  }

  sidecar.status.addListener(check);
  check();
  try {
    return await done.future.timeout(const Duration(seconds: 20), onTimeout: () => fail('the backend did not reach $phase; it is ${sidecar.status.value.phase}: ${sidecar.status.value.message}'));
  } finally {
    sidecar.status.removeListener(check);
  }
}

/// A program that stands in for the backend.
String script(Directory dir, String name, String body) {
  final file = File('${dir.path}/$name')..writeAsStringSync('#!/bin/sh\n$body\n');
  Process.runSync('chmod', ['+x', file.path]);
  return file.path;
}

void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('neo-app-test'));
  tearDown(() => dir.deleteSync(recursive: true));

  test('finds the backend where it is named, then beside the app, then on the path', () {
    final files = <String>{'/Applications/Neo.app/Contents/Helpers/neo-agent', '/opt/neo/neo-agent', '/usr/local/bin/neo-agent', '/custom/neo-agent'};
    String? find(String executable, Map<String, String> environment) => findBackend(executable: executable, environment: environment, exists: files.contains);
    expect(find('/Applications/Neo.app/Contents/MacOS/Neo', {'PATH': '/usr/bin:/usr/local/bin'}), '/Applications/Neo.app/Contents/Helpers/neo-agent');
    expect(find('/opt/neo/neo_agent', {'PATH': '/usr/bin:/usr/local/bin'}), '/opt/neo/neo-agent');
    expect(find('/elsewhere/bin/app', {'PATH': '/usr/bin:/usr/local/bin'}), '/usr/local/bin/neo-agent');
    expect(find('/elsewhere/bin/app', {'PATH': '/usr/bin'}), isNull);
    // A name that is given wins, and a wrong one is not papered over.
    expect(find('/opt/neo/neo_agent', {'NEO_AGENT_BIN': '/custom/neo-agent'}), '/custom/neo-agent');
    expect(find('/opt/neo/neo_agent', {'NEO_AGENT_BIN': '/missing/neo-agent'}), isNull);
  }, skip: Platform.isWindows);

  test('gives the backend the folders where people install tools', () {
    final path = backendPath({'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': '/Users/me'}).split(':');
    expect(path.take(3), ['/usr/bin', '/bin', '/usr/local/bin']);
    expect(path, containsAll(['/opt/homebrew/bin', '/Users/me/.local/bin', '/Users/me/.bun/bin']));
    expect(path.where((entry) => entry == '/usr/local/bin'), hasLength(1));
  }, skip: Platform.isWindows);

  test('starts the backend, gives it a token, and ends it by closing its input', () async {
    final log = '${dir.path}/log';
    final program = script(dir, 'backend', 'read token\necho "\$token \$*" > "$log"\necho "not the line"\necho \'{"port": 4567, "pid": 1}\'\ncat > /dev/null\necho ended >> "$log"');
    final sidecar = Sidecar(program: program)..start();
    final running = await reach(sidecar, BackendPhase.running);
    expect(running.port, 4567);
    expect(running.token, matches(RegExp(r'^[0-9a-f]{64}$')));
    final started = File(log).readAsStringSync().trim();
    expect(started, '${running.token} desktop-sidecar --port 0 --token-stdin');
    await sidecar.stop();
    expect(File(log).readAsLinesSync().last, 'ended', reason: 'it ended by itself when its input closed');
  }, skip: Platform.isWindows);

  test('says when another instance runs, and starts one that ended by itself again', () async {
    final already = Sidecar(program: script(dir, 'already', 'read token\necho "Neo is already running on port 3082." >&2\nexit 3'))..start();
    final refused = await reach(already, BackendPhase.alreadyRunning);
    expect(refused.message, 'Neo is already running on port 3082.');
    await already.stop();

    // The first run fails; the one after it listens.
    final counter = '${dir.path}/runs';
    final flaky = Sidecar(
      program: script(dir, 'flaky', 'read token\nif [ ! -f "$counter" ]; then touch "$counter"; echo "Cannot open the database" >&2; exit 1; fi\necho \'{"port": 5000}\'\ncat > /dev/null'),
    )..start();
    final restarting = await reach(flaky, BackendPhase.starting, and: (status) => status.message != null);
    expect(restarting.message, 'Cannot open the database');
    expect((await reach(flaky, BackendPhase.running)).port, 5000);
    await flaky.stop();

    final missing = Sidecar(program: '${dir.path}/nothing-here')..start();
    expect((await reach(missing, BackendPhase.failed)).message, isNotEmpty);
  }, skip: Platform.isWindows);

  test('keeps its settings, and lets only one app run', () async {
    final first = DesktopHost(folder: '${dir.path}/app');
    expect(await first.readPrefs(), isEmpty);
    await first.writePrefs({'mode': 'remote', 'url': 'http://server:3082', 'token': 'secret'});
    expect(await DesktopHost(folder: '${dir.path}/app').readPrefs(), {'mode': 'remote', 'url': 'http://server:3082', 'token': 'secret'});
    File('${dir.path}/app/app.json').writeAsStringSync('not json');
    expect(await first.readPrefs(), isEmpty);

    var asked = 0;
    expect(await first.claimSingleInstance(() => asked++), isTrue);
    // A second app finds the first, asks it to the front, and is told to end.
    final second = DesktopHost(folder: '${dir.path}/app');
    expect(await second.claimSingleInstance(() => fail('the second app is not the one asked')), isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(asked, 1);
    // An app with its own folder is another user's: it runs.
    expect(await DesktopHost(folder: '${dir.path}/other').claimSingleInstance(() {}), isTrue);
    // A note left by an app that is gone does not keep the next one out.
    File('${dir.path}/stale/app-instance.json')
      ..createSync(recursive: true)
      ..writeAsStringSync('{"port": 9, "pid": 1}');
    expect(await DesktopHost(folder: '${dir.path}/stale').claimSingleInstance(() {}), isTrue);
  });

  test('runs the real backend and talks to it', () async {
    final program = File('../backend/dist/neo-agent');
    if (!program.existsSync()) {
      markTestSkipped('build the backend first: cd backend && bun run build:agent');
      return;
    }
    final environment = {
      ...Platform.environment,
      'NEO_DATA_DIR': '${dir.path}/data',
      'NEO_RUNTIME_DIR': '${dir.path}/run',
      'NEO_AGY_BIN': '${dir.path}/none',
    };
    // The app passes nothing but the search path; the rest of this is the test's own isolation.
    final wrapper = script(dir, 'neo-agent', [for (final name in ['NEO_DATA_DIR', 'NEO_RUNTIME_DIR', 'NEO_AGY_BIN']) 'export $name="${environment[name]}"', 'exec "${program.absolute.path}" "\$@"'].join('\n'));
    final sidecar = Sidecar(program: wrapper)..start();
    final running = await reach(sidecar, BackendPhase.running);
    final api = ApiClient(Uri.parse('http://127.0.0.1:${running.port}'), token: running.token);
    final health = await api.health();
    expect((health.ready, health.kernelProblem != null), (true, true), reason: 'it runs, and says that no kernel is installed here');
    expect((await api.messages()).$1, isEmpty);
    expect((await api.general()).maxWorkers, 3);
    // Without the token the app made, nobody else on this computer gets in.
    await expectLater(ApiClient(api.base).messages(), throwsA(isA<ApiException>().having((error) => error.unauthorized, 'unauthorized', isTrue)));
    // A second app's backend is refused while this one runs.
    final second = Sidecar(program: wrapper)..start();
    expect((await reach(second, BackendPhase.alreadyRunning)).message, contains('already running on port ${running.port}'));
    await second.stop();
    api.close();
    await sidecar.stop();
    await expectLater(ApiClient(api.base, token: running.token).health(), throwsA(isA<ApiException>().having((error) => error.unreachable, 'unreachable', isTrue)));
  }, skip: Platform.isWindows, timeout: const Timeout(Duration(seconds: 60)));
}
