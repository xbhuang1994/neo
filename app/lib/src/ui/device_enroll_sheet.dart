/// Modal sheet for generating one-click Tier 1 OS agent install commands with live onboarding tracking,
/// and for Master-driven Tier 2 MCU deployment via an online Tier 1 host.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../platform/host.dart';
import '../qr/qr_view.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets.dart';

/// Opens the Add Device / One-Click Install Command / MCU Installation modal popup.
Future<void> showDeviceEnrollSheet(
  BuildContext context, {
  required ApiClient api,
  required List<DeviceTwin> devices,
  String initialTab = 'linux',
  DeviceEnrollment? existingEnrollment,
  required VoidCallback onChanged,
}) {
  return showCupertinoModalPopup<void>(
    context: context,
    builder: (sheet) => DeviceEnrollSheet(
      api: api,
      devices: devices,
      initialTab: existingEnrollment?.platform ?? initialTab,
      existingEnrollment: existingEnrollment,
      onChanged: onChanged,
    ),
  );
}

/// Format remaining TTL duration as `MM:SS` or `HH:MM:SS`.
String formatRemainingTtl(DateTime? expiresAt, {DateTime? now}) {
  if (expiresAt == null) return '--:--';
  final diff = expiresAt.difference(now ?? DateTime.now());
  if (diff.isNegative || diff.inSeconds <= 0) return '00:00';
  final hours = diff.inHours;
  final minutes = diff.inMinutes % 60;
  final seconds = diff.inSeconds % 60;
  String two(int n) => n < 10 ? '0$n' : '$n';
  if (hours > 0) return '${two(hours)}:${two(minutes)}:${two(seconds)}';
  return '${two(minutes)}:${two(seconds)}';
}

/// Rebuilds only its countdown child once per second while visible via [TickerMode],
/// preventing full-page or full-sheet rebuilds every second when an enrollment is active.
class EnrollmentTtlBuilder extends StatefulWidget {
  const EnrollmentTtlBuilder({super.key, required this.expiresAt, required this.builder});

  final DateTime? expiresAt;
  final Widget Function(BuildContext context, String remaining) builder;

  @override
  State<EnrollmentTtlBuilder> createState() => _EnrollmentTtlBuilderState();
}

class _EnrollmentTtlBuilderState extends State<EnrollmentTtlBuilder> {
  Timer? _timer;

  void _syncTimer(bool active) {
    if (active) {
      _timer ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() {});
        if (widget.expiresAt == null || !widget.expiresAt!.isAfter(DateTime.now())) {
          _timer?.cancel();
          _timer = null;
        }
      });
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = TickerMode.valuesOf(context).enabled;
    final expiresAt = widget.expiresAt;
    _syncTimer(enabled && expiresAt != null && expiresAt.isAfter(DateTime.now()));
    return widget.builder(context, formatRemainingTtl(expiresAt));
  }
}

/// Responsive modal sheet for Tier 1 one-click enrollment and Tier 2 MCU installation.
class DeviceEnrollSheet extends StatefulWidget {
  const DeviceEnrollSheet({
    super.key,
    required this.api,
    required this.devices,
    this.initialTab = 'linux',
    this.existingEnrollment,
    required this.onChanged,
  });

  final ApiClient api;
  final List<DeviceTwin> devices;
  final String initialTab;
  final DeviceEnrollment? existingEnrollment;
  final VoidCallback onChanged;

  @override
  State<DeviceEnrollSheet> createState() => _DeviceEnrollSheetState();
}

class _DeviceEnrollSheetState extends State<DeviceEnrollSheet> {
  static const List<String> _tier1Tabs = ['linux', 'macos', 'windows', 'docker'];

  final ScrollController _scroll = ScrollController();
  late String _tab;

  // Tier 1 enrollment form state.
  String _profile = 'personal';
  String _installMode = 'auto';
  bool _showAdvanced = false;
  final TextEditingController _customName = TextEditingController();
  final TextEditingController _deviceId = TextEditingController();
  final TextEditingController _workspaces = TextEditingController();
  bool _relayBridge = false;
  final TextEditingController _mqttBind = TextEditingController();
  final TextEditingController _uartDevice = TextEditingController();
  final TextEditingController _cudaDevices = TextEditingController();
  final TextEditingController _memoryMax = TextEditingController();
  final TextEditingController _cpuQuota = TextEditingController();
  String _transportMode = 'relay';
  final TextEditingController _masterPublicUrl = TextEditingController();
  int _ttlSec = 600;
  int _maxUses = 1;

  // Active enrollment & live tracking state.
  DeviceEnrollment? _enrollment;
  List<DeviceTwin> _onboardedDevices = const [];
  bool _linuxUseRoot = true;
  bool _showQr = false;
  bool _copiedCmd = false;
  bool _busy = false;
  bool _revoking = false;
  String? _error;
  Timer? _pollTimer;
  Timer? _copyResetTimer;

  // Tier 2 MCU form & result state.
  String? _selectedTier1Id;
  bool _manualTier1 = false;
  final TextEditingController _mcuRelayId = TextEditingController();
  String _mcuTransport = 'mqtt';
  final TextEditingController _mcuId = TextEditingController();
  final TextEditingController _mcuCustomName = TextEditingController();
  String _mcuChip = 'ESP32';
  final TextEditingController _mcuMqttBroker = TextEditingController();
  final TextEditingController _mcuSerialPort = TextEditingController();
  final TextEditingController _mcuBaudRate = TextEditingController(text: '115200');
  final TextEditingController _mcuBackupRelays = TextEditingController();
  bool _mcuBusy = false;
  String? _mcuError;
  McuInstallResult? _mcuResult;
  bool _showMcuHeader = false;
  bool _showMcuScript = false;
  bool _copiedHeader = false;
  bool _copiedScript = false;

  List<DeviceTwin> get _tier1Devices {
    final list = [for (final d in widget.devices) if (d.isTier1) d];
    list.sort((a, b) {
      final aScore = (a.isOnline ? 2 : 0) + (a.isRelayCapable ? 1 : 0);
      final bScore = (b.isOnline ? 2 : 0) + (b.isRelayCapable ? 1 : 0);
      if (aScore != bScore) return bScore.compareTo(aScore);
      return a.deviceId.compareTo(b.deviceId);
    });
    return list;
  }

  @override
  void initState() {
    super.initState();
    _tab = widget.initialTab;
    final existing = widget.existingEnrollment;
    if (existing != null) {
      _tab = _tier1Tabs.contains(existing.platform) ? existing.platform : 'linux';
      _enrollment = existing;
      _linuxUseRoot = existing.installMode != 'user';
      _startTracking(existing);
    }
    _initMcuDefaults();
  }

  void _initMcuDefaults() {
    final tier1 = _tier1Devices;
    if (tier1.isNotEmpty) {
      _applyTier1Selection(tier1.first);
    } else {
      _manualTier1 = true;
    }
  }

  void _applyTier1Selection(DeviceTwin device) {
    _selectedTier1Id = device.deviceId;
    _manualTier1 = false;
    _mcuRelayId.text = device.deviceId;
    if (device.mqttBind != null && device.mqttBind!.isNotEmpty) {
      _mcuMqttBroker.text = device.mqttBind!;
    }
    if (device.uartDevice != null && device.uartDevice!.isNotEmpty) {
      _mcuSerialPort.text = device.uartDevice!;
    }
  }

  @override
  void dispose() {
    _stopTimers();
    _copyResetTimer?.cancel();
    _scroll.dispose();
    for (final controller in [
      _customName,
      _deviceId,
      _workspaces,
      _mqttBind,
      _uartDevice,
      _cudaDevices,
      _memoryMax,
      _cpuQuota,
      _masterPublicUrl,
      _mcuRelayId,
      _mcuId,
      _mcuCustomName,
      _mcuMqttBroker,
      _mcuSerialPort,
      _mcuBaudRate,
      _mcuBackupRelays,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  void _stopTimers() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void _startTracking(DeviceEnrollment enrollment) {
    _stopTimers();
    if (!enrollment.isActive) return;
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      unawaited(_pollEnrollment(enrollment.id));
    });
  }

  Future<void> _pollEnrollment(String id) async {
    try {
      final detail = await widget.api.deviceEnrollment(id);
      if (!mounted || _enrollment?.id != id) return;
      final prevStatus = _enrollment?.status;
      setState(() {
        _enrollment = detail.enrollment;
        _onboardedDevices = detail.devices;
      });
      if (!detail.enrollment.isActive) {
        _stopTimers();
        if (prevStatus != detail.enrollment.status) {
          widget.onChanged();
        }
      }
    } on ApiException {
      // Transient poll errors retry on the next 2s tick.
    }
  }

  List<String> _parseList(String text) =>
      text.split(RegExp(r'[\n,，]+')).map((item) => item.trim()).where((item) => item.isNotEmpty).toList();

  Future<void> _generateEnrollment() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final effectiveInstallMode = switch (_tab) {
      'docker' => 'foreground',
      'windows' => 'auto',
      _ => _installMode,
    };
    try {
      final created = await widget.api.createDeviceEnrollment(
        platform: _tab,
        profile: _profile,
        installMode: effectiveInstallMode,
        deviceId: _deviceId.text.trim().isEmpty ? null : _deviceId.text.trim(),
        customName: _customName.text.trim().isEmpty ? null : _customName.text.trim(),
        workspaces: _parseList(_workspaces.text),
        relayBridge: _relayBridge ? true : null,
        mqttBind: _relayBridge ? _mqttBind.text.trim() : null,
        uartDevice: _relayBridge ? _uartDevice.text.trim() : null,
        cudaDevices: _cudaDevices.text.trim(),
        memoryMax: _memoryMax.text.trim(),
        cpuQuota: _cpuQuota.text.trim(),
        transportMode: _transportMode,
        masterPublicUrl: _transportMode == 'direct' ? _masterPublicUrl.text.trim() : null,
        ttlSec: _ttlSec,
        maxUses: _maxUses,
      );
      if (!mounted) return;
      setState(() {
        _enrollment = created;
        _onboardedDevices = const [];
        _linuxUseRoot = created.installMode != 'user';
        _showQr = false;
        _copiedCmd = false;
      });
      _startTracking(created);
      widget.onChanged();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revokeEnrollment() async {
    final current = _enrollment;
    if (current == null || _revoking) return;
    setState(() {
      _revoking = true;
      _error = null;
    });
    try {
      final revoked = await widget.api.revokeDeviceEnrollment(current.id);
      if (!mounted) return;
      _stopTimers();
      setState(() => _enrollment = revoked);
      widget.onChanged();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _revoking = false);
    }
  }

  void _copyText(String text, {required VoidCallback onMark, required VoidCallback onReset}) {
    unawaited(copyToClipboard(text));
    onMark();
    _copyResetTimer?.cancel();
    _copyResetTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) onReset();
    });
  }

  String _tier1DisplayLabel(DeviceTwin device) =>
      device.hasCustomName ? '${device.displayName} (${device.deviceId})' : device.deviceId;

  Future<void> _pickTier1Device() async {
    final strings = Strings.read(context);
    final tier1 = _tier1Devices;
    final options = <(String?, String)>[
      for (final d in tier1)
        (
          d.deviceId,
          [
            _tier1DisplayLabel(d),
            d.isOnline ? strings.deviceStatusOnline : strings.deviceStatusOffline,
            if (d.mqttBind != null) 'MQTT ${d.mqttBind}',
            if (d.uartDevice != null) 'UART ${d.uartDevice}',
          ].join(' · '),
        ),
      (null, strings.manualEntry),
    ];
    final picked = await pickOption<String?>(
      context,
      title: strings.tier1RelayDevice,
      options: options,
      current: _manualTier1 ? null : _selectedTier1Id,
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (picked.$1 == null) {
        _manualTier1 = true;
        _selectedTier1Id = null;
      } else {
        final match = tier1.where((d) => d.deviceId == picked.$1).firstOrNull;
        if (match != null) {
          _applyTier1Selection(match);
        }
      }
    });
  }

  Future<void> _installMcu() async {
    final strings = Strings.read(context);
    final mcuId = _mcuId.text.trim();
    final relayId = _manualTier1 ? _mcuRelayId.text.trim() : (_selectedTier1Id ?? _mcuRelayId.text.trim());
    if (relayId.isEmpty) {
      setState(() => _mcuError = strings.relayDeviceRequired);
      return;
    }
    if (mcuId.isEmpty) {
      setState(() => _mcuError = strings.mcuIdRequired);
      return;
    }
    setState(() {
      _mcuBusy = true;
      _mcuError = null;
    });
    try {
      final baud = int.tryParse(_mcuBaudRate.text.trim());
      final backups = _parseList(_mcuBackupRelays.text);
      final result = await widget.api.installMcu(
        mcuId: mcuId,
        customName: _mcuCustomName.text.trim().isEmpty ? null : _mcuCustomName.text.trim(),
        relayDeviceId: relayId,
        transport: _mcuTransport,
        mqttBroker: _mcuTransport == 'mqtt' ? _mcuMqttBroker.text.trim() : null,
        serialPort: _mcuTransport == 'serial' ? _mcuSerialPort.text.trim() : null,
        baudRate: _mcuTransport == 'serial' ? (baud ?? 115200) : null,
        chip: _mcuChip,
        backupRelayDeviceIds: backups.isEmpty ? null : backups,
        autoDeploy: true,
      );
      if (!mounted) return;
      setState(() {
        _mcuResult = result;
        _showMcuHeader = false;
        _showMcuScript = false;
      });
      widget.onChanged();
    } on ApiException catch (error) {
      if (mounted) setState(() => _mcuError = error.message);
    } finally {
      if (mounted) setState(() => _mcuBusy = false);
    }
  }

  Widget _segmentLabel(String text) {
    final typo = Typo.of(context);
    return Text(text, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: typo.footnote.copyWith(color: Palette.of(context).label, fontWeight: FontWeight.w500));
  }

  Widget _sectionLabel(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(text, style: Typo.of(context).section),
  );

  Widget _buildTier1Form() {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final profiles = <(String, String, String)>[
      ('personal', strings.profilePersonalTitle, strings.profilePersonalDesc),
      ('corp', strings.profileCorpTitle, strings.profileCorpDesc),
      ('readonly', strings.profileReadonlyTitle, strings.profileReadonlyDesc),
      ('desktop', strings.profileDesktopTitle, strings.profileDesktopDesc),
      ('unrestricted', strings.profileUnrestrictedTitle, strings.profileUnrestrictedDesc),
    ];
    final showInstallMode = _tab == 'linux' || _tab == 'macos';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionLabel(strings.policyPreset),
        Container(
          decoration: BoxDecoration(color: palette.grouped, borderRadius: BorderRadius.circular(10), border: Border.all(color: palette.separator.withValues(alpha: 0.4), width: 0.5)),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (final (index, (id, title, desc)) in profiles.indexed) ...[
                if (index > 0) Padding(padding: const EdgeInsets.only(left: 40), child: Container(height: 0.5, color: palette.separator)),
                Tappable(
                  key: ValueKey('profile-$id'),
                  borderRadius: 0,
                  selected: _profile == id,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  onTap: () => setState(() => _profile = id),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 1, right: 10),
                        child: Icon(
                          _profile == id ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
                          size: 18,
                          color: _profile == id ? (id == 'unrestricted' ? palette.red : palette.accent) : palette.tertiary,
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
                                Text(
                                  title,
                                  style: typo.headline.copyWith(
                                    fontSize: 14,
                                    color: id == 'unrestricted' && _profile == id ? palette.red : palette.label,
                                  ),
                                ),
                                if (id == 'unrestricted') Pill(strings.sandboxHighestBadge, color: palette.red),
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(desc, style: typo.caption),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
        if (_profile == 'unrestricted') ...[
          const SizedBox(height: 10),
          Notice(strings.sandboxUnrestrictedWarning),
        ],
        if (showInstallMode) ...[
          const SizedBox(height: 16),
          _sectionLabel(strings.installMode),
          SizedBox(
            width: double.infinity,
            child: SelectionContainer.disabled(
              child: CupertinoSlidingSegmentedControl<String>(
                key: const ValueKey('enroll-install-mode'),
                groupValue: _installMode,
                children: {
                  'auto': _segmentLabel(strings.installModeAuto),
                  'system': _segmentLabel(strings.installModeSystem),
                  'user': _segmentLabel(strings.installModeUser),
                },
                onValueChanged: (value) {
                  if (value != null) setState(() => _installMode = value);
                },
              ),
            ),
          ),
        ],
        const SizedBox(height: 14),
        _sectionLabel(strings.deviceNameLabel),
        Box(
          key: const ValueKey('enroll-device-name'),
          controller: _customName,
          placeholder: strings.deviceNameOptionalPlaceholder,
        ),
        const SizedBox(height: 14),
        Container(
          decoration: BoxDecoration(color: palette.grouped, borderRadius: BorderRadius.circular(10), border: Border.all(color: palette.separator.withValues(alpha: 0.4), width: 0.5)),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Tappable(
                key: const ValueKey('enroll-advanced-toggle'),
                borderRadius: 0,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                onTap: () => setState(() => _showAdvanced = !_showAdvanced),
                child: Row(
                  children: [
                    Icon(CupertinoIcons.slider_horizontal_3, size: 16, color: palette.accent),
                    const SizedBox(width: 8),
                    Expanded(child: Text(strings.advancedOptions, style: typo.headline.copyWith(fontSize: 14))),
                    Icon(_showAdvanced ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 15, color: palette.secondary),
                  ],
                ),
              ),
              if (_showAdvanced) ...[
                Container(height: 0.5, color: palette.separator),
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(strings.deviceIdLabel, style: typo.footnote),
                      const SizedBox(height: 5),
                      Box(key: const ValueKey('enroll-device-id'), controller: _deviceId, placeholder: strings.deviceIdPlaceholder, mono: true),
                      const SizedBox(height: 12),
                      Text(strings.workspacesLabel, style: typo.footnote),
                      const SizedBox(height: 5),
                      Box(key: const ValueKey('enroll-workspaces'), controller: _workspaces, placeholder: strings.workspacesPlaceholder, mono: true),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(child: Text(strings.enableRelayBridge, style: typo.body.copyWith(fontSize: 14))),
                          CupertinoSwitch(
                            key: const ValueKey('enroll-relay-bridge'),
                            value: _relayBridge,
                            onChanged: (value) => setState(() => _relayBridge = value),
                          ),
                        ],
                      ),
                      if (_relayBridge) ...[
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(strings.mqttBindLabel, style: typo.caption),
                                  const SizedBox(height: 4),
                                  Box(key: const ValueKey('enroll-mqtt-bind'), controller: _mqttBind, placeholder: '0.0.0.0:1883', mono: true),
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(strings.uartDeviceLabel, style: typo.caption),
                                  const SizedBox(height: 4),
                                  Box(key: const ValueKey('enroll-uart-device'), controller: _uartDevice, placeholder: '/dev/ttyUSB0', mono: true),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 12),
                      Text(strings.cudaDevicesLabel, style: typo.footnote),
                      const SizedBox(height: 5),
                      Box(key: const ValueKey('enroll-cuda-devices'), controller: _cudaDevices, placeholder: '0,1', mono: true),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(strings.memoryMaxLabel, style: typo.caption),
                                const SizedBox(height: 4),
                                Box(key: const ValueKey('enroll-memory-max'), controller: _memoryMax, placeholder: '4G', mono: true),
                              ],
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(strings.cpuQuotaLabel, style: typo.caption),
                                const SizedBox(height: 4),
                                Box(key: const ValueKey('enroll-cpu-quota'), controller: _cpuQuota, placeholder: '200%', mono: true),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(strings.transportMode, style: typo.footnote),
                      const SizedBox(height: 5),
                      SizedBox(
                        width: double.infinity,
                        child: SelectionContainer.disabled(
                          child: CupertinoSlidingSegmentedControl<String>(
                            key: const ValueKey('enroll-transport-mode'),
                            groupValue: _transportMode,
                            children: {
                              'relay': _segmentLabel(strings.transportRelay),
                              'direct': _segmentLabel(strings.transportDirect),
                            },
                            onValueChanged: (value) {
                              if (value != null) setState(() => _transportMode = value);
                            },
                          ),
                        ),
                      ),
                      if (_transportMode == 'direct') ...[
                        const SizedBox(height: 10),
                        Text(strings.masterPublicUrlLabel, style: typo.caption),
                        const SizedBox(height: 4),
                        Box(
                          key: const ValueKey('enroll-master-url'),
                          controller: _masterPublicUrl,
                          placeholder: 'http://192.168.1.10:3082',
                          mono: true,
                          keyboard: TextInputType.url,
                        ),
                      ],
                      const SizedBox(height: 12),
                      Text(strings.ttlLabel, style: typo.caption),
                      const SizedBox(height: 4),
                      SizedBox(
                        width: double.infinity,
                        child: SelectionContainer.disabled(
                          child: CupertinoSlidingSegmentedControl<int>(
                            key: const ValueKey('enroll-ttl'),
                            groupValue: _ttlSec,
                            children: {
                              600: _segmentLabel('10m'),
                              1800: _segmentLabel('30m'),
                              86400: _segmentLabel('24h'),
                            },
                            onValueChanged: (v) {
                              if (v != null) setState(() => _ttlSec = v);
                            },
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(strings.maxUsesLabel, style: typo.caption),
                      const SizedBox(height: 4),
                      SizedBox(
                        width: double.infinity,
                        child: SelectionContainer.disabled(
                          child: CupertinoSlidingSegmentedControl<int>(
                            key: const ValueKey('enroll-max-uses'),
                            groupValue: _maxUses,
                            children: {
                              1: _segmentLabel('1'),
                              5: _segmentLabel('5'),
                              10: _segmentLabel('10'),
                            },
                            onValueChanged: (v) {
                              if (v != null) setState(() => _maxUses = v);
                            },
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Notice(_error!),
        ],
        const SizedBox(height: 16),
        ActionButton(
          key: const ValueKey('generate-install-cmd-btn'),
          label: strings.generateInstallCmd,
          busy: _busy,
          onPressed: () => unawaited(_generateEnrollment()),
        ),
      ],
    );
  }

  Widget _buildEnrollmentTracking(DeviceEnrollment enrollment) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final command = enrollment.commands.forPlatform(enrollment.platform, linuxUseRoot: _linuxUseRoot);

    final onboardedLabel = _onboardedDevices.isNotEmpty
        ? _onboardedDevices.map((d) => d.displayName).join(', ')
        : enrollment.enrolledDeviceIds.isNotEmpty
        ? enrollment.enrolledDeviceIds.join(', ')
        : (enrollment.requestedCustomName ?? enrollment.requestedDeviceId ?? enrollment.id);

    final (statusColor, statusText, showSpinner, statusIcon) = switch (enrollment.status) {
      'claimed' => (palette.accent, strings.ticketClaimed(enrollment.lastClaimedIp), true, null),
      'completed' => (
        palette.green,
        strings.deviceOnboarded(onboardedLabel),
        false,
        CupertinoIcons.checkmark_circle_fill,
      ),
      'expired' => (palette.red, strings.ticketExpired, false, CupertinoIcons.clock),
      'revoked' => (palette.gray, strings.ticketRevoked, false, CupertinoIcons.xmark_circle),
      _ => (palette.orange, strings.waitingForPaste, true, null),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Pill(enrollment.platform.toUpperCase(), color: palette.accent),
            Pill(enrollment.profile, color: enrollment.profile == 'unrestricted' ? palette.red : palette.secondary),
            if (enrollment.requestedCustomName != null)
              Pill(enrollment.requestedCustomName!, color: palette.accent),
            if (enrollment.isActive)
              EnrollmentTtlBuilder(
                expiresAt: enrollment.expiresAt,
                builder: (context, remaining) => Pill(strings.remainingTime(remaining), color: palette.orange, dot: true),
              ),
            if (enrollment.maxUses > 1)
              Pill(strings.usesCount(enrollment.usedCount, enrollment.maxUses), color: palette.secondary),
          ],
        ),
        if (enrollment.platform == 'linux') ...[
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: SelectionContainer.disabled(
              child: CupertinoSlidingSegmentedControl<bool>(
                key: const ValueKey('linux-root-toggle'),
                groupValue: _linuxUseRoot,
                children: {
                  true: _segmentLabel(strings.linuxRootMode),
                  false: _segmentLabel(strings.linuxUserMode),
                },
                onValueChanged: (value) {
                  if (value != null) {
                    setState(() {
                      _linuxUseRoot = value;
                      _copiedCmd = false;
                    });
                  }
                },
              ),
            ),
          ),
        ],
        const SizedBox(height: 12),
        Container(
          key: const ValueKey('enroll-command-box'),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: palette.code,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: palette.separator.withValues(alpha: 0.5), width: 0.5),
          ),
          child: Text(command, style: typo.mono.copyWith(color: palette.label)),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            ActionButton(
              key: const ValueKey('copy-enroll-cmd-btn'),
              label: _copiedCmd ? '✓ ${strings.copied}' : strings.copyCommand,
              onPressed: command.isEmpty
                  ? null
                  : () => _copyText(
                      command,
                      onMark: () => setState(() => _copiedCmd = true),
                      onReset: () => setState(() => _copiedCmd = false),
                    ),
            ),
            if (enrollment.enrollCode.isNotEmpty)
              ActionButton(
                key: const ValueKey('toggle-qr-btn'),
                label: strings.qrCode,
                plain: true,
                onPressed: () => setState(() => _showQr = !_showQr),
              ),
            if (enrollment.isActive)
              ActionButton(
                key: const ValueKey('revoke-enroll-btn'),
                label: strings.revokeImmediately,
                plain: true,
                destructive: true,
                busy: _revoking,
                onPressed: () => unawaited(_revokeEnrollment()),
              ),
            ActionButton(
              key: const ValueKey('new-enroll-btn'),
              label: strings.newCommand,
              plain: true,
              onPressed: () {
                _stopTimers();
                setState(() {
                  _enrollment = null;
                  _onboardedDevices = const [];
                  _showQr = false;
                  _error = null;
                });
              },
            ),
          ],
        ),
        if (_showQr && enrollment.enrollCode.isNotEmpty) ...[
          const SizedBox(height: 14),
          Center(
            child: Column(
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: CupertinoColors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: palette.separator, width: 0.5),
                  ),
                  child: QrView(enrollment.enrollCode, size: 180),
                ),
                const SizedBox(height: 6),
                Text(enrollment.enrollCode, style: typo.mono.copyWith(fontSize: 11.5, color: palette.secondary)),
              ],
            ),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          Notice(_error!),
        ],
        const SizedBox(height: 14),
        Container(
          key: const ValueKey('enroll-live-status'),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: statusColor.withValues(alpha: 0.11),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: statusColor.withValues(alpha: 0.28), width: 0.5),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  if (showSpinner)
                    const CupertinoActivityIndicator(radius: 8)
                  else if (statusIcon != null)
                    Icon(statusIcon, size: 18, color: statusColor),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(statusText, style: typo.headline.copyWith(fontSize: 14, color: statusColor)),
                  ),
                ],
              ),
              if (enrollment.status == 'completed' && _onboardedDevices.isNotEmpty) ...[
                const SizedBox(height: 10),
                for (final twin in _onboardedDevices)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(twin.displayName, style: typo.headline.copyWith(fontSize: 13.5)),
                        if (twin.hasCustomName)
                          Text(twin.deviceId, style: typo.mono.copyWith(fontSize: 12, color: palette.secondary)),
                        Pill(_routeLabel(twin.route, strings), color: palette.green),
                        if (twin.manifest?.os != null)
                          Text(
                            [
                              '${twin.manifest!.os}${twin.manifest?.arch != null ? '/${twin.manifest!.arch}' : ''}',
                              if (twin.manifest?.cpus != null) '${twin.manifest!.cpus} CPU',
                              if (twin.manifest?.ramMb != null && twin.manifest!.ramMb! > 0) _formatRam(twin.manifest!.ramMb!),
                            ].join(' · '),
                            style: typo.caption,
                          ),
                      ],
                    ),
                  ),
              ],
              if (enrollment.status == 'completed') ...[
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: ActionButton(
                    key: const ValueKey('enroll-done-btn'),
                    label: strings.done,
                    onPressed: () {
                      widget.onChanged();
                      Navigator.of(context).pop();
                    },
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMcuTab() {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final tier1 = _tier1Devices;
    final chips = <(String, String)>[
      ('ESP32', 'ESP32'),
      ('ESP32-S3', 'ESP32-S3'),
      ('STM32', 'STM32'),
      ('linux-sim', strings.chipLinuxSim),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(strings.mcuIntro, style: typo.footnote),
        const SizedBox(height: 14),
        Container(
          decoration: BoxDecoration(color: palette.grouped, borderRadius: BorderRadius.circular(10), border: Border.all(color: palette.separator.withValues(alpha: 0.4), width: 0.5)),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (tier1.isNotEmpty) ...[
                Field(
                  key: const ValueKey('mcu-relay-picker'),
                  label: strings.tier1RelayDevice,
                  trailing: Choice(
                    _manualTier1
                        ? strings.manualEntry
                        : (() {
                            final selected = tier1.where((d) => d.deviceId == _selectedTier1Id).firstOrNull;
                            if (selected != null) return _tier1DisplayLabel(selected);
                            return _selectedTier1Id ?? strings.manualEntry;
                          })(),
                  ),
                  onTap: () => unawaited(_pickTier1Device()),
                ),
                if (_manualTier1) ...[
                  Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                    child: Box(key: const ValueKey('mcu-relay-device-id'), controller: _mcuRelayId, placeholder: strings.tier1DeviceIdPlaceholder, mono: true),
                  ),
                ],
              ] else
                Field(
                  label: strings.tier1RelayDevice,
                  below: Box(key: const ValueKey('mcu-relay-device-id'), controller: _mcuRelayId, placeholder: strings.tier1DeviceIdPlaceholder, mono: true),
                ),
              Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
              Field(
                label: strings.mcuTransport,
                below: SizedBox(
                  width: double.infinity,
                  child: SelectionContainer.disabled(
                    child: CupertinoSlidingSegmentedControl<String>(
                      key: const ValueKey('mcu-transport-segment'),
                      groupValue: _mcuTransport,
                      children: {
                        'mqtt': _segmentLabel(strings.mcuTransportMqtt),
                        'serial': _segmentLabel(strings.mcuTransportSerial),
                      },
                      onValueChanged: (value) {
                        if (value != null) setState(() => _mcuTransport = value);
                      },
                    ),
                  ),
                ),
              ),
              Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
              Field(
                label: strings.mcuIdLabel,
                below: Box(key: const ValueKey('mcu-id-input'), controller: _mcuId, placeholder: 'esp32-rack-01', mono: true),
              ),
              Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
              Field(
                label: strings.deviceNameLabel,
                below: Box(key: const ValueKey('mcu-device-name'), controller: _mcuCustomName, placeholder: strings.deviceNameOptionalPlaceholder),
              ),
              Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
              Field(
                label: strings.mcuChipLabel,
                below: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final (value, label) in chips)
                      Tappable(
                        key: ValueKey('mcu-chip-$value'),
                        selected: _mcuChip == value,
                        borderRadius: 8,
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        onTap: () => setState(() => _mcuChip = value),
                        child: Text(
                          label,
                          style: typo.footnote.copyWith(
                            color: _mcuChip == value ? palette.accent : palette.label,
                            fontWeight: _mcuChip == value ? FontWeight.w600 : FontWeight.w400,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
              if (_mcuTransport == 'mqtt')
                Field(
                  label: strings.mqttBrokerLabel,
                  below: Box(key: const ValueKey('mcu-mqtt-broker'), controller: _mcuMqttBroker, placeholder: '127.0.0.1:1883', mono: true),
                )
              else ...[
                Field(
                  label: strings.serialPortLabel,
                  below: Box(key: const ValueKey('mcu-serial-port'), controller: _mcuSerialPort, placeholder: '/dev/ttyUSB0', mono: true),
                ),
                Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
                Field(
                  label: strings.baudRateLabel,
                  below: Box(key: const ValueKey('mcu-baud-rate'), controller: _mcuBaudRate, placeholder: '115200', mono: true, keyboard: TextInputType.number),
                ),
              ],
              if (tier1.length > 1) ...[
                Padding(padding: const EdgeInsets.only(left: 14), child: Container(height: 0.5, color: palette.separator)),
                Field(
                  label: strings.backupRelaysLabel,
                  below: Box(key: const ValueKey('mcu-backup-relays'), controller: _mcuBackupRelays, placeholder: 'edge-pi-02', mono: true),
                ),
              ],
            ],
          ),
        ),
        if (_mcuError != null) ...[
          const SizedBox(height: 12),
          Notice(_mcuError!),
        ],
        const SizedBox(height: 14),
        ActionButton(
          key: const ValueKey('install-mcu-btn'),
          label: strings.installMcuCta,
          busy: _mcuBusy,
          onPressed: () => unawaited(_installMcu()),
        ),
        if (_mcuResult case final result?) ...[
          const SizedBox(height: 16),
          _buildMcuResult(result),
        ],
      ],
    );
  }

  Widget _buildMcuResult(McuInstallResult result) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final viaRpc = result.deployed && result.deployMethod == 'tier1_rpc';
    final tint = viaRpc ? palette.green : palette.orange;
    final headline = viaRpc ? strings.mcuDeployedTier1(result.workspaceDir) : strings.mcuStagedManual;

    return Container(
      key: const ValueKey('mcu-install-result'),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: tint.withValues(alpha: 0.3), width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(viaRpc ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.doc_text_fill, size: 18, color: tint),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(headline, style: typo.headline.copyWith(fontSize: 14, color: tint)),
                    if (result.deployDetail.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(result.deployDetail, style: typo.footnote),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              Pill(result.twin.displayName, color: palette.purple),
              if (result.twin.hasCustomName) Pill(result.twin.deviceId, color: palette.secondary),
              Pill(_routeLabel(result.twin.route, strings), color: palette.accent),
              if (result.mcuE2eKeyHex.isNotEmpty)
                Pill('${strings.mcuE2eKeyLabel}: ${_shortHex(result.mcuE2eKeyHex)}', color: palette.secondary),
            ],
          ),
          if (result.configHeader.isNotEmpty) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Tappable(
                    key: const ValueKey('toggle-mcu-header-btn'),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    onTap: () => setState(() => _showMcuHeader = !_showMcuHeader),
                    child: Row(
                      children: [
                        Icon(_showMcuHeader ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 14, color: palette.accent),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            strings.previewConfigHeader,
                            style: typo.footnote.copyWith(color: palette.accent, fontWeight: FontWeight.w600),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                ActionButton(
                  key: const ValueKey('copy-mcu-header-btn'),
                  label: _copiedHeader ? '✓ ${strings.copied}' : strings.copy,
                  plain: true,
                  onPressed: () => _copyText(
                    result.configHeader,
                    onMark: () => setState(() => _copiedHeader = true),
                    onReset: () => setState(() => _copiedHeader = false),
                  ),
                ),
              ],
            ),
            if (_showMcuHeader)
              Container(
                key: const ValueKey('mcu-config-header-box'),
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(8)),
                child: Text(result.configHeader, style: typo.mono.copyWith(fontSize: 11.5, color: palette.label)),
              ),
          ],
          if (result.installScript.isNotEmpty) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Tappable(
                    key: const ValueKey('toggle-mcu-script-btn'),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    onTap: () => setState(() => _showMcuScript = !_showMcuScript),
                    child: Row(
                      children: [
                        Icon(_showMcuScript ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 14, color: palette.accent),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            strings.previewInstallScript,
                            style: typo.footnote.copyWith(color: palette.accent, fontWeight: FontWeight.w600),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                ActionButton(
                  key: const ValueKey('copy-mcu-script-btn'),
                  label: _copiedScript ? '✓ ${strings.copied}' : strings.copy,
                  plain: true,
                  onPressed: () => _copyText(
                    result.installScript,
                    onMark: () => setState(() => _copiedScript = true),
                    onReset: () => setState(() => _copiedScript = false),
                  ),
                ),
              ],
            ),
            if (_showMcuScript)
              Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(8)),
                child: Text(result.installScript, style: typo.mono.copyWith(fontSize: 11.5, color: palette.label)),
              ),
          ],
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: ActionButton(
              key: const ValueKey('mcu-done-btn'),
              label: strings.done,
              onPressed: () {
                widget.onChanged();
                Navigator.of(context).pop();
              },
            ),
          ),
        ],
      ),
    );
  }

  String _shortHex(String hex) => hex.length <= 12 ? hex : '${hex.substring(0, 8)}…${hex.substring(hex.length - 4)}';

  String _routeLabel(String route, Strings strings) => switch (route) {
    'p2p' => strings.deviceRouteP2p,
    'lan' => strings.deviceRouteLan,
    'via_tier1' => strings.deviceRouteViaTier1,
    _ => strings.deviceRouteRelay,
  };

  String _formatRam(int ramMb) => ramMb >= 1024 ? '${(ramMb / 1024).toStringAsFixed(1)} GB' : '$ramMb MB';

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final size = MediaQuery.sizeOf(context);
    final activeEnrollment = _enrollment;

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 600, maxHeight: size.height * 0.88),
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
                    Expanded(child: Text(strings.addDeviceSheetTitle, style: typo.headline.copyWith(fontSize: 17))),
                    CupertinoButton(
                      key: const ValueKey('enroll-close-btn'),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 30),
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(strings.close, style: typo.body.copyWith(color: palette.accent)),
                    ),
                  ],
                ),
              ),
              Container(height: 0.5, color: palette.separator),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                child: SizedBox(
                  width: double.infinity,
                  child: CupertinoSlidingSegmentedControl<String>(
                    key: const ValueKey('enroll-platform-tabs'),
                    groupValue: _tab,
                    children: {
                      'linux': _segmentLabel('Linux'),
                      'macos': _segmentLabel('macOS'),
                      'windows': _segmentLabel('Windows'),
                      'docker': _segmentLabel('Docker'),
                      'mcu': _segmentLabel('MCU'),
                    },
                    onValueChanged: (next) {
                      if (next == null || next == _tab) return;
                      _stopTimers();
                      setState(() {
                        _tab = next;
                        _enrollment = null;
                        _onboardedDevices = const [];
                        _showQr = false;
                        _error = null;
                        _mcuError = null;
                      });
                    },
                  ),
                ),
              ),
              Flexible(
                child: CupertinoScrollbar(
                  controller: _scroll,
                  child: Selectable(
                    child: SingleChildScrollView(
                      controller: _scroll,
                      primary: false,
                      padding: const EdgeInsets.fromLTRB(16, 6, 16, 18),
                      child: _tab == 'mcu'
                          ? _buildMcuTab()
                          : (activeEnrollment != null ? _buildEnrollmentTracking(activeEnrollment) : _buildTier1Form()),
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
