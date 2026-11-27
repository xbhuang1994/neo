/// A small line floating at the bottom right: the router is thinking, or, in turn, what each busy worker is doing.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../l10n/strings.dart';
import 'scope.dart';
import 'theme.dart';

/// How long each line shows before the next.
const tickerEvery = Duration(seconds: 3);

/// The lines the ticker turns through; empty when nothing is at work.
List<String> tickerLines(bool router, Iterable<(String, String)> workers, Strings strings) => [
  if (router) strings.routerThinking,
  for (final (title, doing) in workers) title.isEmpty ? doing : '$title · $doing',
];

/// What is at work, a line at a time; nothing when nothing is.
class ActivityTicker extends StatefulWidget {
  const ActivityTicker({super.key});

  @override
  State<ActivityTicker> createState() => _ActivityTickerState();
}

class _ActivityTickerState extends State<ActivityTicker> {
  Timer? _timer;
  int _turn = 0;
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(tickerEvery, (_) {
      if (_count > 1) setState(() => _turn++);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final activity = AppScope.of(context).activity;
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final lines = tickerLines(activity.router, [for (final worker in activity.workers) (worker.title, worker.doing)], strings);
    _count = lines.length;
    if (lines.isEmpty) return const SizedBox.shrink();
    final index = _turn % lines.length;
    final style = Typo.of(context).caption.copyWith(fontSize: 11.5, color: palette.secondary);
    return SelectionContainer.disabled(
      child: IgnorePointer(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Container(
            key: const ValueKey('activity-ticker'),
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(
              color: palette.surface.withValues(alpha: 0.88),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: palette.separator.withValues(alpha: 0.5), width: 0.5),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CupertinoActivityIndicator(radius: 5),
                const SizedBox(width: 6),
                Flexible(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 280),
                    transitionBuilder: (child, animation) => FadeTransition(
                      opacity: animation,
                      child: SlideTransition(
                        position: Tween(begin: const Offset(0, 0.4), end: Offset.zero).animate(animation),
                        child: child,
                      ),
                    ),
                    child: Text(lines[index], key: ValueKey('$index:${lines[index]}'), style: style, maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
                if (lines.length > 1) ...[const SizedBox(width: 6), Text('${index + 1}/${lines.length}', style: style.copyWith(color: palette.tertiary))],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
