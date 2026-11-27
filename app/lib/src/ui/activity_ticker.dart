/// A small line floating at the bottom right: the router is thinking, or, in turn, what each busy worker is doing.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:cupertino_ui/cupertino_ui.dart';

import '../l10n/strings.dart';
import '../state/app_state.dart';
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

  void _syncTimer(bool active) {
    if (active) {
      _timer ??= Timer.periodic(tickerEvery, (_) {
        if (mounted && _count > 1) setState(() => _turn++);
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
    final activity = AppScope.of(context, aspect: AppAspect.activity).activity;
    final tickerEnabled = TickerMode.valuesOf(context).enabled;
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final lines = tickerLines(activity.router, [for (final worker in activity.workers) (worker.title, worker.doing)], strings);
    _count = lines.length;
    _syncTimer(tickerEnabled && _count > 1);
    if (lines.isEmpty) return const SizedBox.shrink();
    final index = _turn % lines.length;
    final style = Typo.of(context).caption.copyWith(fontSize: 11.5, color: palette.secondary);
    return RepaintBoundary(
      child: SelectionContainer.disabled(
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
                  _SteppedActivitySpinner(radius: 5, color: palette.secondary, active: tickerEnabled),
                  const SizedBox(width: 6),
                  Flexible(
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      transitionBuilder: (child, animation) => FadeTransition(opacity: animation, child: child),
                      child: Text(lines[index], key: ValueKey('$index:${lines[index]}'), style: style, maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ),
                  if (lines.length > 1) ...[const SizedBox(width: 6), Text('${index + 1}/${lines.length}', style: style.copyWith(color: palette.tertiary))],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// An 8-spoke Cupertino-style spinner that repaints only on its 8 visual steps per second (125 ms)
/// instead of scheduling 60 FPS frames, eliminating idle mobile Web CPU/GPU drain while looking identical.
class _SteppedActivitySpinner extends StatefulWidget {
  const _SteppedActivitySpinner({required this.radius, required this.color, required this.active});

  final double radius;
  final Color color;
  final bool active;

  @override
  State<_SteppedActivitySpinner> createState() => _SteppedActivitySpinnerState();
}

class _SteppedActivitySpinnerState extends State<_SteppedActivitySpinner> {
  static const int _ticks = 8;
  static const Duration _step = Duration(milliseconds: 125);
  final ValueNotifier<int> _phase = ValueNotifier<int>(0);
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_SteppedActivitySpinner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _sync();
  }

  void _sync() {
    if (widget.active) {
      _timer ??= Timer.periodic(_step, (_) {
        _phase.value = (_phase.value + 1) % _ticks;
      });
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _phase.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: RepaintBoundary(
        child: CustomPaint(
          size: Size.square(widget.radius * 2),
          painter: _SteppedSpinnerPainter(phase: _phase, radius: widget.radius, color: widget.color),
        ),
      ),
    );
  }
}

class _SteppedSpinnerPainter extends CustomPainter {
  _SteppedSpinnerPainter({required this.phase, required this.radius, required this.color}) : super(repaint: phase);

  final ValueNotifier<int> phase;
  final double radius;
  final Color color;

  static const int _ticks = 8;
  static const List<double> _alphas = [1.0, 0.78, 0.60, 0.45, 0.34, 0.25, 0.18, 0.14];

  @override
  void paint(Canvas canvas, Size size) {
    final step = phase.value;
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    final spokeWidth = radius * 0.22;
    final rrect = RRect.fromLTRBR(-spokeWidth / 2, -radius, spokeWidth / 2, -radius * 0.45, Radius.circular(spokeWidth / 2));
    final paint = Paint()..style = PaintingStyle.fill;
    for (var i = 0; i < _ticks; i++) {
      final alpha = _alphas[(step - i + _ticks) % _ticks];
      paint.color = color.withValues(alpha: alpha);
      canvas.drawRRect(rrect, paint);
      canvas.rotate(math.pi * 2 / _ticks);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_SteppedSpinnerPainter oldDelegate) =>
      oldDelegate.phase != phase || oldDelegate.color != color || oldDelegate.radius != radius;
}
