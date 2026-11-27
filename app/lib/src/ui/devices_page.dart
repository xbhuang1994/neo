/// Multi-device control plane page: cluster setup, relay status, risk approvals, active enrollments, and device fleet.
library;

import 'dart:async';
import 'dart:convert';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../platform/host.dart';
import '../state/app_state.dart';
import 'device_enroll_sheet.dart';
import 'format.dart';
import 'scope.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets.dart';

/// Relay status label and tint color shared between [DevicesPage] and [SettingsPage].
(String, Color) relayStatusAppearance(DeviceControlConfig? config, Strings strings, Palette palette) {
  if (config == null || !config.configured) {
    return (strings.devicesNotConfigured, palette.gray);
  }
  return switch (config.relayState) {
    'connected' => (strings.relayConnected, palette.green),
    'connecting' => (strings.relayConnecting, palette.orange),
    'reconnecting' => (strings.relayReconnecting, palette.orange),
    _ => (strings.relayOffline, palette.gray),
  };
}

/// Sandbox permission level label and tint color shared across device rows and sheets.
(String, Color) sandboxLevelAppearance(String level, Strings strings, Palette palette) => switch (level) {
  'readonly' => (strings.sandboxLevelLabel('readonly'), palette.gray),
  'corp' => (strings.sandboxLevelLabel('corp'), palette.accent),
  'personal' => (strings.sandboxLevelLabel('personal'), palette.green),
  'desktop' => (strings.sandboxLevelLabel('desktop'), palette.purple),
  'unrestricted' => (strings.sandboxLevelLabel('unrestricted'), palette.red),
  _ => (strings.sandboxLevelLabel(level), palette.gray),
};

/// The Devices tab: cluster initialization, live relay bar, approvals, active enrollment tickets, and fleet management.
class DevicesPage extends StatefulWidget {
  const DevicesPage({super.key, required this.onOpenSettings});

  final VoidCallback onOpenSettings;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  final ScrollController _scroll = ScrollController();

  // Uninitialized setup form controllers.
  final TextEditingController _initRelayUrl = TextEditingController();
  final TextEditingController _initClusterId = TextEditingController();
  final TextEditingController _initClusterSecret = TextEditingController();
  final TextEditingController _initMasterNodeId = TextEditingController();
  final TextEditingController _initE2eKey = TextEditingController();
  ApiClient? _seededClient;
  bool _initShowAdvanced = false;
  bool _initBusy = false;
  String? _initError;

  // Per-row action state on the configured view.
  final Set<String> _busyApprovals = {};
  final Set<String> _busyEnrollments = {};
  final Set<String> _pingingDevices = {};
  final Set<String> _updatingDevices = {};
  final Set<String> _removingDevices = {};
  final Map<String, DevicePingResult> _pingResults = {};
  final Map<String, String> _pingErrors = {};
  final Map<String, DeviceUpdateResult> _updateResults = {};
  final Map<String, String> _updateErrors = {};

  String? _toast;
  bool _toastGood = true;
  Timer? _toastTimer;
  Timer? _ttlTimer;

  @override
  void dispose() {
    _toastTimer?.cancel();
    _ttlTimer?.cancel();
    _scroll.dispose();
    for (final c in [_initRelayUrl, _initClusterId, _initClusterSecret, _initMasterNodeId, _initE2eKey]) {
      c.dispose();
    }
    super.dispose();
  }

  void _syncTtlTimer(bool hasActiveEnrollments) {
    if (hasActiveEnrollments) {
      _ttlTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _ttlTimer?.cancel();
      _ttlTimer = null;
    }
  }

  void _showToast(String message, {bool good = true}) {
    _toastTimer?.cancel();
    setState(() {
      _toast = message;
      _toastGood = good;
    });
    _toastTimer = Timer(const Duration(seconds: 4), () {
      if (mounted) setState(() => _toast = null);
    });
  }

  void _seedInitFields(ApiClient? client, DeviceControlConfig config) {
    if (identical(_seededClient, client)) return;
    _seededClient = client;
    _initRelayUrl.text = (config.defaultRelayUrl != null && config.defaultRelayUrl!.isNotEmpty)
        ? config.defaultRelayUrl!
        : (config.relayUrl ?? '');
    _initClusterId.text = config.clusterId;
    _initMasterNodeId.text = config.masterNodeId;
  }

  Future<void> _initCluster(AppState state, DeviceControlConfig config) async {
    final api = state.client;
    if (api == null) return;
    setState(() {
      _initBusy = true;
      _initError = null;
    });
    try {
      final secret = _initClusterSecret.text.trim();
      await api.initDeviceConfig(
        relayUrl: _initRelayUrl.text.trim(),
        clusterId: _initClusterId.text.trim(),
        clusterSecret: secret.isEmpty ? null : secret,
        masterNodeId: _initMasterNodeId.text.trim(),
        e2eKey: _initE2eKey.text.trim(),
        autoDetectLocalRelay: config.localRelayDetected && secret.isEmpty,
        enabled: true,
      );
      await state.refresh();
    } on ApiException catch (error) {
      if (mounted) setState(() => _initError = error.message);
    } finally {
      if (mounted) setState(() => _initBusy = false);
    }
  }

  Future<void> _openEnrollSheet(AppState state, {String initialTab = 'linux', DeviceEnrollment? existingEnrollment}) async {
    final api = state.client;
    if (api == null) return;
    await showDeviceEnrollSheet(
      context,
      api: api,
      devices: state.devices,
      initialTab: initialTab,
      existingEnrollment: existingEnrollment,
      onChanged: () => unawaited(state.refresh()),
    );
  }

  Future<void> _openClusterSettings(AppState state, DeviceControlConfig config) async {
    final api = state.client;
    if (api == null) return;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (sheet) => _ClusterSettingsSheet(
        api: api,
        config: config,
        onSaved: () => unawaited(state.refresh()),
      ),
    );
  }

  Future<void> _openSandboxSheet(AppState state, DeviceTwin device) async {
    final api = state.client;
    if (api == null) return;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (sheet) => _DeviceSandboxSheet(
        api: api,
        device: device,
        onSaved: (result) {
          unawaited(state.refresh());
          if (!mounted) return;
          final strings = Strings.read(context);
          final levelLabel = strings.sandboxLevelLabel(result.level);
          final good = result.applied && result.warning == null;
          final message = result.applied
              ? (result.warning != null ? '${strings.sandboxUpdated(device.deviceId, levelLabel)} (${result.warning})' : strings.sandboxUpdated(device.deviceId, levelLabel))
              : result.pending
              ? (result.warning ?? strings.sandboxQueuedNotice(device.deviceId, levelLabel))
              : (result.error ?? result.warning ?? strings.sandboxUpdated(device.deviceId, levelLabel));
          _showToast(message, good: good);
        },
      ),
    );
  }

  Future<void> _openRenameSheet(AppState state, DeviceTwin device) async {
    final api = state.client;
    if (api == null) return;
    final strings = Strings.read(context);
    final updated = await showCupertinoModalPopup<DeviceTwin>(
      context: context,
      builder: (sheet) => _RenameDeviceSheet(api: api, device: device),
    );
    if (updated == null || !mounted) return;
    await state.refresh();
    if (mounted) {
      _showToast(
        updated.hasCustomName ? strings.deviceRenamed(updated.displayName) : strings.deviceNameCleared,
        good: true,
      );
    }
  }

  Future<void> _handleApproval(AppState state, DeviceApproval approval, {required bool approve}) async {
    final api = state.client;
    if (api == null) return;
    final strings = Strings.read(context);
    setState(() => _busyApprovals.add(approval.id));
    try {
      if (approve) {
        await api.approveDeviceApproval(approval.id);
      } else {
        await api.rejectDeviceApproval(approval.id);
      }
      await state.refresh();
      if (mounted) {
        _showToast(approve ? strings.approvalApproved : strings.approvalRejected, good: true);
      }
    } on ApiException catch (error) {
      if (mounted) _showToast(error.message, good: false);
    } finally {
      if (mounted) setState(() => _busyApprovals.remove(approval.id));
    }
  }

  Future<void> _revokeEnrollment(AppState state, DeviceEnrollment enrollment) async {
    final api = state.client;
    if (api == null) return;
    final strings = Strings.read(context);
    setState(() => _busyEnrollments.add(enrollment.id));
    try {
      await api.revokeDeviceEnrollment(enrollment.id);
      await state.refresh();
      if (mounted) _showToast(strings.ticketRevoked, good: true);
    } on ApiException catch (error) {
      if (mounted) _showToast(error.message, good: false);
    } finally {
      if (mounted) setState(() => _busyEnrollments.remove(enrollment.id));
    }
  }

  Future<void> _pingDevice(AppState state, DeviceTwin device) async {
    final api = state.client;
    if (api == null) return;
    setState(() {
      _pingingDevices.add(device.deviceId);
      _pingErrors.remove(device.deviceId);
    });
    try {
      final result = await api.pingDevice(device.deviceId);
      if (!mounted) return;
      setState(() {
        _pingResults[device.deviceId] = result;
        if (!result.ok && result.error != null) {
          _pingErrors[device.deviceId] = result.error!;
        }
      });
      unawaited(state.refresh());
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _pingResults.remove(device.deviceId);
          _pingErrors[device.deviceId] = error.message;
        });
      }
    } finally {
      if (mounted) setState(() => _pingingDevices.remove(device.deviceId));
    }
  }

  Future<void> _updateDevice(AppState state, DeviceTwin device, String? masterVersion) async {
    final api = state.client;
    if (api == null) return;
    setState(() {
      _updatingDevices.add(device.deviceId);
      _updateErrors.remove(device.deviceId);
    });
    try {
      final result = await api.updateDevice(device.deviceId, targetVersion: masterVersion);
      if (!mounted) return;
      setState(() {
        _updateResults[device.deviceId] = result;
        if (!result.ok && result.status != 'manual_upgrade_required') {
          _updateErrors[device.deviceId] = result.error ?? result.message;
        }
      });
      unawaited(state.refresh());
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _updateResults.remove(device.deviceId);
          _updateErrors[device.deviceId] = error.message;
        });
      }
    } finally {
      if (mounted) setState(() => _updatingDevices.remove(device.deviceId));
    }
  }

  void _copyUpgradeCommand(DeviceTwin device, String cmd) {
    final strings = Strings.read(context);
    unawaited(copyToClipboard(cmd));
    _showToast('${strings.upgradeCommandCopied} (${device.deviceId})', good: true);
  }

  String _uninstallCommandFor(DeviceTwin device, List<DeviceEnrollment> enrollments) {
    for (final enrollment in enrollments) {
      if (enrollment.enrolledDeviceIds.contains(device.deviceId) && enrollment.commands.uninstall.isNotEmpty) {
        return enrollment.commands.uninstall;
      }
    }
    if (device.isMcu) {
      return '# MCU ${device.deviceId}: re-flash firmware or remove from Master Neo';
    }
    final cluster = device.clusterId.isNotEmpty ? device.clusterId : 'default';
    return 'neo-agent-os uninstall --cluster $cluster';
  }

  void _copyUninstall(DeviceTwin device, List<DeviceEnrollment> enrollments) {
    final strings = Strings.read(context);
    final cmd = _uninstallCommandFor(device, enrollments);
    unawaited(copyToClipboard(cmd));
    _showToast('${strings.uninstallCopied} (${device.displayName})', good: true);
  }

  Future<void> _removeDevice(AppState state, DeviceTwin device) async {
    final api = state.client;
    if (api == null) return;
    final strings = Strings.read(context);
    final deviceLabel = device.hasCustomName ? '${device.displayName} (${device.deviceId})' : device.deviceId;
    final confirmed = await showCupertinoDialog<bool>(
      context: context,
      builder: (dialog) {
        final fonts = fallbackFonts(dialog);
        return CupertinoAlertDialog(
          title: Text(strings.removeDeviceConfirmTitle(deviceLabel), style: fonts),
          content: Text(strings.removeDeviceConfirmBody, style: fonts),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.of(dialog).pop(false), child: Text(strings.cancel, style: fonts)),
            CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.of(dialog).pop(true), child: Text(strings.removeDevice, style: fonts)),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    setState(() => _removingDevices.add(device.deviceId));
    try {
      await api.removeDevice(device.deviceId);
      _pingResults.remove(device.deviceId);
      _pingErrors.remove(device.deviceId);
      _updateResults.remove(device.deviceId);
      _updateErrors.remove(device.deviceId);
      await state.refresh();
    } on ApiException catch (error) {
      if (mounted) _showToast(error.message, good: false);
    } finally {
      if (mounted) setState(() => _removingDevices.remove(device.deviceId));
    }
  }

  Widget _buildUninitialized(AppState state, DeviceControlConfig config) {
    _seedInitFields(state.client, config);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);

    return CupertinoScrollbar(
      controller: _scroll,
      child: ListView(
        controller: _scroll,
        primary: false,
        padding: const EdgeInsets.symmetric(horizontal: grid * 2.5, vertical: grid * 3),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Group(
                title: strings.deviceClusterSetup,
                footer: strings.deviceClusterSetupFooter,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(color: palette.accent.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(9)),
                          child: Icon(CupertinoIcons.desktopcomputer, size: 19, color: palette.accent),
                        ),
                        const SizedBox(width: 12),
                        Expanded(child: Text(strings.deviceClusterSetupIntro, style: typo.footnote)),
                      ],
                    ),
                  ),
                  Field(
                    label: strings.relayUrlLabel,
                    below: Box(
                      key: const ValueKey('init-relay-url'),
                      controller: _initRelayUrl,
                      placeholder: config.defaultRelayUrl ?? 'https://neo.1inch.cn:18443',
                      mono: true,
                      keyboard: TextInputType.url,
                    ),
                  ),
                  Field(
                    label: strings.clusterIdLabel,
                    below: Box(
                      key: const ValueKey('init-cluster-id'),
                      controller: _initClusterId,
                      placeholder: strings.clusterIdPlaceholder,
                      mono: true,
                    ),
                  ),
                  if (config.localRelayDetected)
                    Field(
                      label: strings.clusterSecretLabel,
                      trailing: Pill(strings.localRelayDetectedBadge, color: palette.green, dot: true),
                      below: Text(strings.localRelayDetectedHint, style: typo.caption),
                    )
                  else
                    Field(
                      label: strings.clusterSecretLabel,
                      below: Box(
                        key: const ValueKey('init-cluster-secret'),
                        controller: _initClusterSecret,
                        placeholder: strings.clusterSecretPlaceholder,
                        obscure: true,
                        mono: true,
                      ),
                    ),
                  Tappable(
                    key: const ValueKey('init-advanced-toggle'),
                    borderRadius: 0,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                    onTap: () => setState(() => _initShowAdvanced = !_initShowAdvanced),
                    child: Row(
                      children: [
                        Icon(CupertinoIcons.slider_horizontal_3, size: 16, color: palette.accent),
                        const SizedBox(width: 8),
                        Expanded(child: Text(strings.advancedOptions, style: typo.body.copyWith(color: palette.accent))),
                        Icon(_initShowAdvanced ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 15, color: palette.secondary),
                      ],
                    ),
                  ),
                  if (_initShowAdvanced) ...[
                    Field(
                      label: strings.masterNodeIdLabel,
                      below: Box(
                        key: const ValueKey('init-master-node-id'),
                        controller: _initMasterNodeId,
                        placeholder: config.masterNodeId.isNotEmpty ? config.masterNodeId : 'master-1',
                        mono: true,
                      ),
                    ),
                    Field(
                      label: strings.e2eKeyLabel,
                      below: Box(
                        key: const ValueKey('init-e2e-key'),
                        controller: _initE2eKey,
                        placeholder: strings.e2eKeyPlaceholder,
                        obscure: true,
                        mono: true,
                      ),
                    ),
                    if (config.localRelayDetected)
                      Field(
                        label: strings.clusterSecretLabel,
                        below: Box(
                          key: const ValueKey('init-cluster-secret'),
                          controller: _initClusterSecret,
                          placeholder: strings.clusterSecretPlaceholder,
                          obscure: true,
                          mono: true,
                        ),
                      ),
                  ],
                  Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (_initError != null) ...[
                          Notice(_initError!),
                          const SizedBox(height: 12),
                        ],
                        ActionButton(
                          key: const ValueKey('init-cluster-btn'),
                          label: strings.initClusterAndConnect,
                          busy: _initBusy,
                          onPressed: () => unawaited(_initCluster(state, config)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildConfigured(AppState state, DevicesOverview overview) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final config = overview.config;
    final masterVersion = config.targetVersion;
    final (relayLabel, relayColor) = relayStatusAppearance(config, strings, palette);
    final pendingApprovals = overview.pendingApprovals;
    final activeEnrollments = overview.activeEnrollments;
    final sortedDevices = List<DeviceTwin>.from(overview.devices)
      ..sort((a, b) {
        if (a.isTier1 != b.isTier1) return a.isTier1 ? -1 : 1;
        if (a.isOnline != b.isOnline) return a.isOnline ? -1 : 1;
        return a.deviceId.compareTo(b.deviceId);
      });
    final deviceById = {for (final d in overview.devices) d.deviceId: d};

    return CupertinoScrollbar(
      controller: _scroll,
      child: ListView(
        controller: _scroll,
        primary: false,
        padding: const EdgeInsets.symmetric(horizontal: grid * 2.5, vertical: grid * 3),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_toast != null) ...[
                    Notice(_toast!, good: _toastGood),
                    const SizedBox(height: grid * 2),
                  ],

                  // Cluster Status Bar Group
                  Group(
                    title: strings.clusterStatus,
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: 10,
                              runSpacing: 8,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                Pill(relayLabel, color: relayColor, dot: true),
                                Text(config.clusterId, style: typo.mono.copyWith(color: palette.label, fontWeight: FontWeight.w600)),
                                Text(
                                  strings.devicesOnlineSummary(overview.onlineDevicesCount, overview.devices.length),
                                  style: typo.footnote,
                                ),
                                if (masterVersion != null)
                                  Text('v$masterVersion', style: typo.caption),
                              ],
                            ),
                            if (config.relayUrl != null && config.relayUrl!.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(config.relayUrl!, style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
                            ],
                            const SizedBox(height: 14),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                ActionButton(
                                  key: const ValueKey('add-device-btn'),
                                  label: strings.addDeviceCta,
                                  onPressed: () => unawaited(_openEnrollSheet(state, initialTab: 'linux')),
                                ),
                                ActionButton(
                                  key: const ValueKey('add-mcu-btn'),
                                  label: strings.connectMcu,
                                  plain: true,
                                  onPressed: () => unawaited(_openEnrollSheet(state, initialTab: 'mcu')),
                                ),
                                ActionButton(
                                  key: const ValueKey('cluster-settings-btn'),
                                  label: strings.clusterSettings,
                                  plain: true,
                                  onPressed: () => unawaited(_openClusterSettings(state, config)),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),

                  // Pending Approvals Group
                  if (pendingApprovals.isNotEmpty)
                    Group(
                      title: '${strings.pendingApprovals} (${pendingApprovals.length})',
                      children: [
                        for (final approval in pendingApprovals) _buildApprovalRow(state, approval, deviceById),
                      ],
                    ),

                  // Active Enrollments Group
                  if (activeEnrollments.isNotEmpty)
                    Group(
                      title: '${strings.activeEnrollments} (${activeEnrollments.length})',
                      children: [
                        for (final enrollment in activeEnrollments) _buildEnrollmentRow(state, enrollment),
                      ],
                    ),

                  // Device Fleet Group
                  Group(
                    title: '${strings.deviceFleet} (${sortedDevices.length})',
                    children: [
                      if (sortedDevices.isEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: EmptyState(
                            icon: CupertinoIcons.desktopcomputer,
                            title: strings.noDevicesTitle,
                            hint: strings.noDevicesHint,
                            action: ActionButton(
                              key: const ValueKey('empty-add-device-btn'),
                              label: strings.generateFirstInstallCmd,
                              onPressed: () => unawaited(_openEnrollSheet(state, initialTab: 'linux')),
                            ),
                          ),
                        )
                      else
                        for (final device in sortedDevices) _buildDeviceRow(state, device, overview.enrollments, masterVersion, deviceById),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildApprovalRow(AppState state, DeviceApproval approval, Map<String, DeviceTwin> deviceById) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final busy = _busyApprovals.contains(approval.id);
    final paramsText = approval.params.isEmpty ? null : jsonEncode(approval.params);
    final targetDevice = deviceById[approval.deviceId];
    final targetLabel = targetDevice?.displayName ?? approval.deviceId;
    final showRawId = targetDevice != null && targetDevice.hasCustomName;

    return Padding(
      key: ValueKey('approval-${approval.id}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Pill(approval.shortCode, color: palette.orange, dot: true),
              Text(targetLabel, style: typo.headline),
              if (showRawId) Text(approval.deviceId, style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
              Text(approval.action, style: typo.mono.copyWith(color: palette.accent, fontWeight: FontWeight.w600)),
              if (approval.createdAt != null) Text(clockTime(approval.createdAt!), style: typo.caption),
            ],
          ),
          if (paramsText != null) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(7)),
              child: Text(paramsText, style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
            ),
          ],
          if (approval.reason != null) ...[
            const SizedBox(height: 4),
            Text(approval.reason!, style: typo.footnote),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              ActionButton(
                key: ValueKey('reject-${approval.id}'),
                label: strings.reject,
                plain: true,
                destructive: true,
                busy: busy,
                onPressed: busy ? null : () => unawaited(_handleApproval(state, approval, approve: false)),
              ),
              const SizedBox(width: 8),
              ActionButton(
                key: ValueKey('approve-${approval.id}'),
                label: strings.approve,
                busy: busy,
                onPressed: busy ? null : () => unawaited(_handleApproval(state, approval, approve: true)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEnrollmentRow(AppState state, DeviceEnrollment enrollment) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final busy = _busyEnrollments.contains(enrollment.id);
    final (statusLabel, statusColor) = switch (enrollment.status) {
      'claimed' => (strings.enrollmentStatusClaimed, palette.accent),
      _ => (strings.enrollmentStatusPending, palette.orange),
    };
    final ttl = formatRemainingTtl(enrollment.expiresAt);

    return Padding(
      key: ValueKey('enrollment-${enrollment.id}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Pill(enrollment.platform.toUpperCase(), color: palette.accent),
              Pill(statusLabel, color: statusColor, dot: true),
              Text(enrollment.profile, style: typo.footnote),
              if (enrollment.requestedCustomName != null) Text(enrollment.requestedCustomName!, style: typo.headline.copyWith(fontSize: 13.5)),
              if (enrollment.requestedDeviceId != null) Text(enrollment.requestedDeviceId!, style: typo.mono.copyWith(color: palette.label)),
              Text(strings.remainingTime(ttl), style: typo.caption.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
              if (enrollment.maxUses > 1) Text(strings.usesCount(enrollment.usedCount, enrollment.maxUses), style: typo.caption),
            ],
          ),
          if (enrollment.lastClaimedIp != null) ...[
            const SizedBox(height: 4),
            Text('IP: ${enrollment.lastClaimedIp}', style: typo.caption),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              ActionButton(
                key: ValueKey('view-enrollment-${enrollment.id}'),
                label: strings.viewCopyCommand,
                plain: true,
                onPressed: () => unawaited(_openEnrollSheet(state, existingEnrollment: enrollment)),
              ),
              ActionButton(
                key: ValueKey('revoke-enrollment-${enrollment.id}'),
                label: strings.revoke,
                plain: true,
                destructive: true,
                busy: busy,
                onPressed: busy ? null : () => unawaited(_revokeEnrollment(state, enrollment)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, {Color? accent}) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: accent != null ? accent.withValues(alpha: 0.14) : palette.fill,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: typo.caption.copyWith(
          color: accent ?? palette.label,
          fontSize: 11.5,
          fontWeight: accent != null ? FontWeight.w600 : FontWeight.normal,
        ),
      ),
    );
  }

  Widget _buildDeviceRow(AppState state, DeviceTwin device, List<DeviceEnrollment> enrollments, String? masterVersion, Map<String, DeviceTwin> deviceById) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final (statusLabel, statusColor) = switch (device.status) {
      'online' => (strings.deviceStatusOnline, palette.green),
      'sleeping' => (strings.deviceStatusSleeping, palette.orange),
      'unreachable_via_relay' => (strings.deviceStatusUnreachable, palette.red),
      _ => (strings.deviceStatusOffline, palette.gray),
    };
    final (routeLabel, routeColor) = switch (device.route) {
      'p2p' => (strings.deviceRouteP2p, palette.green),
      'lan' => (strings.deviceRouteLan, palette.green),
      'via_tier1' => (strings.deviceRouteViaTier1, palette.purple),
      _ => (strings.deviceRouteRelay, palette.accent),
    };

    final manifest = device.manifest;
    final outdated = device.needsUpdate(masterVersion);
    final rawVer = device.version;
    final versionText = device.isMcu
        ? (rawVer != null ? 'fw $rawVer' : null)
        : (rawVer != null
              ? (rawVer.startsWith('v') || rawVer.startsWith('V') ? rawVer : 'v$rawVer')
              : (outdated ? strings.legacyVersion : null));

    final chips = <(String, Color?)>[];
    if (device.isMcu) {
      if (manifest?.chip != null) chips.add((manifest!.chip!, null));
      if (versionText != null) chips.add((versionText, outdated ? palette.orange : null));
      if (device.relayNodeId != null) {
        final relayDevice = deviceById[device.relayNodeId!];
        chips.add((strings.viaRelayDevice(relayDevice?.displayName ?? device.relayNodeId!), null));
      }
      if (device.pendingQueueLength > 0) chips.add((strings.queuedCommands(device.pendingQueueLength), null));
    } else {
      if (versionText != null) chips.add((versionText, outdated ? palette.orange : null));
      if (manifest?.os != null) {
        chips.add((manifest?.arch != null ? '${manifest!.os}/${manifest.arch}' : manifest!.os!, null));
      }
      if (manifest?.cpus != null && manifest!.cpus! > 0) {
        chips.add(('${manifest.cpus} CPU', null));
      }
      if (manifest?.ramMb != null && manifest!.ramMb! > 0) {
        final mb = manifest.ramMb!;
        chips.add((mb >= 1024 ? '${(mb / 1024).toStringAsFixed(1)} GB RAM' : '$mb MB RAM', null));
      }
      if (manifest != null && manifest.gpus.isNotEmpty) {
        for (final gpu in manifest.gpus) {
          chips.add(('GPU $gpu', null));
        }
      } else if (device.hasGpu) {
        chips.add(('GPU', null));
      }
      if (device.mqttBind != null) chips.add(('MQTT ${device.mqttBind}', null));
      if (device.uartDevice != null) chips.add(('UART ${device.uartDevice}', null));
    }

    final pinging = _pingingDevices.contains(device.deviceId);
    final updating = _updatingDevices.contains(device.deviceId);
    final removing = _removingDevices.contains(device.deviceId);
    final pingResult = _pingResults[device.deviceId];
    final pingError = _pingErrors[device.deviceId];
    final updateResult = _updateResults[device.deviceId];
    final updateError = _updateErrors[device.deviceId];

    String? updateStatusText;
    Color? updateStatusColor;
    if (updating) {
      updateStatusText = strings.updatingDevice;
      updateStatusColor = palette.accent;
    } else if (updateResult != null) {
      if (updateResult.ok) {
        final target = updateResult.targetVersion.isNotEmpty ? updateResult.targetVersion : (masterVersion ?? '');
        if (!outdated) {
          updateStatusText = strings.updateCompleted(target);
        } else {
          updateStatusText = switch (updateResult.status) {
            'restarting' => strings.updateRestarting(target),
            'queued' => strings.updateQueued(target),
            'staged' => strings.updateStaged(target),
            'up_to_date' => strings.updateUpToDate(target),
            _ => strings.updateCompleted(target),
          };
        }
        updateStatusColor = palette.green;
      } else if (updateResult.status == 'manual_upgrade_required') {
        updateStatusText = strings.updateManualRequired;
        updateStatusColor = palette.orange;
      } else {
        updateStatusText = '${strings.updateFailed}: ${updateResult.error ?? updateResult.message}';
        updateStatusColor = palette.red;
      }
    } else if (updateError != null) {
      updateStatusText = '${strings.updateFailed}: $updateError';
      updateStatusColor = palette.red;
    }
    final (sandboxLabel, sandboxColor) = sandboxLevelAppearance(device.effectiveSandboxLevel, strings, palette);

    return Padding(
      key: ValueKey('device-${device.deviceId}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Wrap(
                  spacing: 7,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(device.displayName, style: typo.headline),
                    if (device.hasCustomName)
                      Text(device.deviceId, style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
                    if (manifest?.hostname != null && manifest!.hostname != device.deviceId && manifest.hostname != device.customName)
                      Text(manifest.hostname!, style: typo.caption),
                    Pill(statusLabel, color: statusColor),
                    Pill(routeLabel, color: routeColor),
                    if (device.isMcu)
                      Pill(strings.tier2Badge, color: palette.purple)
                    else ...[
                      Pill(
                        sandboxLabel,
                        key: ValueKey('sandbox-pill-${device.deviceId}'),
                        color: sandboxColor,
                        dot: device.isUnrestricted,
                      ),
                      if (device.isSandboxSyncPending)
                        Pill(
                          strings.sandboxPendingSync(strings.sandboxLevelLabel(device.desiredSandboxLevel!)),
                          key: ValueKey('sandbox-pending-${device.deviceId}'),
                          color: palette.orange,
                          dot: true,
                        ),
                      if (device.isRelayCapable)
                        Pill(strings.relayBridgeBadge, color: palette.accent),
                    ],
                  ],
                ),
              ),
            ],
          ),
          if (chips.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [for (final (label, accent) in chips) _chip(label, accent: accent)]),
          ],
          if (device.effectivePublicIp != null || device.effectiveLocation != null) ...[
            const SizedBox(height: 7),
            Wrap(
              spacing: 14,
              runSpacing: 5,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (device.effectivePublicIp != null)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(CupertinoIcons.globe, size: 13, color: palette.secondary),
                      const SizedBox(width: 5),
                      Text(strings.publicIpLabel, style: typo.caption),
                      const SizedBox(width: 5),
                      Text(
                        device.effectivePublicIp!,
                        key: ValueKey('device-ip-${device.deviceId}'),
                        style: typo.mono.copyWith(fontSize: 12, color: palette.label),
                      ),
                    ],
                  ),
                if (device.effectiveLocation != null)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(CupertinoIcons.location, size: 13, color: palette.secondary),
                      const SizedBox(width: 5),
                      Text(strings.locationLabel, style: typo.caption),
                      const SizedBox(width: 5),
                      Text(
                        device.effectiveLocation!,
                        key: ValueKey('device-location-${device.deviceId}'),
                        style: typo.caption.copyWith(color: palette.label),
                      ),
                    ],
                  ),
              ],
            ),
          ],
          if (!device.isMcu && device.isUnrestricted) ...[
            const SizedBox(height: 7),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Icon(CupertinoIcons.lock_open, size: 13, color: palette.red),
                ),
                Expanded(
                  child: Text(
                    strings.sandboxUnrestrictedAccess,
                    style: typo.caption.copyWith(color: palette.red, fontWeight: FontWeight.w500),
                  ),
                ),
              ],
            ),
          ] else if (device.workspaces.isNotEmpty) ...[
            const SizedBox(height: 7),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2, right: 6),
                  child: Icon(CupertinoIcons.folder, size: 13, color: palette.secondary),
                ),
                Expanded(
                  child: Text(device.workspaces.join(', '), style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
                ),
              ],
            ),
          ],
          if (!device.isMcu && device.sandboxSyncError != null && device.sandboxSyncError!.isNotEmpty && device.sandboxSyncState != 'synced') ...[
            const SizedBox(height: 5),
            Text(
              device.sandboxSyncError!,
              key: ValueKey('sandbox-error-${device.deviceId}'),
              style: typo.caption.copyWith(color: device.sandboxSyncState == 'locked' ? palette.red : palette.orange),
            ),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: 10,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (device.lastSeenAt != null)
                      Text(strings.lastSeen(clockTime(device.lastSeenAt!)), style: typo.caption),
                    if (pingResult != null && pingResult.ok)
                      Text(
                        strings.pingOk(pingResult.latencyMs, pingResult.route),
                        key: ValueKey('ping-result-${device.deviceId}'),
                        style: typo.caption.copyWith(color: palette.green, fontWeight: FontWeight.w600),
                      )
                    else if (pingError != null)
                      Text(
                        '${strings.pingFailed}: $pingError',
                        key: ValueKey('ping-result-${device.deviceId}'),
                        style: typo.caption.copyWith(color: palette.red),
                      ),
                    if (updateStatusText != null)
                      Text(
                        updateStatusText,
                        key: ValueKey('update-result-${device.deviceId}'),
                        style: typo.caption.copyWith(color: updateStatusColor, fontWeight: FontWeight.w600),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (outdated)
                ActionButton(
                  key: ValueKey('update-${device.deviceId}'),
                  label: strings.updateDevice,
                  busy: updating,
                  onPressed: updating ? null : () => unawaited(_updateDevice(state, device, masterVersion)),
                ),
              if (outdated && updateResult?.upgradeCommand != null && updateResult!.upgradeCommand!.isNotEmpty)
                ActionButton(
                  key: ValueKey('copy-upgrade-${device.deviceId}'),
                  label: strings.copyUpgradeCommand,
                  plain: true,
                  onPressed: () => _copyUpgradeCommand(device, updateResult.upgradeCommand!),
                ),
              ActionButton(
                key: ValueKey('ping-${device.deviceId}'),
                label: strings.ping,
                plain: true,
                busy: pinging,
                onPressed: pinging ? null : () => unawaited(_pingDevice(state, device)),
              ),
              if (device.isTier1)
                ActionButton(
                  key: ValueKey('sandbox-${device.deviceId}'),
                  label: strings.sandboxPermission,
                  plain: true,
                  onPressed: () => unawaited(_openSandboxSheet(state, device)),
                ),
              ActionButton(
                key: ValueKey('rename-${device.deviceId}'),
                label: strings.renameDevice,
                plain: true,
                onPressed: () => unawaited(_openRenameSheet(state, device)),
              ),
              ActionButton(
                key: ValueKey('uninstall-${device.deviceId}'),
                label: strings.uninstallCommand,
                plain: true,
                onPressed: () => _copyUninstall(device, enrollments),
              ),
              ActionButton(
                key: ValueKey('remove-${device.deviceId}'),
                label: strings.removeDevice,
                plain: true,
                destructive: true,
                busy: removing,
                onPressed: removing ? null : () => unawaited(_removeDevice(state, device)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final online = state.link == Link.online && state.client != null;
    final overview = state.devicesOverview;
    final config = overview?.config;
    final configured = config != null && config.configured;
    _syncTtlTimer(online && overview != null && overview.activeEnrollments.isNotEmpty);

    return ColoredBox(
      color: palette.grouped,
      child: Column(
        children: [
          PageHeader(
            title: strings.devices,
            subtitle: const LinkPill(),
            actions: [
              if (online && configured)
                ActionButton(
                  key: const ValueKey('header-add-device-btn'),
                  label: strings.addDeviceShort,
                  onPressed: () => unawaited(_openEnrollSheet(state, initialTab: 'linux')),
                ),
            ],
          ),
          LinkNotice(onOpenSettings: widget.onOpenSettings),
          Expanded(
            child: Selectable(
              child: !online
                  ? EmptyState(icon: CupertinoIcons.desktopcomputer, title: strings.devices, hint: strings.devicesConnectFirst)
                  : state.devicesUnsupported
                  ? EmptyState(icon: CupertinoIcons.desktopcomputer, title: strings.devicesUnsupportedTitle, hint: strings.devicesUnsupportedHint)
                  : overview == null
                  ? Center(
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CupertinoActivityIndicator(radius: 9),
                          const SizedBox(width: 10),
                          Text(strings.loading, style: Typo.of(context).footnote),
                        ],
                      ),
                    )
                  : !configured
                  ? _buildUninitialized(state, overview.config)
                  : _buildConfigured(state, overview),
            ),
          ),
        ],
      ),
    );
  }
}

/// Modal popup to edit relay URL, cluster secret, E2E key, and enabled flag on an already configured cluster.
class _ClusterSettingsSheet extends StatefulWidget {
  const _ClusterSettingsSheet({required this.api, required this.config, required this.onSaved});

  final ApiClient api;
  final DeviceControlConfig config;
  final VoidCallback onSaved;

  @override
  State<_ClusterSettingsSheet> createState() => _ClusterSettingsSheetState();
}

class _ClusterSettingsSheetState extends State<_ClusterSettingsSheet> {
  late final TextEditingController _relayUrl;
  late final TextEditingController _clusterId;
  late final TextEditingController _masterNodeId;
  final TextEditingController _clusterSecret = TextEditingController();
  final TextEditingController _e2eKey = TextEditingController();
  late bool _enabled;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _relayUrl = TextEditingController(text: widget.config.relayUrl ?? widget.config.defaultRelayUrl ?? '');
    _clusterId = TextEditingController(text: widget.config.clusterId);
    _masterNodeId = TextEditingController(text: widget.config.masterNodeId);
    _enabled = widget.config.enabled;
  }

  @override
  void dispose() {
    for (final c in [_relayUrl, _clusterId, _masterNodeId, _clusterSecret, _e2eKey]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.updateDeviceConfig(
        relayUrl: _relayUrl.text.trim(),
        clusterId: _clusterId.text.trim(),
        masterNodeId: _masterNodeId.text.trim(),
        clusterSecret: _clusterSecret.text.trim().isEmpty ? null : _clusterSecret.text.trim(),
        e2eKey: _e2eKey.text.trim().isEmpty ? null : _e2eKey.text.trim(),
        enabled: _enabled,
      );
      widget.onSaved();
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final hasSecret = widget.config.hasClusterSecret || widget.config.hasRelaySecret;

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 500, maxHeight: MediaQuery.sizeOf(context).height * 0.85),
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
                    Expanded(child: Text(strings.clusterSettings, style: typo.headline.copyWith(fontSize: 17))),
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
                child: Selectable(
                  child: SingleChildScrollView(
                    primary: false,
                    padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Field(
                        label: strings.clusterEnabled,
                        trailing: CupertinoSwitch(
                          key: const ValueKey('cluster-enabled-switch'),
                          value: _enabled,
                          onChanged: (value) => setState(() => _enabled = value),
                        ),
                      ),
                      Field(
                        label: strings.relayUrlLabel,
                        below: Box(key: const ValueKey('edit-relay-url'), controller: _relayUrl, placeholder: 'https://neo.1inch.cn:18443', mono: true, keyboard: TextInputType.url),
                      ),
                      Field(
                        label: strings.clusterIdLabel,
                        below: Box(key: const ValueKey('edit-cluster-id'), controller: _clusterId, mono: true),
                      ),
                      Field(
                        label: strings.masterNodeIdLabel,
                        below: Box(key: const ValueKey('edit-master-node-id'), controller: _masterNodeId, mono: true),
                      ),
                      Field(
                        label: strings.clusterSecretLabel,
                        below: Box(
                          key: const ValueKey('edit-cluster-secret'),
                          controller: _clusterSecret,
                          placeholder: hasSecret ? strings.clusterSecretKeepPlaceholder : strings.clusterSecretPlaceholder,
                          obscure: true,
                          mono: true,
                        ),
                      ),
                      Field(
                        label: strings.e2eKeyLabel,
                        below: Box(
                          key: const ValueKey('edit-e2e-key'),
                          controller: _e2eKey,
                          placeholder: widget.config.hasE2eKey ? strings.clusterSecretKeepPlaceholder : strings.e2eKeyPlaceholder,
                          obscure: true,
                          mono: true,
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 8),
                        Notice(_error!),
                      ],
                      const SizedBox(height: 12),
                      Align(
                        alignment: Alignment.centerRight,
                        child: ActionButton(
                          key: const ValueKey('save-cluster-settings-btn'),
                          label: strings.save,
                          busy: _busy,
                          onPressed: () => unawaited(_save()),
                        ),
                      ),
                    ],
                  ),
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

/// Modal popup for switching a Tier 1 device's sandbox permission level across the 5 tiers.
class _DeviceSandboxSheet extends StatefulWidget {
  const _DeviceSandboxSheet({required this.api, required this.device, required this.onSaved});

  final ApiClient api;
  final DeviceTwin device;
  final ValueChanged<DeviceSandboxUpdateResult> onSaved;

  @override
  State<_DeviceSandboxSheet> createState() => _DeviceSandboxSheetState();
}

class _DeviceSandboxSheetState extends State<_DeviceSandboxSheet> {
  late String _selected;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final current = widget.device.effectiveSandboxLevel;
    _selected = sandboxLevels.contains(current) ? current : 'personal';
  }

  Future<void> _apply() async {
    final strings = Strings.read(context);
    if (_selected == 'unrestricted' && !widget.device.isUnrestricted) {
      final confirmed = await showCupertinoDialog<bool>(
        context: context,
        builder: (dialog) {
          final fonts = fallbackFonts(dialog);
          return CupertinoAlertDialog(
            title: Text(strings.sandboxConfirmUnrestrictedTitle, style: fonts),
            content: Text(strings.sandboxConfirmUnrestrictedBody(widget.device.deviceId), style: fonts),
            actions: [
              CupertinoDialogAction(
                onPressed: () => Navigator.of(dialog).pop(false),
                child: Text(strings.cancel, style: fonts),
              ),
              CupertinoDialogAction(
                key: const ValueKey('confirm-unrestricted-btn'),
                isDestructiveAction: true,
                onPressed: () => Navigator.of(dialog).pop(true),
                child: Text(strings.sandboxConfirmSwitch, style: fonts),
              ),
            ],
          );
        },
      );
      if (confirmed != true || !mounted) return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.updateDeviceSandbox(
        widget.device.deviceId,
        level: _selected,
      );
      widget.onSaved(result);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _buildLevelOption(String id, String title, String desc, {required bool disabled}) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final selected = _selected == id;
    final isUnrestricted = id == 'unrestricted';
    final (_, levelColor) = sandboxLevelAppearance(id, strings, palette);
    final radioColor = selected ? (isUnrestricted ? palette.red : palette.accent) : palette.tertiary;

    return Tappable(
      key: ValueKey('sandbox-option-$id'),
      borderRadius: 0,
      selected: selected,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      onTap: disabled
          ? null
          : () => setState(() {
              _selected = id;
              _error = null;
            }),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1, right: 10),
            child: Icon(
              selected ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
              size: 18,
              color: radioColor,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Pill(strings.sandboxLevelTier(id), color: levelColor),
                    Text(
                      title,
                      style: typo.headline.copyWith(
                        fontSize: 14,
                        color: isUnrestricted && selected ? palette.red : palette.label,
                      ),
                    ),
                    if (isUnrestricted) Pill(strings.sandboxHighestBadge, color: palette.red),
                  ],
                ),
                const SizedBox(height: 3),
                Text(desc, style: typo.caption),
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
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final device = widget.device;
    final (statusLabel, statusColor) = switch (device.status) {
      'online' => (strings.deviceStatusOnline, palette.green),
      'sleeping' => (strings.deviceStatusSleeping, palette.orange),
      'unreachable_via_relay' => (strings.deviceStatusUnreachable, palette.red),
      _ => (strings.deviceStatusOffline, palette.gray),
    };
    final (currentLabel, currentColor) = sandboxLevelAppearance(device.effectiveSandboxLevel, strings, palette);
    final levels = <(String, String, String)>[
      ('readonly', strings.profileReadonlyTitle, strings.profileReadonlyDesc),
      ('corp', strings.profileCorpTitle, strings.profileCorpDesc),
      ('personal', strings.profilePersonalTitle, strings.profilePersonalDesc),
      ('desktop', strings.profileDesktopTitle, strings.profileDesktopDesc),
      ('unrestricted', strings.profileUnrestrictedTitle, strings.profileUnrestrictedDesc),
    ];
    final canApply = !_busy &&
        !device.isSandboxLocked &&
        (_selected != device.effectiveSandboxLevel || device.isSandboxSyncPending);

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 540, maxHeight: MediaQuery.sizeOf(context).height * 0.85),
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
                    Expanded(
                      child: Text(
                        strings.sandboxSheetTitle(device.deviceId),
                        style: typo.headline.copyWith(fontSize: 17),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    CupertinoButton(
                      key: const ValueKey('sandbox-cancel-btn'),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 30),
                      onPressed: _busy ? null : () => Navigator.of(context).pop(),
                      child: Text(strings.cancel, style: typo.body.copyWith(color: palette.accent)),
                    ),
                  ],
                ),
              ),
              Container(height: 0.5, color: palette.separator),
              Flexible(
                child: SingleChildScrollView(
                  primary: false,
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(strings.sandboxCurrentLabel, style: typo.footnote),
                          Pill(currentLabel, color: currentColor, dot: device.isUnrestricted),
                          Pill(statusLabel, color: statusColor, dot: device.isOnline),
                          if (device.isSandboxSyncPending)
                            Pill(
                              strings.sandboxPendingSync(strings.sandboxLevelLabel(device.desiredSandboxLevel!)),
                              color: palette.orange,
                              dot: true,
                            ),
                        ],
                      ),
                      if (device.isSandboxLocked) ...[
                        const SizedBox(height: 10),
                        Notice(strings.sandboxLockedHint),
                      ] else if (!device.isOnline) ...[
                        const SizedBox(height: 10),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                          decoration: BoxDecoration(
                            color: palette.orange.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(strings.sandboxOfflineHint, style: typo.footnote.copyWith(color: palette.orange)),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Container(
                        decoration: BoxDecoration(
                          color: palette.grouped,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: palette.separator.withValues(alpha: 0.4), width: 0.5),
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: Column(
                          children: [
                            for (final (index, (id, title, desc)) in levels.indexed) ...[
                              if (index > 0)
                                Padding(
                                  padding: const EdgeInsets.only(left: 40),
                                  child: Container(height: 0.5, color: palette.separator),
                                ),
                              _buildLevelOption(id, title, desc, disabled: device.isSandboxLocked || _busy),
                            ],
                          ],
                        ),
                      ),
                      if (_selected == 'unrestricted') ...[
                        const SizedBox(height: 12),
                        Notice(strings.sandboxUnrestrictedWarning),
                      ],
                      if (_error != null) ...[
                        const SizedBox(height: 10),
                        Notice(_error!),
                      ],
                    ],
                  ),
                ),
              ),
              Container(height: 0.5, color: palette.separator),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    ActionButton(
                      key: const ValueKey('apply-sandbox-btn'),
                      label: _busy ? strings.sandboxApplying : strings.sandboxApply,
                      destructive: _selected == 'unrestricted',
                      busy: _busy,
                      onPressed: canApply ? () => unawaited(_apply()) : null,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Modal popup to set or clear a user-defined custom display name for a paired device.
class _RenameDeviceSheet extends StatefulWidget {
  const _RenameDeviceSheet({required this.api, required this.device});

  final ApiClient api;
  final DeviceTwin device;

  @override
  State<_RenameDeviceSheet> createState() => _RenameDeviceSheetState();
}

class _RenameDeviceSheetState extends State<_RenameDeviceSheet> {
  late final TextEditingController _name;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.device.customName ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save(String value) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final trimmed = value.trim();
      final updated = await widget.api.renameDevice(widget.device.deviceId, trimmed.isEmpty ? null : trimmed);
      if (mounted) Navigator.of(context).pop(updated);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 440, maxHeight: MediaQuery.sizeOf(context).height * 0.8),
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
                    Expanded(child: Text(strings.renameDeviceTitle, style: typo.headline.copyWith(fontSize: 17))),
                    CupertinoButton(
                      key: const ValueKey('rename-device-cancel-btn'),
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
                child: Selectable(
                  child: SingleChildScrollView(
                    primary: false,
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 6, 14, 4),
                          child: Row(
                            children: [
                              Text(strings.deviceIdLabel, style: typo.body),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  widget.device.deviceId,
                                  textAlign: TextAlign.right,
                                  style: typo.mono.copyWith(color: palette.secondary),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Field(
                          label: strings.deviceNameLabel,
                          below: Box(
                            key: const ValueKey('rename-device-input'),
                            controller: _name,
                            placeholder: strings.deviceNamePlaceholder,
                            autofocus: true,
                            onSubmitted: (_) => unawaited(_save(_name.text)),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
                          child: Text(strings.deviceNameHint, style: typo.caption),
                        ),
                        if (_error != null) ...[
                          const SizedBox(height: 4),
                          Notice(_error!),
                        ],
                        const SizedBox(height: 12),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            if (widget.device.hasCustomName) ...[
                              ActionButton(
                                key: const ValueKey('rename-device-reset-btn'),
                                label: strings.resetDefaultName,
                                plain: true,
                                busy: _busy,
                                onPressed: _busy ? null : () => unawaited(_save('')),
                              ),
                              const SizedBox(width: 8),
                            ],
                            ActionButton(
                              key: const ValueKey('rename-device-save-btn'),
                              label: strings.save,
                              busy: _busy,
                              onPressed: _busy ? null : () => unawaited(_save(_name.text)),
                            ),
                          ],
                        ),
                      ],
                    ),
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
