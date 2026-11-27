import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/main.dart';
import 'package:neo_agent/src/api/client.dart';
import 'package:neo_agent/src/api/models.dart';
import 'package:neo_agent/src/qr/qr_view.dart';
import 'package:neo_agent/src/state/app_state.dart';
import 'package:neo_agent/src/ui/device_enroll_sheet.dart';
import 'package:neo_agent/src/ui/settings_page.dart' show ActionButton;
import 'package:neo_agent/src/ui/theme.dart' show cjkFont;
import 'package:neo_agent/src/ui/widgets.dart' show Pill;

import 'fake_backend.dart';

const wide = Size(1100, 820);
const narrow = Size(420, 820);

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 14; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

class Running {
  Running(this.tester, this.state);

  final WidgetTester tester;
  final AppState state;

  Future<void> close() async {
    await tester.pumpWidget(const SizedBox());
    state.dispose();
    await tester.pump(const Duration(milliseconds: 10));
  }
}

Future<Running> open(
  WidgetTester tester,
  FakeBackend backend, {
  Size size = wide,
  Locale locale = const Locale('zh'),
  Brightness? brightness,
  bool bundledCjk = false,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final state = stateOver(backend);
  await state.start();
  await tester.pumpWidget(NeoAgentApp(state: state, locale: locale, brightness: brightness, bundledCjk: bundledCjk));
  await settle(tester);
  return Running(tester, state);
}

Future<void> show(WidgetTester tester, Finder finder) async {
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pump();
}

Finder nav(int index) => find.byKey(ValueKey('nav-$index'));

void main() {
  group('device models & helpers', () {
    test('parses config, twin, approval, enrollment, ping, and mcu install responses safely', () {
      final overview = DevicesOverview.fromJson({
        'config': {
          'enabled': true,
          'configured': true,
          'clusterId': 'personal',
          'masterNodeId': 'master-1',
          'relayUrl': 'https://neo.1inch.cn:18443',
          'hasRelaySecret': true,
          'hasClusterSecret': true,
          'hasToken': true,
          'hasE2eKey': true,
          'canMintTokens': true,
          'relayState': 'connected',
          'localRelayDetected': true,
          'defaultRelayUrl': 'https://neo.1inch.cn:18443',
          'agentVersion': '0.9.1',
        },
        'devices': [
          {
            'deviceId': 'edge-pi-01',
            'clusterId': 'personal',
            'tier': 'os',
            'status': 'online',
            'route': 'p2p',
            'agentVersion': '0.9.2',
            'publicIp': '113.87.160.22',
            'location': '中国 广东 深圳',
            'manifest': {
              'device_id': 'edge-pi-01',
              'tier': 'os',
              'agent_version': '0.9.2',
              'os': 'linux',
              'arch': 'arm64',
              'hostname': 'pi-rack',
              'public_ip': '113.87.160.22',
              'location': '中国 广东 深圳',
              'cpus': 4,
              'ram_mb': 8192,
              'capabilities': ['exec', 'relay', 'gpu'],
              'sandbox': {'allowed_workspaces': ['/home/neo/work']},
              'relay_config': {'enabled': true, 'mqtt_bind': '0.0.0.0:1883', 'uart_device': '/dev/ttyUSB0'},
            },
            'capabilities': ['exec', 'relay', 'gpu'],
            'lastSeenMs': 1777626600000,
          },
        ],
        'approvals': [
          {
            'id': 'apr-1',
            'shortCode': 'A7K9P2',
            'clusterId': 'personal',
            'deviceId': 'edge-pi-01',
            'action': 'reboot',
            'params': {'delaySec': 5},
            'status': 'pending',
          },
        ],
        'enrollments': [
          {
            'id': 'enr-1',
            'clusterId': 'personal',
            'platform': 'linux',
            'profile': 'corp',
            'installMode': 'system',
            'transportMode': 'relay',
            'status': 'pending',
            'maxUses': 3,
            'usedCount': 1,
            'enrollCode': 'code-123',
            'commands': {
              'linuxRoot': 'sudo install',
              'linuxUser': 'user install',
              'macos': 'mac install',
              'windows': 'win install',
              'docker': 'docker install',
              'uninstall': 'uninstall',
            },
          },
        ],
      });

      expect(overview.config.configured, isTrue);
      expect(overview.config.relayState, 'connected');
      expect(overview.config.localRelayDetected, isTrue);
      expect(overview.onlineDevicesCount, 1);
      expect(overview.pendingApprovalsCount, 1);
      expect(overview.activeEnrollments, hasLength(1));

      final device = overview.devices.single;
      expect((device.isTier1, device.isOnline, device.isRelayCapable, device.hasGpu), (true, true, true, true));
      expect((device.effectiveVersion, device.effectivePublicIp, device.effectiveLocation), ('0.9.2', '113.87.160.22', '中国 广东 深圳'));
      expect((device.mqttBind, device.uartDevice), ('0.0.0.0:1883', '/dev/ttyUSB0'));
      expect(device.workspaces, ['/home/neo/work']);

      final enrollment = overview.enrollments.single;
      expect(enrollment.commands.forPlatform('linux', linuxUseRoot: true), 'sudo install');
      expect(enrollment.commands.forPlatform('linux', linuxUseRoot: false), 'user install');
      expect(enrollment.commands.forPlatform('macos'), 'mac install');
      expect(enrollment.commands.forPlatform('windows'), 'win install');
      expect(enrollment.commands.forPlatform('docker'), 'docker install');

      final ping = DevicePingResult.fromJson({'ok': true, 'deviceId': 'edge-pi-01', 'latencyMs': 24, 'status': 'online', 'route': 'p2p'});
      expect((ping.ok, ping.latencyMs, ping.route, ping.error), (true, 24, 'p2p', null));

      final now = DateTime(2026, 5, 1, 10, 0, 0);
      expect(formatRemainingTtl(now.add(const Duration(minutes: 9, seconds: 5)), now: now), '09:05');
      expect(formatRemainingTtl(now.add(const Duration(hours: 1, minutes: 2, seconds: 3)), now: now), '01:02:03');
      expect(formatRemainingTtl(now.subtract(const Duration(seconds: 5)), now: now), '00:00');
    });

    test('calls all multi-device API routes cleanly', () async {
      final backend = FakeBackend();
      final api = backend.api();

      final initial = await api.devicesOverview();
      expect(initial.config.configured, isFalse);

      final cfg = await api.initDeviceConfig(clusterId: 'lab', relayUrl: 'https://relay.test:18443', clusterSecret: 'sec-1', enabled: true);
      expect((cfg.configured, cfg.clusterId, cfg.relayState), (true, 'lab', 'connected'));

      final updated = await api.updateDeviceConfig(relayUrl: 'https://relay2.test:18443', enabled: true);
      expect(updated.relayUrl, 'https://relay2.test:18443');

      final enrollment = await api.createDeviceEnrollment(
        platform: 'linux',
        profile: 'personal',
        installMode: 'auto',
        transportMode: 'relay',
        ttlSec: 600,
        maxUses: 1,
      );
      expect((enrollment.platform, enrollment.status), ('linux', 'pending'));
      expect((await api.deviceEnrollments()).length, 1);

      backend.completeEnrollment(enrollment.id, deviceId: 'worker-01');
      final detail = await api.deviceEnrollment(enrollment.id);
      expect(detail.enrollment.status, 'completed');
      expect(detail.devices.single.deviceId, 'worker-01');

      final ping = await api.pingDevice('worker-01');
      expect((ping.ok, ping.latencyMs), (true, 18));

      final mcu = await api.installMcu(
        mcuId: 'esp32-lab-1',
        relayDeviceId: 'worker-01',
        transport: 'mqtt',
        mqttBroker: '127.0.0.1:1883',
        chip: 'ESP32-S3',
      );
      expect((mcu.deployed, mcu.deployMethod, mcu.twin.deviceId), (true, 'tier1_rpc', 'esp32-lab-1'));

      await api.removeDevice('esp32-lab-1');
      expect(backend.removedDevices, ['esp32-lab-1']);

      final sandboxRes = await api.updateDeviceSandbox('worker-01', level: 'desktop', workspaces: ['/workspace', '/tmp/build']);
      expect((sandboxRes.level, sandboxRes.applied, sandboxRes.pending, sandboxRes.persisted), ('desktop', true, false, true));
      expect(sandboxRes.device.effectiveSandboxLevel, 'desktop');
      expect(sandboxRes.device.workspaces, ['/workspace', '/tmp/build']);
      expect(backend.sandboxUpdates.last, {
        'deviceId': 'worker-01',
        'level': 'desktop',
        'workspaces': ['/workspace', '/tmp/build'],
      });

      backend.sandboxPendingMode = true;
      final pendingRes = await api.updateDeviceSandbox('worker-01', level: 'unrestricted');
      expect((pendingRes.level, pendingRes.applied, pendingRes.pending, pendingRes.persisted), ('unrestricted', false, true, null));
      expect((pendingRes.device.desiredSandboxLevel, pendingRes.device.sandboxSyncState, pendingRes.device.isSandboxSyncPending), ('unrestricted', 'pending', true));
      backend.sandboxPendingMode = false;

      backend.sandboxError = 'Invalid sandbox level';
      await expectLater(api.updateDeviceSandbox('worker-01', level: 'invalid'), throwsA(isA<ApiException>()));
    });

    test('parses sandbox level inference, twin sync flags, and update results accurately', () {
      expect(sandboxLevels, ['readonly', 'corp', 'personal', 'desktop', 'unrestricted']);

      // Explicit level takes precedence.
      final explicitDesktop = DeviceManifest.fromJson({
        'device_id': 'd1',
        'sandbox': {'level': 'desktop', 'max_child_mem_mb': 1024, 'max_exec_timeout_sec': 60},
      });
      expect((explicitDesktop.sandboxLevel, explicitDesktop.isUnrestricted, explicitDesktop.isSandboxLocked), ('desktop', false, false));

      // Boolean flags unrestricted & read_only & locked.
      final unrestrictedFlag = DeviceManifest.fromJson({
        'device_id': 'd2',
        'sandbox': {'unrestricted': true, 'locked': true},
      });
      expect((unrestrictedFlag.sandboxLevel, unrestrictedFlag.isUnrestricted, unrestrictedFlag.isSandboxLocked), ('unrestricted', true, true));

      final readOnlyFlag = DeviceManifest.fromJson({
        'device_id': 'd3',
        'sandbox': {'read_only': true},
      });
      expect(readOnlyFlag.sandboxLevel, 'readonly');

      // Inferred from resource limits.
      expect(DeviceManifest.fromJson({'sandbox': {'max_child_mem_mb': 0, 'max_exec_timeout_sec': 0}}).sandboxLevel, 'unrestricted');
      expect(DeviceManifest.fromJson({'sandbox': {'max_child_mem_mb': 1024, 'max_exec_timeout_sec': 60}}).sandboxLevel, 'readonly');
      expect(DeviceManifest.fromJson({'sandbox': {'max_child_mem_mb': 4096, 'max_exec_timeout_sec': 90}}).sandboxLevel, 'corp');
      expect(DeviceManifest.fromJson({'sandbox': {'max_child_mem_mb': 4096, 'max_exec_timeout_sec': 180}}).sandboxLevel, 'desktop');
      expect(DeviceManifest.fromJson({'sandbox': {'allowed_workspaces': ['/work']}}).sandboxLevel, 'personal');
      expect(DeviceManifest.fromJson({'sandbox': <String, dynamic>{}}).sandboxLevel, isNull);

      // DeviceTwin fallback chain & flags.
      final twinFallback = DeviceTwin.fromJson({
        'deviceId': 'dev-fallback',
        'sandboxLevel': 'corp',
        'desiredSandboxLevel': 'unrestricted',
        'sandboxSyncState': 'pending',
        'sandboxSyncError': 'Waiting for reconnect',
      });
      expect(twinFallback.effectiveSandboxLevel, 'corp');
      expect(twinFallback.isUnrestricted, isFalse);
      expect(twinFallback.isSandboxLocked, isFalse);
      expect(twinFallback.isSandboxSyncPending, isTrue);
      expect(twinFallback.sandboxSyncError, 'Waiting for reconnect');

      final twinLocked = DeviceTwin.fromJson({
        'deviceId': 'dev-locked',
        'sandboxLevel': 'personal',
        'sandboxSyncState': 'locked',
      });
      expect((twinLocked.effectiveSandboxLevel, twinLocked.isSandboxLocked, twinLocked.isSandboxSyncPending), ('personal', true, false));

      final twinDefault = DeviceTwin.fromJson({'deviceId': 'dev-default'});
      expect((twinDefault.effectiveSandboxLevel, twinDefault.isUnrestricted, twinDefault.isSandboxSyncPending), ('personal', false, false));

      final result = DeviceSandboxUpdateResult.fromJson({
        'device': {
          'deviceId': 'dev-1',
          'sandboxLevel': 'unrestricted',
          'manifest': {
            'device_id': 'dev-1',
            'sandbox': {'level': 'unrestricted', 'unrestricted': true},
          },
        },
        'level': 'unrestricted',
        'applied': true,
        'pending': false,
        'persisted': false,
        'warning': 'Runtime only; config file is read-only',
      });
      expect((result.level, result.applied, result.pending, result.persisted), ('unrestricted', true, false, false));
      expect(result.warning, 'Runtime only; config file is read-only');
      expect(result.error, isNull);
      expect(result.device.isUnrestricted, isTrue);
    });

    test('parses MCP summaries, descriptors, tool annotations, and results in both snake_case and camelCase', () {
      final snakeTwin = DeviceTwin.fromJson({
        'deviceId': 'mac-studio',
        'tier': 'os',
        'status': 'online',
        'capabilities': ['exec', 'mcp_discovery', 'mcp_proxy'],
        'manifest': {
          'device_id': 'mac-studio',
          'tier': 'os',
          'capabilities': ['exec', 'mcp_discovery', 'mcp_proxy'],
          'mcp_summary': {
            'enabled': true,
            'discovery_mode': 'standard',
            'discovered_count': 3,
            'enabled_count': 2,
            'running_count': 1,
            'catalog_hash': 'sha256:abc123',
            'servers': [
              {
                'server_id': 'claude_desktop:github',
                'name': 'github',
                'source': 'claude_desktop',
                'transport': 'stdio',
                'trust_state': 'enabled',
                'call_mode': 'auto_readonly',
                'runtime_state': 'running',
                'tool_count': 12,
              },
            ],
          },
        },
      });
      expect(snakeTwin.isMcpCapable, isTrue);
      expect(snakeTwin.mcpSummary, isNotNull);
      expect(
        (
          snakeTwin.mcpSummary!.enabled,
          snakeTwin.mcpSummary!.discoveryMode,
          snakeTwin.mcpSummary!.discoveredCount,
          snakeTwin.mcpSummary!.enabledCount,
          snakeTwin.mcpSummary!.runningCount,
          snakeTwin.mcpSummary!.catalogHash,
        ),
        (true, 'standard', 3, 2, 1, 'sha256:abc123'),
      );
      final sumServer = snakeTwin.mcpSummary!.servers.single;
      expect(
        (sumServer.serverId, sumServer.name, sumServer.source, sumServer.transport, sumServer.trustState, sumServer.callMode, sumServer.runtimeState, sumServer.toolCount),
        ('claude_desktop:github', 'github', 'claude_desktop', 'stdio', 'enabled', 'auto_readonly', 'running', 12),
      );

      final camelTwin = DeviceTwin.fromJson({
        'deviceId': 'win-pc',
        'tier': 'os',
        'manifest': {
          'deviceId': 'win-pc',
          'mcpSummary': {
            'enabled': true,
            'discoveryMode': 'full',
            'discoveredCount': 1,
            'enabledCount': 0,
            'runningCount': 0,
            'catalogHash': 'sha256:camel',
            'servers': [
              {
                'serverId': 'cursor:fs',
                'name': 'fs',
                'source': 'cursor',
                'transport': 'streamable_http',
                'trustState': 'blocked_by_policy',
                'callMode': 'disabled',
                'runtimeState': 'stopped',
              },
            ],
          },
        },
      });
      expect(camelTwin.isMcpCapable, isTrue);
      expect(camelTwin.mcpSummary!.servers.single.isBlocked, isTrue);
      expect(camelTwin.mcpSummary!.servers.single.toolCount, isNull);

      // Tier 2 MCU is never MCP capable even if manifest had stray fields.
      final mcuTwin = DeviceTwin.fromJson({
        'deviceId': 'esp32-1',
        'tier': 'mcu',
        'capabilities': ['mcp_proxy'],
      });
      expect(mcuTwin.isMcpCapable, isFalse);

      // Descriptor snake_case & camelCase parsing.
      final snakeDesc = McpServerDescriptor.fromJson({
        'server_id': 'claude_desktop:github',
        'name': 'github',
        'source': 'claude_desktop',
        'source_path': '~/Library/Application Support/Claude/claude_desktop_config.json',
        'transport': 'stdio',
        'command_preview': 'npx -y @modelcontextprotocol/server-github',
        'url_sanitized': null,
        'env_keys': ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        'auth_required': true,
        'trust_state': 'enabled',
        'call_mode': 'confirm_all',
        'runtime_state': 'running',
        'tool_count': 8,
        'dedup_key': 'stdio:npx-github',
        'duplicate_of': 'cursor:github',
        'fingerprint': 'sha256:9f2a',
        'last_error': 'temporary rate limit',
      });
      expect(snakeDesc.isEnabled, isTrue);
      expect(snakeDesc.isBlocked, isFalse);
      expect(snakeDesc.isActiveRuntime, isTrue);
      expect(snakeDesc.envKeys, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
      expect(snakeDesc.authRequired, isTrue);
      expect(snakeDesc.duplicateOf, 'cursor:github');
      expect(snakeDesc.lastError, 'temporary rate limit');

      final camelDesc = McpServerDescriptor.fromJson({
        'serverId': 'neo:docs',
        'name': 'docs',
        'source': 'neo',
        'sourcePath': '~/.config/neo-agent/mcp.d/docs.json',
        'transport': 'sse',
        'urlSanitized': 'http://127.0.0.1:9000/sse',
        'envKeys': ['DOCS_KEY'],
        'authRequired': false,
        'trustState': 'blocked_by_policy',
        'callMode': 'disabled',
        'runtimeState': 'stopped',
      });
      expect((camelDesc.serverId, camelDesc.isEnabled, camelDesc.isBlocked, camelDesc.urlSanitized), ('neo:docs', false, true, 'http://127.0.0.1:9000/sse'));
      expect(camelDesc.envKeys, ['DOCS_KEY']);

      // Tool annotations parsed from top-level snake/camel AND nested `annotations`.
      final toolFlatSnake = McpToolInfo.fromJson({
        'name': 'list_issues',
        'description': 'List repository issues',
        'input_schema': {'type': 'object'},
        'read_only_hint': true,
        'destructive_hint': false,
        'idempotent_hint': true,
        'open_world_hint': true,
      });
      expect((toolFlatSnake.name, toolFlatSnake.readOnlyHint, toolFlatSnake.destructiveHint, toolFlatSnake.idempotentHint, toolFlatSnake.openWorldHint), ('list_issues', true, false, true, true));

      final toolNested = McpToolInfo.fromJson({
        'name': 'delete_repo',
        'description': 'Delete a repository',
        'inputSchema': {'type': 'object', 'required': ['repo']},
        'annotations': {'readOnlyHint': false, 'destructiveHint': true},
      });
      expect((toolNested.name, toolNested.readOnlyHint, toolNested.destructiveHint, toolNested.inputSchema['type']), ('delete_repo', false, true, 'object'));

      // Overview, InspectResult, PolicyUpdateResult.
      final mcpOverview = DeviceMcpOverview.fromJson({
        'device_id': 'mac-studio',
        'supported': true,
        'discovery_mode': 'standard',
        'catalog_hash': 'sha256:cat',
        'updated_at': '2026-05-01T10:00:00.000Z',
        'servers': [
          {'server_id': 'cursor:fs', 'name': 'fs', 'source': 'cursor', 'transport': 'stdio'},
        ],
        'warnings': ['Skipped unreadable config'],
        'summary': {'enabled': true, 'discovered_count': 1, 'enabled_count': 0, 'running_count': 0},
      });
      expect((mcpOverview.deviceId, mcpOverview.supported, mcpOverview.servers.length, mcpOverview.warnings.single), ('mac-studio', true, 1, 'Skipped unreadable config'));
      expect(mcpOverview.updatedAt, isNotNull);
      expect(mcpOverview.summary?.discoveredCount, 1);

      final inspectRes = DeviceMcpInspectResult.fromJson({
        'device_id': 'mac-studio',
        'server': {'server_id': 'cursor:fs', 'name': 'fs', 'runtime_state': 'running', 'tool_count': 1},
        'protocol_version': '2025-03-26',
        'tools': [
          {'name': 'read_file', 'readOnlyHint': true},
        ],
        'tools_schema_hash': 'sha256:t1',
      });
      expect((inspectRes.deviceId, inspectRes.protocolVersion, inspectRes.toolsSchemaHash, inspectRes.server?.runtimeState), ('mac-studio', '2025-03-26', 'sha256:t1', 'running'));
      expect(inspectRes.tools.single.readOnlyHint, isTrue);

      final policyRes = DeviceMcpPolicyUpdateResult.fromJson({
        'deviceId': 'mac-studio',
        'server': {'serverId': 'cursor:fs', 'name': 'fs', 'trustState': 'enabled', 'callMode': 'auto_readonly'},
        'persisted': true,
        'summary': {'enabled': true, 'discoveredCount': 1, 'enabledCount': 1, 'runningCount': 0},
      });
      expect((policyRes.deviceId, policyRes.persisted, policyRes.server.isEnabled, policyRes.summary?.enabledCount), ('mac-studio', true, true, 1));

      // Also parses backend `result.persisted` nested shape cleanly.
      final policyNestedRes = DeviceMcpPolicyUpdateResult.fromJson({
        'deviceId': 'mac-studio',
        'serverId': 'cursor:fs',
        'server': {'server_id': 'cursor:fs', 'name': 'fs', 'trust_state': 'enabled', 'call_mode': 'confirm_all'},
        'result': {'persisted': true},
      });
      expect((policyNestedRes.persisted, policyNestedRes.server.callMode), (true, 'confirm_all'));
    });

    test('calls all device MCP API routes cleanly including percent-encoded server IDs', () async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice('mac-1', status: 'online', route: 'p2p', sandboxLevel: 'desktop')
        ..setDeviceMcp(
          'mac-1',
          servers: [
            {
              'serverId': 'claude_desktop:github',
              'name': 'github',
              'source': 'claude_desktop',
              'transport': 'stdio',
              'commandPreview': 'npx -y @modelcontextprotocol/server-github',
              'envKeys': ['GITHUB_PERSONAL_ACCESS_TOKEN'],
              'authRequired': true,
              'trustState': 'discovered',
              'callMode': 'disabled',
              'runtimeState': 'stopped',
            },
          ],
          toolsByServer: {
            'claude_desktop:github': [
              {'name': 'search_code', 'description': 'Search code', 'readOnlyHint': true},
              {'name': 'delete_branch', 'description': 'Delete git branch', 'destructiveHint': true},
            ],
          },
        );
      final api = backend.api();

      final initial = await api.deviceMcp('mac-1');
      expect((initial.supported, initial.servers.length), (true, 1));

      final discovered = await api.discoverDeviceMcp('mac-1', includeLoopbackProbe: true);
      expect(backend.mcpDiscovers.single, {'deviceId': 'mac-1', 'includeLoopbackProbe': true});
      expect(discovered.servers.length, 2);

      final policy = await api.updateDeviceMcpPolicy('mac-1', 'claude_desktop:github', enabled: true, callMode: 'auto_readonly');
      expect((policy.persisted, policy.server.isEnabled, policy.server.callMode), (true, true, 'auto_readonly'));
      expect(backend.mcpPolicyUpdates.single, {'deviceId': 'mac-1', 'serverId': 'claude_desktop:github', 'enabled': true, 'callMode': 'auto_readonly'});

      final inspected = await api.inspectDeviceMcp('mac-1', 'claude_desktop:github', refresh: true, query: 'delete');
      expect(backend.mcpInspects.single, {'deviceId': 'mac-1', 'serverId': 'claude_desktop:github', 'refresh': true, 'query': 'delete'});
      expect(inspected.tools.map((t) => t.name).toList(), ['delete_branch']);

      await api.restartDeviceMcpServer('mac-1', 'claude_desktop:github');
      expect(backend.mcpRestarts.single, {'deviceId': 'mac-1', 'serverId': 'claude_desktop:github'});

      await api.stopDeviceMcpServer('mac-1', 'claude_desktop:github');
      expect(backend.mcpStops.single, {'deviceId': 'mac-1', 'serverId': 'claude_desktop:github'});
    });
  });

  group('devices UI flows', () {
    testWidgets('initializes unconfigured cluster with auto-detected local relay and supports cluster settings edit', (tester) async {
      final backend = FakeBackend()..deviceConfig['localRelayDetected'] = true;
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      // Shows auto-detected local relay badge and pre-filled default relay URL.
      expect(find.text('已自动探测本机中继'), findsOneWidget);
      final relayField = tester.widget<CupertinoTextField>(find.descendant(of: find.byKey(const ValueKey('init-relay-url')), matching: find.byType(CupertinoTextField)));
      expect(relayField.controller!.text, 'https://neo.1inch.cn:18443');

      await tester.enterText(find.byKey(const ValueKey('init-cluster-id')), 'home-lab');
      await tester.tap(find.byKey(const ValueKey('init-advanced-toggle')));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('init-master-node-id')), 'master-home');

      final initBtn = find.byKey(const ValueKey('init-cluster-btn'));
      await show(tester, initBtn);
      await tester.tap(initBtn);
      await settle(tester);

      expect(backend.deviceConfigInits, hasLength(1));
      expect(backend.deviceConfigInits.single['clusterId'], 'home-lab');
      expect(backend.deviceConfigInits.single['masterNodeId'], 'master-home');
      expect(backend.deviceConfigInits.single['autoDetectLocalRelay'], isTrue);

      // Transitions into Configured State with Cluster Status Bar and empty fleet CTA.
      expect(find.text('home-lab'), findsOneWidget);
      expect(find.byKey(const ValueKey('add-device-btn')), findsOneWidget);
      expect(find.byKey(const ValueKey('empty-add-device-btn')), findsOneWidget);

      // Edit cluster settings via modal.
      await tester.tap(find.byKey(const ValueKey('cluster-settings-btn')));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('edit-relay-url')), 'https://relay-custom.example:18443');
      await tester.tap(find.byKey(const ValueKey('save-cluster-settings-btn')));
      await settle(tester);
      expect(backend.deviceConfigUpdates.single['relayUrl'], 'https://relay-custom.example:18443');
      expect(find.text('https://relay-custom.example:18443'), findsOneWidget);

      await app.close();
    });

    testWidgets('initializes unconfigured cluster with remote relay secret input', (tester) async {
      final backend = FakeBackend();
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      expect(find.text('已自动探测本机中继'), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('init-cluster-id')), 'corp-prod');
      await tester.enterText(find.byKey(const ValueKey('init-cluster-secret')), 'super-secret-xyz');
      await tester.tap(find.byKey(const ValueKey('init-cluster-btn')));
      await settle(tester);

      expect(backend.deviceConfigInits.single['clusterId'], 'corp-prod');
      expect(backend.deviceConfigInits.single['clusterSecret'], 'super-secret-xyz');
      expect(backend.deviceConfigInits.single['autoDetectLocalRelay'], isFalse);
      expect(find.text('corp-prod'), findsOneWidget);

      await app.close();
    });

    testWidgets('generates Linux, macOS, and Windows install commands, toggles root/user & QR, and tracks live onboarding', (tester) async {
      final clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

      final backend = FakeBackend()..configureDevices(clusterId: 'personal');
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      // Open Add Device sheet.
      await tester.tap(find.byKey(const ValueKey('add-device-btn')));
      await settle(tester);

      // Select corp policy and expand advanced options.
      await tester.tap(find.byKey(const ValueKey('profile-corp')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('enroll-advanced-toggle')));
      await settle(tester);

      await show(tester, find.byKey(const ValueKey('enroll-device-id')));
      await tester.enterText(find.byKey(const ValueKey('enroll-device-id')), 'gpu-node-01');
      await tester.enterText(find.byKey(const ValueKey('enroll-workspaces')), '/workspace, /data/models');
      await show(tester, find.byKey(const ValueKey('enroll-relay-bridge')));
      await tester.tap(find.byKey(const ValueKey('enroll-relay-bridge')));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('enroll-mqtt-bind')), '0.0.0.0:1883');
      await tester.enterText(find.byKey(const ValueKey('enroll-uart-device')), '/dev/ttyUSB0');
      await tester.enterText(find.byKey(const ValueKey('enroll-cuda-devices')), '0,1');

      final generateBtn = find.byKey(const ValueKey('generate-install-cmd-btn'));
      await show(tester, generateBtn);
      await tester.tap(generateBtn);
      await settle(tester);

      expect(backend.createdEnrollments, hasLength(1));
      final req = backend.createdEnrollments.single;
      expect(req['platform'], 'linux');
      expect(req['profile'], 'corp');
      expect(req['deviceId'], 'gpu-node-01');
      expect(req['workspaces'], ['/workspace', '/data/models']);
      expect(req['relayBridge'], isTrue);
      expect(req['mqttBind'], '0.0.0.0:1883');
      expect(req['uartDevice'], '/dev/ttyUSB0');
      expect(req['cudaDevices'], '0,1');

      // Linux root command is shown first; switching to non-root user mode updates the command.
      expect(find.textContaining('sudo sh -s --'), findsOneWidget);
      await tester.tap(find.text('非 root 用户态'));
      await tester.pump();
      expect(find.textContaining('--user'), findsOneWidget);

      // Copy command and toggle QR view.
      await tester.tap(find.byKey(const ValueKey('copy-enroll-cmd-btn')));
      await tester.pump();
      expect(clipboard.last, contains('--user'));
      expect(find.textContaining('已复制'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('toggle-qr-btn')));
      await tester.pump();
      expect(find.byType(QrView), findsOneWidget);

      // Live polling: pending -> claimed -> completed.
      expect(find.text('等待在目标设备粘贴执行…'), findsOneWidget);

      final enrId = backend.deviceEnrollments.single['id'] as String;
      backend.claimEnrollment(enrId, ip: '10.8.0.15');
      await tester.pump(const Duration(seconds: 2));
      await settle(tester);
      expect(find.textContaining('票据已被认领 (IP: 10.8.0.15)'), findsOneWidget);

      backend.completeEnrollment(enrId, deviceId: 'gpu-node-01', os: 'linux', arch: 'amd64', route: 'p2p');
      await tester.pump(const Duration(seconds: 2));
      await settle(tester);
      expect(find.text('设备 gpu-node-01 已成功上线！'), findsOneWidget);

      // Click Done -> closes sheet and shows onboarded device in Device Fleet.
      final doneBtn = find.byKey(const ValueKey('enroll-done-btn'));
      await show(tester, doneBtn);
      await tester.tap(doneBtn);
      await settle(tester);
      expect(find.byType(DeviceEnrollSheet), findsNothing);
      expect(find.byKey(const ValueKey('device-gpu-node-01')), findsOneWidget);
      expect(find.text('P2P'), findsOneWidget);

      // Also verify macOS & Windows command generation in the same sheet.
      await tester.tap(find.byKey(const ValueKey('add-device-btn')));
      await settle(tester);

      await tester.tap(find.text('macOS'));
      await settle(tester);
      expect(find.byKey(const ValueKey('enroll-install-mode')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await settle(tester);
      expect(find.textContaining('--macos'), findsOneWidget);

      await tester.tap(find.text('Windows'));
      await settle(tester);
      expect(find.byKey(const ValueKey('enroll-install-mode')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await settle(tester);
      expect(find.textContaining('install.ps1'), findsOneWidget);

      await tester.tap(find.text('Docker'));
      await settle(tester);
      expect(find.byKey(const ValueKey('enroll-install-mode')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await settle(tester);
      expect(find.textContaining('docker run -d'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);
      await app.close();
    });

    testWidgets('re-opens an active enrollment via View/Copy and handles staged manual MCU fallback on narrow layout', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..mcuAutoDeploySuccess = false;
      final app = await open(tester, backend, size: narrow);

      await tester.tap(nav(2));
      await settle(tester);

      // Generate enrollment on narrow layout with advanced options expanded (ensures no overflow).
      await tester.tap(find.byKey(const ValueKey('add-device-btn')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('enroll-advanced-toggle')));
      await settle(tester);
      final genBtn = find.byKey(const ValueKey('generate-install-cmd-btn'));
      await show(tester, genBtn);
      await tester.tap(genBtn);
      await settle(tester);
      final enrId = backend.deviceEnrollments.last['id'] as String;
      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);

      // Re-open existing enrollment from Active Enrollments section.
      final viewBtn = find.byKey(ValueKey('view-enrollment-$enrId'));
      await show(tester, viewBtn);
      await tester.tap(viewBtn);
      await settle(tester);
      expect(find.byKey(const ValueKey('enroll-command-box')), findsOneWidget);

      // Switch to MCU tab with manual Tier 1 entry and staged_manual result.
      await tester.tap(find.text('MCU'));
      await settle(tester);
      await tester.enterText(find.byKey(const ValueKey('mcu-relay-device-id')), 'offline-pi-01');
      await tester.enterText(find.byKey(const ValueKey('mcu-id-input')), 'stm32-bench-01');
      await tester.tap(find.byKey(const ValueKey('mcu-chip-STM32')));
      await tester.pump();
      final installBtn = find.byKey(const ValueKey('install-mcu-btn'));
      await show(tester, installBtn);
      await tester.tap(installBtn);
      await settle(tester);
      expect(find.text('已生成 MCU 配置（暂存手动部署模式）'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);
      await app.close();
    });

    testWidgets('revokes an active enrollment from the sheet and from the Devices page', (tester) async {
      final backend = FakeBackend()..configureDevices(clusterId: 'personal');
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      // Generate first enrollment and revoke inside the sheet.
      await tester.tap(find.byKey(const ValueKey('add-device-btn')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await settle(tester);
      final firstId = backend.deviceEnrollments.last['id'] as String;
      await tester.tap(find.byKey(const ValueKey('revoke-enroll-btn')));
      await settle(tester);
      expect(backend.revokedEnrollments, [firstId]);
      expect(find.text('安装票据已作废。'), findsOneWidget);

      // Generate a second enrollment, close sheet, then view & revoke from Active Enrollments group.
      await tester.tap(find.byKey(const ValueKey('new-enroll-btn')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('generate-install-cmd-btn')));
      await settle(tester);
      final secondId = backend.deviceEnrollments.last['id'] as String;
      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);

      expect(find.byKey(ValueKey('enrollment-$secondId')), findsOneWidget);
      await tester.tap(find.byKey(ValueKey('revoke-enrollment-$secondId')));
      await settle(tester);
      expect(backend.revokedEnrollments, [firstId, secondId]);
      expect(find.byKey(ValueKey('enrollment-$secondId')), findsNothing);

      await app.close();
    });

    testWidgets('installs a Tier 2 MCU through an online Tier 1 host with auto-filled MQTT/UART settings', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice(
          'edge-pi-01',
          status: 'online',
          route: 'lan',
          capabilities: ['exec', 'fs', 'relay'],
          manifest: {
            'device_id': 'edge-pi-01',
            'tier': 'os',
            'os': 'linux',
            'arch': 'arm64',
            'hostname': 'edge-pi-01',
            'cpus': 4,
            'ram_mb': 4096,
            'capabilities': ['exec', 'fs', 'relay'],
            'sandbox': {'allowed_workspaces': ['/home/neo/work']},
            'relay_config': {'enabled': true, 'mqtt_bind': '192.168.1.50:1883', 'uart_device': '/dev/ttyACM0'},
          },
        );
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      await tester.tap(find.byKey(const ValueKey('add-mcu-btn')));
      await settle(tester);

      // Auto-selected edge-pi-01 and pre-filled its mqtt_bind.
      expect(find.text('edge-pi-01'), findsWidgets);
      final mqttField = tester.widget<CupertinoTextField>(find.descendant(of: find.byKey(const ValueKey('mcu-mqtt-broker')), matching: find.byType(CupertinoTextField)));
      expect(mqttField.controller!.text, '192.168.1.50:1883');

      // Switch to Serial to verify uart_device was auto-filled too, then switch back to MQTT.
      await tester.tap(find.text('串口 (UART/RS485)'));
      await settle(tester);
      final serialField = tester.widget<CupertinoTextField>(find.descendant(of: find.byKey(const ValueKey('mcu-serial-port')), matching: find.byType(CupertinoTextField)));
      expect(serialField.controller!.text, '/dev/ttyACM0');

      await tester.tap(find.text('MQTT'));
      await settle(tester);

      await tester.enterText(find.byKey(const ValueKey('mcu-id-input')), 'esp32-rack-01');
      await tester.tap(find.byKey(const ValueKey('mcu-chip-ESP32-S3')));
      await tester.pump();

      final installBtn = find.byKey(const ValueKey('install-mcu-btn'));
      await show(tester, installBtn);
      await tester.tap(installBtn);
      await settle(tester);

      expect(backend.mcuInstalls, hasLength(1));
      expect(backend.mcuInstalls.single, {
        'mcuId': 'esp32-rack-01',
        'relayDeviceId': 'edge-pi-01',
        'transport': 'mqtt',
        'mqttBroker': '192.168.1.50:1883',
        'chip': 'ESP32-S3',
        'autoDeploy': true,
      });

      // Result shows Tier 1 deployment status and expandable neo_mcu_config.h.
      expect(find.byKey(const ValueKey('mcu-install-result')), findsOneWidget);
      expect(find.textContaining('已通过加密信道下发至 Tier 1 工作区 /home/neo-personal/work/mcu/esp32-rack-01'), findsOneWidget);

      final toggleHeader = find.byKey(const ValueKey('toggle-mcu-header-btn'));
      await show(tester, toggleHeader);
      await tester.tap(toggleHeader);
      await settle(tester);
      expect(find.textContaining('#define NEO_MCU_ID "esp32-rack-01"'), findsOneWidget);

      final doneBtn = find.byKey(const ValueKey('mcu-done-btn'));
      await show(tester, doneBtn);
      await tester.tap(doneBtn);
      await settle(tester);
      expect(find.byType(DeviceEnrollSheet), findsNothing);

      // MCU appears in Device Fleet routed via Tier 1.
      expect(find.byKey(const ValueKey('device-esp32-rack-01')), findsOneWidget);
      expect(find.text('via Tier1'), findsOneWidget);

      await app.close();
    });

    testWidgets('handles pending approvals with badge, device ping, uninstall copy, and confirmed device removal', (tester) async {
      final clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice('linux-box-1', status: 'online', route: 'p2p')
        ..addDeviceApproval('apr-1', shortCode: 'X9K2M4', deviceId: 'linux-box-1', action: 'set_fan_pwm', params: {'pwm': 80})
        ..addDeviceApproval('apr-2', shortCode: 'B4R7T1', deviceId: 'linux-box-1', action: 'reboot', reason: 'Kernel update');

      final app = await open(tester, backend, bundledCjk: true);

      // Sidebar nav-2 displays pending approval badge count = 2.
      expect(find.descendant(of: nav(2), matching: find.text('2')), findsOneWidget);

      await tester.tap(nav(2));
      await settle(tester);

      expect(find.text('X9K2M4'), findsOneWidget);
      expect(find.text('B4R7T1'), findsOneWidget);

      // Approve apr-1 -> badge drops to 1.
      await tester.tap(find.byKey(const ValueKey('approve-apr-1')));
      await settle(tester);
      expect(backend.approvedApprovals, ['apr-1']);
      expect(find.descendant(of: nav(2), matching: find.text('1')), findsOneWidget);

      // Reject apr-2 -> approvals group disappears.
      await tester.tap(find.byKey(const ValueKey('reject-apr-2')));
      await settle(tester);
      expect(backend.rejectedApprovals, ['apr-2']);
      expect(find.text('B4R7T1'), findsNothing);

      // Ping device.
      final pingBtn = find.byKey(const ValueKey('ping-linux-box-1'));
      await show(tester, pingBtn);
      await tester.tap(pingBtn);
      await settle(tester);
      expect(backend.pingedDevices, ['linux-box-1']);
      expect(find.text('延迟 18ms · p2p'), findsOneWidget);

      // Copy uninstall command.
      await tester.tap(find.byKey(const ValueKey('uninstall-linux-box-1')));
      await settle(tester);
      expect(clipboard.last, contains('neo-agent-os uninstall --cluster personal'));
      expect(find.textContaining('已复制卸载命令'), findsOneWidget);

      // Remove device (cancel first, verify CJK fallback font in dialog, then confirm).
      final removeBtn = find.byKey(const ValueKey('remove-linux-box-1'));
      await show(tester, removeBtn);
      await tester.tap(removeBtn);
      await settle(tester);
      final titleRich = tester.widget<RichText>(find.descendant(of: find.text('移除设备 linux-box-1？'), matching: find.byType(RichText)));
      expect(titleRich.text.style?.fontFamilyFallback, contains(cjkFont));
      await tester.tap(find.text('取消'));
      await settle(tester);
      expect(backend.removedDevices, isEmpty);

      await tester.tap(removeBtn);
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(CupertinoAlertDialog), matching: find.text('移除')));
      await settle(tester);
      expect(backend.removedDevices, ['linux-box-1']);
      expect(find.byKey(const ValueKey('device-linux-box-1')), findsNothing);

      await app.close();
    });

    testWidgets('links Settings multi-device summary card to Devices page and survives older backends returning 404', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal', relayState: 'connected')
        ..addDevice('dev-1', status: 'online', route: 'relay');
      final app = await open(tester, backend, locale: const Locale('en'), size: narrow, brightness: Brightness.dark);

      // Visit Settings (nav-3) -> Multi-device control plane card -> tap Manage devices -> jumps to Devices page.
      await tester.tap(nav(3));
      await settle(tester);
      final openDevices = find.byKey(const ValueKey('settings-open-devices'));
      await show(tester, openDevices);
      expect(find.text('1 / 1 online'), findsOneWidget);
      await tester.tap(openDevices);
      await settle(tester);
      expect(find.byKey(const ValueKey('device-dev-1')), findsOneWidget);

      // Older backend returning 404 for /api/devices stays online gracefully.
      backend.devicesSupported = false;
      await app.state.refresh();
      await tester.pump();
      expect(app.state.link, Link.online);
      expect(app.state.devicesUnsupported, isTrue);
      expect(find.text('Multi-device control plane unavailable'), findsOneWidget);

      await app.close();
    });

    testWidgets('shows Update button only when Tier device version < Master Neo version and triggers remote update strictly matching Master version', (tester) async {
      final clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

      // Verify semver comparison edge cases directly
      expect(compareSemver('0.8.0', '0.9.1'), -1);
      expect(compareSemver('0.9.1', '0.10.0'), -1);
      expect(compareSemver('0.9.1-rc.1', '0.9.1'), -1);
      expect(compareSemver('0.9.1', '0.9.1'), 0);
      expect(compareSemver('0.10.0', '0.9.1'), 1);
      expect(isVersionOlder('v0.9.0', '0.9.1'), isTrue);
      expect(isVersionOlder('0.9.1', '0.9.1'), isFalse);
      expect(isVersionOlder('0.10.0', '0.9.1'), isFalse);

      final backend = FakeBackend()
        // Even if agentVersion were newer, UI strictly compares & targets masterVersion (0.9.1)
        ..configureDevices(clusterId: 'personal', masterVersion: '0.9.1', agentVersion: '0.9.9')
        ..addDevice('mac-old', status: 'online', route: 'p2p', version: '0.8.0')
        ..addDevice('linux-current', status: 'online', route: 'relay', version: '0.9.1')
        ..addDevice('linux-newer', status: 'online', route: 'relay', version: '0.10.0')
        ..addDevice('win-legacy', status: 'online', route: 'relay', omitVersion: true)
        ..addDevice('esp32-old', tier: 'mcu', status: 'sleeping', route: 'via_tier1', relayNodeId: 'linux-current', version: '0.1.0')
        ..addDevice('esp32-current', tier: 'mcu', status: 'online', route: 'via_tier1', relayNodeId: 'linux-current', version: '0.9.1');

      backend.deviceUpdateResponses['win-legacy'] = {
        'ok': false,
        'status': 'manual_upgrade_required',
        'deviceId': 'win-legacy',
        'tier': 'os',
        'targetVersion': '0.9.1',
        'message': 'Legacy agent predates self_update RPC',
        'error': 'unsupported RPC method: self_update',
        'upgradeCommand': 'irm https://neo.1inch.cn:18443/install.ps1 | iex; Install-NeoAgent -Upgrade -Version "0.9.1" -Cluster "personal"',
      };

      final app = await open(tester, backend);
      await tester.tap(nav(2));
      await settle(tester);

      // Update button visible ONLY on outdated Tier 1 (mac-old), legacy Tier 1 (win-legacy), and outdated Tier 2 MCU (esp32-old).
      expect(find.byKey(const ValueKey('update-mac-old')), findsOneWidget);
      expect(find.byKey(const ValueKey('update-win-legacy')), findsOneWidget);
      expect(find.byKey(const ValueKey('update-esp32-old')), findsOneWidget);
      expect(find.byKey(const ValueKey('update-linux-current')), findsNothing);
      expect(find.byKey(const ValueKey('update-linux-newer')), findsNothing);
      expect(find.byKey(const ValueKey('update-esp32-current')), findsNothing);
      expect(find.text('v0.8.0'), findsOneWidget);
      expect(find.text('旧版本'), findsOneWidget);
      expect(find.text('fw 0.1.0'), findsOneWidget);

      // 1. Trigger remote update on mac-old -> strictly targets masterVersion 0.9.1
      final macUpdateBtn = find.byKey(const ValueKey('update-mac-old'));
      await show(tester, macUpdateBtn);
      await tester.tap(macUpdateBtn);
      await settle(tester);
      expect(backend.updatedDevices.last['deviceId'], 'mac-old');
      expect(backend.updatedDevices.last['targetVersion'], '0.9.1');
      expect(find.byKey(const ValueKey('update-result-mac-old')), findsOneWidget);
      expect(find.textContaining('已触发更新至 v0.9.1'), findsOneWidget);

      // Simulate mac-old reconnecting with updated manifest version 0.9.1 -> Update button disappears!
      backend.addDevice('mac-old', status: 'online', route: 'p2p', version: '0.9.1');
      await app.state.refresh();
      await settle(tester);
      expect(find.byKey(const ValueKey('update-mac-old')), findsNothing);
      expect(find.textContaining('已更新至 v0.9.1'), findsOneWidget);

      // 2. Trigger remote update on legacy Tier 1 device -> shows manual upgrade guidance + copy button
      final legacyBtn = find.byKey(const ValueKey('update-win-legacy'));
      await show(tester, legacyBtn);
      await tester.tap(legacyBtn);
      await settle(tester);
      expect(find.textContaining('暂不支持远程自更新'), findsOneWidget);
      final copyUpgradeBtn = find.byKey(const ValueKey('copy-upgrade-win-legacy'));
      expect(copyUpgradeBtn, findsOneWidget);
      await show(tester, copyUpgradeBtn);
      await tester.tap(copyUpgradeBtn);
      await settle(tester);
      expect(clipboard.last, contains('-Upgrade -Version "0.9.1"'));

      // 3. Trigger remote update on sleeping Tier 2 MCU -> queues update for v0.9.1
      final mcuBtn = find.byKey(const ValueKey('update-esp32-old'));
      await show(tester, mcuBtn);
      await tester.tap(mcuBtn);
      await settle(tester);
      expect(backend.updatedDevices.last['deviceId'], 'esp32-old');
      expect(backend.updatedDevices.last['targetVersion'], '0.9.1');
      expect(find.textContaining('已将 v0.9.1 更新加入下发队列'), findsOneWidget);

      await app.close();
    });

    testWidgets('displays sandbox badges on Tier 1 devices only and switches levels including confirmed unrestricted mode', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice('workstation-1', status: 'online', route: 'p2p', sandboxLevel: 'desktop')
        ..addDevice('dev-box-2', status: 'online', route: 'relay', sandboxLevel: 'personal')
        ..addDevice('esp32-sensor-1', tier: 'mcu', status: 'online', route: 'via_tier1', relayNodeId: 'workstation-1');

      final app = await open(tester, backend, bundledCjk: true);

      await tester.tap(nav(2));
      await settle(tester);

      // Tier 1 devices render sandbox pills & button; Tier 2 MCU does not.
      expect(find.descendant(of: find.byKey(const ValueKey('sandbox-pill-workstation-1')), matching: find.text('桌面协作')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('sandbox-pill-dev-box-2')), matching: find.text('个人开发')), findsOneWidget);
      expect(find.byKey(const ValueKey('sandbox-workstation-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('sandbox-dev-box-2')), findsOneWidget);
      expect(find.byKey(const ValueKey('sandbox-pill-esp32-sensor-1')), findsNothing);
      expect(find.byKey(const ValueKey('sandbox-esp32-sensor-1')), findsNothing);

      // Open sandbox sheet on workstation-1.
      final sandboxBtn = find.byKey(const ValueKey('sandbox-workstation-1'));
      await show(tester, sandboxBtn);
      await tester.tap(sandboxBtn);
      await settle(tester);

      expect(find.text('沙箱权限 · workstation-1'), findsOneWidget);
      expect(find.text('L1'), findsOneWidget);
      expect(find.text('L5'), findsOneWidget);
      expect(find.text('最高等级'), findsOneWidget);

      // Apply button starts disabled while the already-active level is selected.
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).onPressed, isNull);

      // Switch to readonly -> applies immediately with no confirmation dialog.
      await tester.tap(find.byKey(const ValueKey('sandbox-option-readonly')));
      await tester.pump();
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).onPressed, isNotNull);

      await tester.tap(find.byKey(const ValueKey('apply-sandbox-btn')));
      await settle(tester);

      expect(find.byType(CupertinoAlertDialog), findsNothing);
      expect(backend.sandboxUpdates, hasLength(1));
      expect(backend.sandboxUpdates.single, {'deviceId': 'workstation-1', 'level': 'readonly'});
      expect(find.descendant(of: find.byKey(const ValueKey('sandbox-pill-workstation-1')), matching: find.text('只读巡检')), findsOneWidget);
      expect(find.text('已将 workstation-1 沙箱权限切换为「只读巡检」'), findsOneWidget);

      // Open sheet again and switch to unrestricted -> warning + confirm dialog (cancel then confirm).
      await show(tester, sandboxBtn);
      await tester.tap(sandboxBtn);
      await settle(tester);

      final unrestrictedOption = find.byKey(const ValueKey('sandbox-option-unrestricted'));
      await show(tester, unrestrictedOption);
      await tester.tap(unrestrictedOption);
      await settle(tester);

      expect(find.textContaining('警告：「完全不限制」将允许主控 Neo'), findsOneWidget);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).destructive, isTrue);

      await tester.tap(find.byKey(const ValueKey('apply-sandbox-btn')));
      await settle(tester);

      expect(find.byType(CupertinoAlertDialog), findsOneWidget);
      expect(find.text('切换为「完全不限制」？'), findsOneWidget);
      final dialogTitleRich = tester.widget<RichText>(find.descendant(of: find.text('切换为「完全不限制」？'), matching: find.byType(RichText)));
      expect(dialogTitleRich.text.style?.fontFamilyFallback, contains(cjkFont));

      // Cancel dialog -> no API request, sheet remains open.
      await tester.tap(find.descendant(of: find.byType(CupertinoAlertDialog), matching: find.text('取消')));
      await settle(tester);
      expect(find.byType(CupertinoAlertDialog), findsNothing);
      expect(backend.sandboxUpdates, hasLength(1));
      expect(find.text('沙箱权限 · workstation-1'), findsOneWidget);

      // Confirm dialog -> sends PUT with level: 'unrestricted' and updates row to red unrestricted badge + access text.
      await tester.tap(find.byKey(const ValueKey('apply-sandbox-btn')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('confirm-unrestricted-btn')));
      await settle(tester);

      expect(backend.sandboxUpdates, hasLength(2));
      expect(backend.sandboxUpdates.last, {'deviceId': 'workstation-1', 'level': 'unrestricted'});
      final pill = tester.widget<Pill>(find.byKey(const ValueKey('sandbox-pill-workstation-1')));
      expect(pill.text, '完全不限制');
      expect(pill.dot, isTrue);
      expect(find.text('全文件系统访问 · 无命令限制'), findsOneWidget);
      expect(find.text('已将 workstation-1 沙箱权限切换为「完全不限制」'), findsOneWidget);

      // API error inside sheet keeps modal open and shows error notice.
      backend.sandboxError = 'Agent rejected policy update';
      await show(tester, sandboxBtn);
      await tester.tap(sandboxBtn);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('sandbox-option-corp')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('apply-sandbox-btn')));
      await settle(tester);
      expect(find.text('Agent rejected policy update'), findsOneWidget);
      expect(find.text('沙箱权限 · workstation-1'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('sandbox-cancel-btn')));
      await settle(tester);
      await app.close();
    });

    testWidgets('handles offline pending sync, locked sandbox policy, sync error display, and English strings', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice(
          'offline-node',
          status: 'offline',
          route: 'relay',
          sandboxLevel: 'personal',
          sandboxSyncError: 'Previous sync timed out',
          sandboxSyncState: 'error',
        )
        ..addDevice(
          'locked-node',
          status: 'online',
          route: 'lan',
          sandboxLevel: 'corp',
          sandboxLocked: true,
        );

      final app = await open(tester, backend, locale: const Locale('en'), size: narrow);

      await tester.tap(nav(2));
      await settle(tester);

      // Sync error is visible on offline-node.
      expect(find.byKey(const ValueKey('sandbox-error-offline-node')), findsOneWidget);
      expect(find.text('Previous sync timed out'), findsOneWidget);

      // Open sandbox sheet on locked-node -> shows locked hint and disables Apply.
      final lockedBtn = find.byKey(const ValueKey('sandbox-locked-node'));
      await show(tester, lockedBtn);
      await tester.tap(lockedBtn);
      await settle(tester);

      expect(find.text('Sandbox · locked-node'), findsOneWidget);
      expect(find.textContaining('lock_sandbox = true'), findsOneWidget);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).onPressed, isNull);
      final lockedDesktopOption = find.byKey(const ValueKey('sandbox-option-desktop'));
      await show(tester, lockedDesktopOption);
      await tester.tap(lockedDesktopOption);
      await tester.pump();
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).onPressed, isNull);

      await tester.tap(find.byKey(const ValueKey('sandbox-cancel-btn')));
      await settle(tester);

      // Open sandbox sheet on offline-node -> shows offline hint and queues pending sync.
      final offlineBtn = find.byKey(const ValueKey('sandbox-offline-node'));
      await show(tester, offlineBtn);
      await tester.tap(offlineBtn);
      await settle(tester);

      expect(find.textContaining('Device is offline; the new level will sync automatically'), findsOneWidget);
      final offlineDesktopOption = find.byKey(const ValueKey('sandbox-option-desktop'));
      await show(tester, offlineDesktopOption);
      await tester.tap(offlineDesktopOption);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('apply-sandbox-btn')));
      await settle(tester);

      expect(backend.sandboxUpdates.single, {'deviceId': 'offline-node', 'level': 'desktop'});
      expect(find.descendant(of: find.byKey(const ValueKey('sandbox-pending-offline-node')), matching: find.text('Pending → Desktop')), findsOneWidget);
      expect(find.textContaining('Saved target sandbox level "Desktop" for offline-node'), findsOneWidget);

      // Re-opening sheet while pending sync is active allows applying the current effective level to cancel/overwrite pending target.
      await show(tester, offlineBtn);
      await tester.tap(offlineBtn);
      await settle(tester);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('apply-sandbox-btn'))).onPressed, isNotNull);
      await tester.tap(find.byKey(const ValueKey('sandbox-cancel-btn')));
      await settle(tester);

      await app.close();
    });

    testWidgets('supports unrestricted profile preset in DeviceEnrollSheet', (tester) async {
      final backend = FakeBackend()..configureDevices(clusterId: 'personal');
      final app = await open(tester, backend);

      await tester.tap(nav(2));
      await settle(tester);

      await tester.tap(find.byKey(const ValueKey('add-device-btn')));
      await settle(tester);

      final unrestrictedProfile = find.byKey(const ValueKey('profile-unrestricted'));
      await show(tester, unrestrictedProfile);
      expect(find.text('最高等级'), findsOneWidget);
      expect(find.textContaining('警告：「完全不限制」将允许主控 Neo'), findsNothing);

      await tester.tap(unrestrictedProfile);
      await settle(tester);
      expect(find.textContaining('警告：「完全不限制」将允许主控 Neo'), findsOneWidget);

      final genBtn = find.byKey(const ValueKey('generate-install-cmd-btn'));
      await show(tester, genBtn);
      await tester.tap(genBtn);
      await settle(tester);

      expect(backend.createdEnrollments, hasLength(1));
      expect(backend.createdEnrollments.single['profile'], 'unrestricted');
      expect(find.textContaining('--profile unrestricted'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);
      await app.close();
    });

    testWidgets('displays device version, external IP, and physical location in Chinese and English on wide and narrow viewports', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'neo-ad0101', relayState: 'connected')
        ..addDevice(
          'os-macbook-pro',
          status: 'online',
          route: 'relay',
          agentVersion: '0.9.2',
          publicIp: '113.87.160.22',
          location: '中国 广东 深圳',
        )
        ..addDevice(
          'os-win-pc',
          status: 'online',
          route: 'p2p',
          agentVersion: '0.9.1',
          publicIp: '58.248.102.18',
          location: '中国 广东 广州',
        );

      final zhApp = await open(tester, backend, locale: const Locale('zh'), size: wide);
      await tester.tap(nav(2));
      await settle(tester);

      expect(find.text('v0.9.2'), findsWidgets);
      expect(find.text('v0.9.1'), findsOneWidget);
      expect(find.byKey(const ValueKey('device-ip-os-macbook-pro')), findsOneWidget);
      expect(find.text('113.87.160.22'), findsOneWidget);
      expect(find.byKey(const ValueKey('device-location-os-macbook-pro')), findsOneWidget);
      expect(find.text('中国 广东 深圳'), findsOneWidget);
      expect(find.text('外网 IP'), findsNWidgets(2));
      expect(find.text('物理地址'), findsNWidgets(2));
      await zhApp.close();

      final enApp = await open(tester, backend, locale: const Locale('en'), size: narrow, brightness: Brightness.dark);
      await tester.tap(nav(2));
      await settle(tester);

      expect(find.text('Public IP'), findsNWidgets(2));
      expect(find.text('Location'), findsNWidgets(2));
      expect(find.text('58.248.102.18'), findsOneWidget);
      expect(find.text('中国 广东 广州'), findsOneWidget);
      await enApp.close();
    });

    testWidgets('supports renaming devices, clearing back to default, and custom names across approvals, MCU relay chip, enrollment, and English dark mode', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice(
          'os-gpu-01',
          status: 'online',
          route: 'p2p',
          capabilities: ['exec', 'fs', 'relay', 'gpu'],
        )
        ..addDevice(
          'mcu-esp32-01',
          tier: 'mcu',
          status: 'online',
          route: 'via_tier1',
          relayNodeId: 'os-gpu-01',
        )
        ..addDeviceApproval(
          'apr-rename',
          shortCode: 'R9N4M2',
          deviceId: 'os-gpu-01',
          action: 'reboot',
        );

      // Verify ApiClient.renameDevice directly too.
      final api = backend.api();
      final directRenamed = await api.renameDevice('os-gpu-01', '临时名');
      expect((directRenamed.customName, directRenamed.hasCustomName, directRenamed.displayName), ('临时名', true, '临时名'));
      final directCleared = await api.renameDevice('os-gpu-01', null);
      expect((directCleared.customName, directCleared.hasCustomName, directCleared.displayName), (null, false, 'os-gpu-01'));
      backend.renamedDevices.clear();

      final app = await open(tester, backend);
      await tester.tap(nav(2));
      await settle(tester);

      // Open Rename sheet for Tier 1 OS device.
      final renameBtn = find.byKey(const ValueKey('rename-os-gpu-01'));
      await show(tester, renameBtn);
      await tester.tap(renameBtn);
      await settle(tester);

      expect(find.text('重命名设备'), findsOneWidget);
      expect(find.byKey(const ValueKey('rename-device-reset-btn')), findsNothing);

      // Overlong name displays backend validation error inline without closing modal.
      await tester.enterText(find.byKey(const ValueKey('rename-device-input')), '名' * 65);
      await tester.tap(find.byKey(const ValueKey('rename-device-save-btn')));
      await settle(tester);
      expect(find.textContaining('at most 64 characters'), findsOneWidget);
      expect(find.text('重命名设备'), findsOneWidget);

      // Valid Chinese custom name succeeds and propagates across fleet, approval row, and MCU relay chip.
      await tester.enterText(find.byKey(const ValueKey('rename-device-input')), '实验室 GPU 主机');
      await tester.tap(find.byKey(const ValueKey('rename-device-save-btn')));
      await settle(tester);

      expect(backend.renamedDevices.last, ('os-gpu-01', '实验室 GPU 主机'));
      expect(find.text('设备已重命名为「实验室 GPU 主机」'), findsOneWidget);
      expect(find.text('实验室 GPU 主机'), findsWidgets);
      expect(find.text('经由 实验室 GPU 主机'), findsOneWidget);

      // Remove confirmation dialog includes both custom name and underlying deviceId.
      final removeBtn = find.byKey(const ValueKey('remove-os-gpu-01'));
      await show(tester, removeBtn);
      await tester.tap(removeBtn);
      await settle(tester);
      expect(find.text('移除设备 实验室 GPU 主机 (os-gpu-01)？'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await settle(tester);

      // Enrollment sheet supports setting custom name for new Tier 1 & Tier 2 MCU devices and shows renamed Tier 1 in MCU picker.
      final addBtn = find.byKey(const ValueKey('add-device-btn'));
      await show(tester, addBtn);
      await tester.tap(addBtn);
      await settle(tester);

      await tester.enterText(find.byKey(const ValueKey('enroll-device-name')), '书房 Mac Studio');
      final genBtn = find.byKey(const ValueKey('generate-install-cmd-btn'));
      await show(tester, genBtn);
      await tester.tap(genBtn);
      await settle(tester);

      expect(backend.createdEnrollments.last['customName'], '书房 Mac Studio');
      expect(find.descendant(of: find.byType(DeviceEnrollSheet), matching: find.text('书房 Mac Studio')), findsOneWidget);

      // Switch to MCU tab: Tier 1 picker shows custom name + ID, and MCU form sends customName.
      await tester.tap(find.text('MCU'));
      await settle(tester);
      expect(find.text('实验室 GPU 主机 (os-gpu-01)'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('mcu-id-input')), 'mcu-study-01');
      await tester.enterText(find.byKey(const ValueKey('mcu-device-name')), '书房温湿度计');
      final installMcuBtn = find.byKey(const ValueKey('install-mcu-btn'));
      await show(tester, installMcuBtn);
      await tester.tap(installMcuBtn);
      await settle(tester);
      expect(backend.mcuInstalls.last['customName'], '书房温湿度计');
      expect(find.descendant(of: find.byKey(const ValueKey('mcu-install-result')), matching: find.text('书房温湿度计')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('enroll-close-btn')));
      await settle(tester);
      expect(find.text('书房温湿度计'), findsOneWidget);

      // Reset custom name back to default using Reset button inside Rename modal.
      await show(tester, renameBtn);
      await tester.tap(renameBtn);
      await settle(tester);
      final resetBtn = find.byKey(const ValueKey('rename-device-reset-btn'));
      expect(resetBtn, findsOneWidget);
      await tester.tap(resetBtn);
      await settle(tester);
      expect(backend.renamedDevices.last, ('os-gpu-01', null));
      expect(find.text('已恢复默认设备名称'), findsOneWidget);
      expect(find.text('经由 os-gpu-01'), findsWidgets);

      await app.close();

      // English dark mode narrow layout check for Rename modal.
      final appEn = await open(tester, backend, locale: const Locale('en'), size: narrow, brightness: Brightness.dark);
      await tester.tap(nav(2));
      await settle(tester);
      final renameEn = find.byKey(const ValueKey('rename-os-gpu-01'));
      await show(tester, renameEn);
      await tester.tap(renameEn);
      await settle(tester);
      expect(find.text('Rename device'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('rename-device-input')), 'Office GPU');
      await tester.tap(find.byKey(const ValueKey('rename-device-save-btn')));
      await settle(tester);
      expect(find.text('Device renamed to "Office GPU"'), findsOneWidget);
      await appEn.close();
    });

    testWidgets('shows MCP summary pill only when discovered > 0 on Tier 1 rows and supports full MCP discovery, policy, inspect, restart, and stop flows', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'personal')
        ..addDevice('mac-studio', customName: '书房 Mac', status: 'online', route: 'p2p', sandboxLevel: 'desktop')
        ..addDevice('linux-clean', status: 'online', route: 'lan', sandboxLevel: 'personal')
        ..addDevice('esp32-node', tier: 'mcu', status: 'online', route: 'via_tier1', relayNodeId: 'mac-studio')
        ..setDeviceMcp(
          'mac-studio',
          servers: [
            {
              'serverId': 'claude_desktop:github',
              'name': 'github',
              'source': 'claude_desktop',
              'transport': 'stdio',
              'commandPreview': 'npx -y @modelcontextprotocol/server-github',
              'envKeys': ['GITHUB_PERSONAL_ACCESS_TOKEN'],
              'authRequired': true,
              'trustState': 'enabled',
              'callMode': 'auto_readonly',
              'runtimeState': 'running',
              'toolCount': 2,
            },
            {
              'serverId': 'cursor:filesystem',
              'name': 'filesystem',
              'source': 'cursor',
              'transport': 'stdio',
              'commandPreview': 'npx -y @modelcontextprotocol/server-filesystem /workspace',
              'envKeys': <String>[],
              'authRequired': false,
              'trustState': 'discovered',
              'callMode': 'disabled',
              'runtimeState': 'stopped',
            },
          ],
          toolsByServer: {
            'claude_desktop:github': [
              {
                'name': 'list_pull_requests',
                'description': 'List open pull requests in a repository',
                'readOnlyHint': true,
              },
              {
                'name': 'merge_pull_request',
                'description': 'Merge a pull request into the default branch',
                'destructiveHint': true,
              },
            ],
            'cursor:filesystem': [
              {
                'name': 'read_text_file',
                'description': 'Read UTF-8 text file',
                'readOnlyHint': true,
              },
            ],
          },
        )
        ..setDeviceMcp('linux-clean', servers: const []);

      final app = await open(tester, backend, bundledCjk: true);
      await tester.tap(nav(2));
      await settle(tester);

      // Tier 1 with discovered > 0 renders compact MCP pill & button; 0 discovered hides pill; MCU hides both.
      final mcpPill = find.byKey(const ValueKey('mcp-pill-mac-studio'));
      expect(mcpPill, findsOneWidget);
      expect(find.descendant(of: mcpPill, matching: find.text('MCP 1/2')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-mac-studio')), findsOneWidget);

      expect(find.byKey(const ValueKey('mcp-pill-linux-clean')), findsNothing);
      expect(find.byKey(const ValueKey('mcp-linux-clean')), findsOneWidget);

      expect(find.byKey(const ValueKey('mcp-pill-esp32-node')), findsNothing);
      expect(find.byKey(const ValueKey('mcp-esp32-node')), findsNothing);

      // Open MCP sheet for mac-studio.
      final openMcpBtn = find.byKey(const ValueKey('mcp-mac-studio'));
      await show(tester, openMcpBtn);
      await tester.tap(openMcpBtn);
      await settle(tester);

      expect(find.text('书房 Mac · 本机 MCP 服务'), findsOneWidget);
      final sheetTitleRich = tester.widget<RichText>(find.descendant(of: find.text('书房 Mac · 本机 MCP 服务'), matching: find.byType(RichText)));
      expect(sheetTitleRich.text.style?.fontFamilyFallback, contains(cjkFont));
      expect(find.text('凭据与环境变量值仅保留在该设备本机，不会上传到主控。'), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-server-claude_desktop:github')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-server-cursor:filesystem')), findsOneWidget);
      expect(find.text('Claude Desktop'), findsOneWidget);
      expect(find.text('Cursor'), findsOneWidget);
      expect(find.textContaining('GITHUB_PERSONAL_ACCESS_TOKEN'), findsOneWidget);
      expect(find.textContaining('npx -y @modelcontextprotocol/server-github'), findsOneWidget);

      // Desktop sandbox shows loopback probe toggle; enable it and rescan.
      final loopbackSwitch = find.byKey(const ValueKey('mcp-loopback-switch'));
      expect(loopbackSwitch, findsOneWidget);
      await tester.tap(loopbackSwitch);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('mcp-rescan-btn')));
      await settle(tester);

      expect(backend.mcpDiscovers.last, {'deviceId': 'mac-studio', 'includeLoopbackProbe': true});
      expect(find.byKey(const ValueKey('mcp-server-loopback:local-http')), findsOneWidget);
      expect(find.text('http://127.0.0.1:8765/mcp'), findsOneWidget);

      // Enable cursor:filesystem via toggle switch -> call mode selector pills appear & parent badge updates to MCP 2/3.
      final fsToggle = find.byKey(const ValueKey('mcp-toggle-cursor:filesystem'));
      await show(tester, fsToggle);
      await tester.tap(fsToggle);
      await settle(tester);
      expect(backend.mcpPolicyUpdates.last, {'deviceId': 'mac-studio', 'serverId': 'cursor:filesystem', 'enabled': true});
      expect(find.byKey(const ValueKey('mcp-mode-cursor:filesystem-confirm_all')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-mode-cursor:filesystem-auto_readonly')), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-mode-cursor:filesystem-auto_all')), findsOneWidget);

      // Switch callMode on claude_desktop:github to confirm_all.
      final confirmAllChip = find.byKey(const ValueKey('mcp-mode-claude_desktop:github-confirm_all'));
      await show(tester, confirmAllChip);
      await tester.tap(confirmAllChip);
      await settle(tester);
      expect(backend.mcpPolicyUpdates.last, {'deviceId': 'mac-studio', 'serverId': 'claude_desktop:github', 'callMode': 'confirm_all'});

      // Inspect tools on claude_desktop:github -> expands inline with Read-only & Destructive badges.
      final inspectGithub = find.byKey(const ValueKey('mcp-inspect-claude_desktop:github'));
      await show(tester, inspectGithub);
      await tester.tap(inspectGithub);
      await settle(tester);
      expect(backend.mcpInspects.last['serverId'], 'claude_desktop:github');
      expect(find.byKey(const ValueKey('mcp-tools-claude_desktop:github')), findsOneWidget);
      expect(find.text('list_pull_requests'), findsOneWidget);
      expect(find.text('merge_pull_request'), findsOneWidget);
      expect(find.text('只读'), findsOneWidget);
      expect(find.text('变更/高危'), findsOneWidget);
      expect(find.text('收起工具'), findsOneWidget);

      // Collapse tools list.
      await tester.tap(inspectGithub);
      await tester.pump();
      expect(find.byKey(const ValueKey('mcp-tools-claude_desktop:github')), findsNothing);

      // Restart running server.
      final restartGithub = find.byKey(const ValueKey('mcp-restart-claude_desktop:github'));
      await show(tester, restartGithub);
      await tester.tap(restartGithub);
      await settle(tester);
      expect(backend.mcpRestarts.single, {'deviceId': 'mac-studio', 'serverId': 'claude_desktop:github'});
      expect(find.text('已重启 MCP 服务会话'), findsOneWidget);

      // Stop running server -> runtime changes to stopped and stop button hides.
      final stopGithub = find.byKey(const ValueKey('mcp-stop-claude_desktop:github'));
      await show(tester, stopGithub);
      await tester.tap(stopGithub);
      await settle(tester);
      expect(backend.mcpStops.single, {'deviceId': 'mac-studio', 'serverId': 'claude_desktop:github'});
      expect(find.text('已停止 MCP 服务会话'), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-stop-claude_desktop:github')), findsNothing);

      // Close sheet and verify parent device row MCP pill updated to MCP 2/3.
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);
      expect(find.descendant(of: find.byKey(const ValueKey('mcp-pill-mac-studio')), matching: find.text('MCP 2/3')), findsOneWidget);

      // Re-open and disable cursor:filesystem -> call mode chips hide and badge returns to MCP 1/3.
      await show(tester, openMcpBtn);
      await tester.tap(openMcpBtn);
      await settle(tester);
      final fsDisableToggle = find.byKey(const ValueKey('mcp-toggle-cursor:filesystem'));
      await show(tester, fsDisableToggle);
      await tester.tap(fsDisableToggle);
      await settle(tester);
      expect(backend.mcpPolicyUpdates.last, {'deviceId': 'mac-studio', 'serverId': 'cursor:filesystem', 'enabled': false});
      expect(find.byKey(const ValueKey('mcp-mode-cursor:filesystem-confirm_all')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);
      expect(find.descendant(of: find.byKey(const ValueKey('mcp-pill-mac-studio')), matching: find.text('MCP 1/3')), findsOneWidget);

      await app.close();
    });

    testWidgets('handles unsupported agent, locked sandbox, blocked server, empty discovery, offline cache, errors, and narrow dark English layout', (tester) async {
      final backend = FakeBackend()
        ..configureDevices(clusterId: 'corp-cluster')
        ..addDevice('legacy-agent', status: 'online', route: 'relay', sandboxLevel: 'personal')
        ..addDevice('locked-host', status: 'online', route: 'lan', sandboxLevel: 'corp', sandboxLocked: true)
        ..addDevice('empty-host', status: 'online', route: 'p2p', sandboxLevel: 'personal')
        ..addDevice('offline-host', status: 'offline', route: 'relay', sandboxLevel: 'personal')
        ..addDevice('offline-cached', status: 'offline', route: 'relay', sandboxLevel: 'personal')
        ..setDeviceMcp('legacy-agent', supported: false)
        ..setDeviceMcp(
          'locked-host',
          warnings: ['Skipped 1 invalid config file'],
          servers: [
            {
              'serverId': 'neo:internal',
              'name': 'internal-db',
              'source': 'neo',
              'transport': 'streamable_http',
              'urlSanitized': 'http://127.0.0.1:7000/mcp',
              'trustState': 'enabled',
              'callMode': 'confirm_all',
              'runtimeState': 'error',
              'lastError': 'Connection refused on port 7000',
            },
            {
              'serverId': 'cursor:blocked',
              'name': 'blocked-tool',
              'source': 'cursor',
              'transport': 'stdio',
              'commandPreview': 'npx evil-mcp',
              'trustState': 'blocked_by_policy',
              'callMode': 'disabled',
              'runtimeState': 'stopped',
            },
          ],
        )
        ..setDeviceMcp('empty-host', supported: true, servers: const [])
        ..setDeviceMcp('offline-host', supported: true, servers: const [])
        ..setDeviceMcp(
          'offline-cached',
          supported: true,
          servers: [
            {
              'serverId': 'codex:sqlite',
              'name': 'sqlite',
              'source': 'codex',
              'transport': 'stdio',
              'commandPreview': 'uvx mcp-server-sqlite',
              'trustState': 'discovered',
              'callMode': 'disabled',
              'runtimeState': 'stopped',
            },
          ],
        );

      final app = await open(tester, backend, locale: const Locale('en'), size: narrow, brightness: Brightness.dark);
      await tester.tap(nav(2));
      await settle(tester);

      // 1. Unsupported agent shows upgrade guidance and disables Rescan.
      final legacyBtn = find.byKey(const ValueKey('mcp-legacy-agent'));
      await show(tester, legacyBtn);
      await tester.tap(legacyBtn);
      await settle(tester);
      expect(find.text('legacy-agent · Local MCP'), findsOneWidget);
      expect(find.textContaining('does not support local MCP discovery and proxy yet'), findsOneWidget);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('mcp-rescan-btn'))).onPressed, isNull);
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);

      // 2. Locked host + blocked server + error display + inspect error handling.
      final lockedBtn = find.byKey(const ValueKey('mcp-locked-host'));
      await show(tester, lockedBtn);
      await tester.tap(lockedBtn);
      await settle(tester);
      expect(find.textContaining('lock_sandbox = true'), findsOneWidget);
      expect(find.text('Skipped 1 invalid config file'), findsOneWidget);
      expect(find.text('Connection refused on port 7000'), findsOneWidget);
      expect(find.text('Blocked'), findsOneWidget);
      expect(find.text('Error'), findsOneWidget);
      // Personal/corp sandbox does not show loopback probe toggle.
      expect(find.byKey(const ValueKey('mcp-loopback-switch')), findsNothing);
      // Toggles and blocked inspect button are disabled.
      expect(tester.widget<CupertinoSwitch>(find.byKey(const ValueKey('mcp-toggle-neo:internal'))).onChanged, isNull);
      expect(tester.widget<CupertinoSwitch>(find.byKey(const ValueKey('mcp-toggle-cursor:blocked'))).onChanged, isNull);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('mcp-inspect-cursor:blocked'))).onPressed, isNull);

      // Inspect error renders inline cleanly.
      backend.mcpInspectError = 'Handshake timed out';
      final inspectInternal = find.byKey(const ValueKey('mcp-inspect-neo:internal'));
      await show(tester, inspectInternal);
      await tester.tap(inspectInternal);
      await settle(tester);
      expect(find.text('Handshake timed out'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);

      // 3. Empty discovered online device shows empty guidance and enables Rescan.
      final emptyBtn = find.byKey(const ValueKey('mcp-empty-host'));
      await show(tester, emptyBtn);
      await tester.tap(emptyBtn);
      await settle(tester);
      expect(find.textContaining('No local MCP servers discovered yet'), findsOneWidget);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('mcp-rescan-btn'))).onPressed, isNotNull);
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);

      // 4. Offline device with no cache shows offline notice and disables Rescan.
      final offlineBtn = find.byKey(const ValueKey('mcp-offline-host'));
      await show(tester, offlineBtn);
      await tester.tap(offlineBtn);
      await settle(tester);
      expect(find.textContaining('Device is offline with no cached MCP catalog'), findsOneWidget);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('mcp-rescan-btn'))).onPressed, isNull);
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);

      // 5. Offline device with cached servers renders MCP 0/1 pill on row, cached list in sheet, and disables mutations.
      final cachedPill = find.byKey(const ValueKey('mcp-pill-offline-cached'));
      expect(cachedPill, findsOneWidget);
      expect(find.descendant(of: cachedPill, matching: find.text('MCP 0/1')), findsOneWidget);
      final cachedBtn = find.byKey(const ValueKey('mcp-offline-cached'));
      await show(tester, cachedBtn);
      await tester.tap(cachedBtn);
      await settle(tester);
      expect(find.textContaining('showing the last cached MCP catalog'), findsOneWidget);
      expect(find.byKey(const ValueKey('mcp-server-codex:sqlite')), findsOneWidget);
      expect(find.text('Codex'), findsOneWidget);
      expect(tester.widget<CupertinoSwitch>(find.byKey(const ValueKey('mcp-toggle-codex:sqlite'))).onChanged, isNull);
      expect(tester.widget<ActionButton>(find.byKey(const ValueKey('mcp-rescan-btn'))).onPressed, isNull);
      await tester.tap(find.byKey(const ValueKey('mcp-close-btn')));
      await settle(tester);

      await app.close();
    });
  });
}
