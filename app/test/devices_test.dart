import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neo_agent/main.dart';
import 'package:neo_agent/src/api/models.dart';
import 'package:neo_agent/src/qr/qr_view.dart';
import 'package:neo_agent/src/state/app_state.dart';
import 'package:neo_agent/src/ui/device_enroll_sheet.dart';
import 'package:neo_agent/src/ui/theme.dart' show cjkFont;

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
            'manifest': {
              'device_id': 'edge-pi-01',
              'tier': 'os',
              'os': 'linux',
              'arch': 'arm64',
              'hostname': 'pi-rack',
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
  });
}
