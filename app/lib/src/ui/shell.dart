/// The app's frame: a sidebar beside the pages when there is room, tabs below them when there is not.
library;

import 'package:cupertino_ui/cupertino_ui.dart';

import '../l10n/strings.dart';
import 'activity_ticker.dart';
import 'chat_page.dart';
import 'devices_page.dart';
import 'scope.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets.dart';
import 'workers_page.dart';

/// The frame and its four pages.
class Shell extends StatefulWidget {
  const Shell({super.key, this.picker = pickFiles});

  final FilePicker picker;

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _page = 0;

  void _go(int page) {
    if (page == _page) return;
    Selectable.clearActiveSelection();
    setState(() => _page = page);
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final entries = [
      (CupertinoIcons.chat_bubble_2, CupertinoIcons.chat_bubble_2_fill, strings.chat, 0),
      (CupertinoIcons.square_stack_3d_up, CupertinoIcons.square_stack_3d_up_fill, strings.workers, state.activeWorkers),
      (CupertinoIcons.desktopcomputer, CupertinoIcons.desktopcomputer, strings.devices, state.pendingDeviceApprovals),
      (CupertinoIcons.gear, CupertinoIcons.gear_solid, strings.settings, 0),
    ];
    // Every page stays alive, so a draft or a scroll position survives a visit elsewhere.
    final pages = Stack(
      children: [
        Positioned.fill(
          child: IndexedStack(
            index: _page,
            children: [
              ChatPage(onOpenSettings: () => _go(3), picker: widget.picker),
              WorkersPage(onOpenSettings: () => _go(3)),
              DevicesPage(onOpenSettings: () => _go(3)),
              SettingsPage(onOpenDevices: () => _go(2)),
            ],
          ),
        ),
        // The chat page floats its own above the composer.
        if (_page != 0) Positioned(right: 14, bottom: 10 + MediaQuery.paddingOf(context).bottom, child: const ActivityTicker()),
      ],
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= wideLayout) {
          return ColoredBox(
            color: palette.background,
            child: Row(
              children: [
                _Sidebar(entries: entries, page: _page, onSelect: _go),
                Container(width: 0.5, color: palette.separator),
                Expanded(child: pages),
              ],
            ),
          );
        }
        return ColoredBox(
          color: palette.background,
          child: Column(
            children: [
              Expanded(child: pages),
              _TabBar(entries: entries, page: _page, onSelect: _go),
            ],
          ),
        );
      },
    );
  }
}

typedef _Entry = (IconData, IconData, String, int);

class _Badge extends StatelessWidget {
  const _Badge(this.count);

  final int count;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    return Container(
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(color: palette.accent, borderRadius: BorderRadius.circular(999)),
      child: Text('$count', textAlign: TextAlign.center, style: Typo.of(context).caption.copyWith(color: CupertinoColors.white, fontWeight: FontWeight.w600, fontSize: 11)),
    );
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.entries, required this.page, required this.onSelect});

  final List<_Entry> entries;
  final int page;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final inset = MediaQuery.paddingOf(context);
    return Container(
      width: 216,
      color: palette.sidebar,
      padding: EdgeInsets.fromLTRB(10, 14 + inset.top, 10, 12 + inset.bottom),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 16),
            child: Row(
              children: [
                Container(
                  width: 26,
                  height: 26,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(7),
                    gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF5AC8FA), Color(0xFF007AFF), Color(0xFF5856D6)]),
                  ),
                  child: const Icon(CupertinoIcons.sparkles, size: 15, color: CupertinoColors.white),
                ),
                const SizedBox(width: 9),
                Text(strings.appName, style: typo.headline.copyWith(fontSize: 16)),
              ],
            ),
          ),
          for (final (index, (icon, selectedIcon, label, badge)) in entries.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Tappable(
                key: ValueKey('nav-$index'),
                selected: index == page,
                onTap: () => onSelect(index),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                child: Row(
                  children: [
                    Icon(index == page ? selectedIcon : icon, size: 18, color: index == page ? palette.accent : palette.secondary),
                    const SizedBox(width: 10),
                    Expanded(child: Text(label, style: typo.body.copyWith(fontWeight: index == page ? FontWeight.w600 : FontWeight.w400))),
                    if (badge > 0) _Badge(badge),
                  ],
                ),
              ),
            ),
          const Spacer(),
          const Padding(padding: EdgeInsets.symmetric(horizontal: 6), child: LinkPill()),
        ],
      ),
    );
  }
}

class _TabBar extends StatelessWidget {
  const _TabBar({required this.entries, required this.page, required this.onSelect});

  final List<_Entry> entries;
  final int page;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Container(
      decoration: BoxDecoration(color: palette.sidebar, border: Border(top: BorderSide(color: palette.separator, width: 0.5))),
      padding: EdgeInsets.only(top: 6, bottom: 6 + MediaQuery.paddingOf(context).bottom),
      child: Row(
        children: [
          for (final (index, (icon, selectedIcon, label, badge)) in entries.indexed)
            Expanded(
              child: GestureDetector(
                key: ValueKey('nav-$index'),
                behavior: HitTestBehavior.opaque,
                onTap: () => onSelect(index),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Icon(index == page ? selectedIcon : icon, size: 23, color: index == page ? palette.accent : palette.secondary),
                        if (badge > 0) Positioned(right: -12, top: -3, child: _Badge(badge)),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(label, style: typo.caption.copyWith(fontSize: 10.5, color: index == page ? palette.accent : palette.secondary)),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
