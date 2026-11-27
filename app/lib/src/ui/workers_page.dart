/// The tasks and their workers: a list, and one of them in detail.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'format.dart';
import 'scope.dart';
import 'theme.dart';
import 'widgets.dart';

/// A worker's state in words and its colour.
(String, Color) workerStatus(Worker worker, Strings strings, Palette palette) {
  if (worker.streaming) return (strings.statusRunning, palette.accent);
  if (worker.background.isNotEmpty && worker.stage != 'person') return (strings.statusBackground, palette.accent);
  return switch (worker.stage) {
    'ended' => (worker.outcome == 'completed' ? strings.statusCompleted : strings.statusEnded, palette.gray),
    'person' => switch (worker.action) {
      'delivery' => (strings.statusDeliveryFailed, palette.red),
      'answer' => (strings.statusWaitingAnswer, palette.orange),
      'review' => (strings.statusReview, palette.green),
      'blocked' => (strings.statusBlocked, palette.red),
      _ => (strings.statusFailed, palette.red),
    },
    'idle' => (strings.statusIdle, palette.gray),
    _ => (worker.action == 'queued' ? strings.statusQueued : strings.statusWorking, palette.accent),
  };
}

/// The tasks page: side by side when there is room, else the list with the detail on top of it.
class WorkersPage extends StatelessWidget {
  const WorkersPage({super.key, required this.onOpenSettings});

  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context, aspect: AppAspect.workers);
    AppScope.of(context, aspect: AppAspect.workerDetail);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 720;
        final selected = state.selectedWorkerId;
        final showDetailOnly = !wide && selected != null;
        final list = WorkerList(workers: state.workers, selected: selected, onSelect: state.selectWorker);
        final detail = WorkerDetail(worker: state.detail ?? _cardOf(state, selected));
        return ColoredBox(
          color: palette.background,
          child: Column(
            children: [
              PageHeader(
                title: showDetailOnly ? (state.detail?.title ?? _cardOf(state, selected)?.title ?? strings.workers) : strings.workers,
                leading: showDetailOnly
                    ? Tappable(onTap: () => state.selectWorker(null), padding: const EdgeInsets.all(6), child: Icon(CupertinoIcons.chevron_back, size: 20, color: palette.accent))
                    : null,
                subtitle: showDetailOnly ? null : Text(strings.workersSummary(state.activeWorkers, state.workers.length), style: Typo.of(context).footnote),
              ),
              LinkNotice(onOpenSettings: onOpenSettings),
              Expanded(
                child: state.workers.isEmpty
                    ? EmptyState(icon: CupertinoIcons.square_stack_3d_up, title: strings.workers, hint: strings.workersEmpty)
                    : wide
                    ? Row(
                        children: [
                          SizedBox(width: 320, child: list),
                          Container(width: 0.5, color: palette.separator),
                          Expanded(child: selected == null ? EmptyState(icon: CupertinoIcons.sidebar_right, title: strings.selectWorker) : detail),
                        ],
                      )
                    : (selected == null ? list : detail),
              ),
            ],
          ),
        );
      },
    );
  }

  Worker? _cardOf(AppState state, String? ticketId) {
    if (ticketId == null) return null;
    for (final worker in state.workers) {
      if (worker.ticketId == ticketId) return worker;
    }
    return null;
  }
}

/// The tasks as cards, open ones first.
class WorkerList extends StatelessWidget {
  const WorkerList({super.key, required this.workers, required this.selected, required this.onSelect});

  final List<Worker> workers;
  final String? selected;
  final ValueChanged<String?> onSelect;

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return RepaintBoundary(
      child: CupertinoScrollbar(
        child: ListView.builder(
          scrollCacheExtent: const ScrollCacheExtent.pixels(500),
          addAutomaticKeepAlives: false,
          padding: const EdgeInsets.all(grid * 1.5),
          itemCount: workers.length,
          itemBuilder: (context, index) {
            final worker = workers[index];
            final (status, color) = workerStatus(worker, strings, palette);
            final facts = [
              if (worker.report != null) strings.reportState(worker.report!.state) else if (worker.assignmentState != null) strings.reportState(worker.assignmentState!) else strings.notStarted,
              if (worker.pendingInputs > 0) strings.pendingCount(worker.pendingInputs),
              if (worker.background.isNotEmpty) strings.backgroundCount(worker.background.length),
              if (worker.updatedAt != null) clockTime(worker.updatedAt!),
            ];
            return Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Tappable(
                key: ValueKey('worker-${worker.ticketId}'),
                selected: worker.ticketId == selected,
                borderRadius: radius,
                padding: const EdgeInsets.all(12),
                onTap: () => onSelect(worker.ticketId),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Pill(status, color: color, dot: worker.tone == WorkerTone.working),
                    const SizedBox(height: 7),
                    Text(worker.title, style: typo.headline, maxLines: 2, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 3),
                    Text(facts.join(' · '), style: typo.caption, maxLines: 1, overflow: TextOverflow.ellipsis),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// One task: its facts, what needs a person, its background jobs, its latest report and its recent activity.
class WorkerDetail extends StatefulWidget {
  const WorkerDetail({super.key, required this.worker});

  final Worker? worker;

  @override
  State<WorkerDetail> createState() => _WorkerDetailState();
}

class _WorkerDetailState extends State<WorkerDetail> {
  bool _stopping = false;
  String? _error;

  @override
  void didUpdateWidget(WorkerDetail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.worker?.ticketId != widget.worker?.ticketId) {
      _stopping = false;
      _error = null;
    }
  }

  Future<void> _stop(Worker worker) async {
    if (_stopping || !worker.active) return;
    final state = AppScope.read(context);
    final strings = Strings.read(context);
    final confirmed = await showCupertinoDialog<bool>(
      context: context,
      builder: (context) {
        final fonts = fallbackFonts(context);
        return CupertinoAlertDialog(
          title: Text(strings.stopWorkerConfirmTitle, style: fonts),
          content: Text(strings.stopWorkerConfirmBody, style: fonts),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.of(context).pop(false), child: Text(strings.cancel, style: fonts)),
            CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.of(context).pop(true), child: Text(strings.stopWorkerConfirm, style: fonts)),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _stopping = true;
      _error = null;
    });
    try {
      await state.stopWorker(worker.ticketId);
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.unreachable ? strings.stopWorkerFailed : error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _stopping = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final worker = widget.worker;
    if (worker == null) return const Center(child: CupertinoActivityIndicator(radius: 12));
    final online = AppScope.of(context, aspect: AppAspect.connection).link == Link.online;
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final (status, color) = workerStatus(worker, strings, palette);
    final attention = worker.deliveryError ?? worker.question;
    final facts = <(String, String)>[
      (strings.ticket, worker.ticketId),
      (strings.session, worker.streaming ? strings.sessionRunning : worker.loaded ? strings.sessionLoaded : strings.sessionUnloaded),
      (strings.assignment, worker.assignmentState == null ? strings.none : '${strings.reportState(worker.assignmentState!)} · ${worker.assignmentId ?? ''}'),
      (strings.pendingInputs, '${worker.pendingInputs}'),
      (strings.backgroundJobs, '${worker.background.length}'),
      (strings.directory, worker.directory ?? strings.none),
    ];
    Widget section(String title, List<Widget> children) => Padding(
      padding: const EdgeInsets.only(top: grid * 2.5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [Text(title, style: typo.section), const SizedBox(height: grid), ...children],
      ),
    );
    Widget card(Widget child) => Container(
      width: double.infinity,
      decoration: BoxDecoration(color: palette.sidebar, borderRadius: BorderRadius.circular(radius)),
      padding: const EdgeInsets.all(12),
      child: child,
    );
    final recent = worker.recent;
    return RepaintBoundary(
      child: CupertinoScrollbar(
        child: Selectable(
          child: CustomScrollView(
            scrollCacheExtent: const ScrollCacheExtent.pixels(600),
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(grid * 2.5, grid * 2.5, grid * 2.5, 0),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(child: Align(alignment: Alignment.centerLeft, child: Pill(status, color: color, dot: worker.tone == WorkerTone.working))),
                          if (worker.active) ...[
                            const SizedBox(width: grid),
                            SelectionContainer.disabled(
                              child: CupertinoButton(
                                key: const ValueKey('stop-worker'),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                minimumSize: const Size(0, 30),
                                borderRadius: BorderRadius.circular(8),
                                color: palette.red.withValues(alpha: 0.12),
                                disabledColor: palette.fill,
                                onPressed: online && !_stopping ? () => unawaited(_stop(worker)) : null,
                                child: _stopping
                                    ? Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          const CupertinoActivityIndicator(radius: 7),
                                          const SizedBox(width: 6),
                                          Text(strings.stoppingWorker, style: typo.footnote.copyWith(color: palette.red, fontWeight: FontWeight.w600)),
                                        ],
                                      )
                                    : Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(CupertinoIcons.stop_circle, size: 15, color: online ? palette.red : palette.tertiary),
                                          const SizedBox(width: 5),
                                          Text(strings.stopWorker, style: typo.footnote.copyWith(color: online ? palette.red : palette.tertiary, fontWeight: FontWeight.w600)),
                                        ],
                                      ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: grid),
                      Text(worker.title, style: typo.title.copyWith(fontSize: 20)),
                      if (worker.digest != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(worker.digest!, style: typo.footnote)),
                      if (_error != null) Padding(padding: const EdgeInsets.only(top: grid), child: Notice(_error!)),
                      const SizedBox(height: grid * 2),
                      card(
                        Column(
                          children: [
                            for (final (index, (label, value)) in facts.indexed) ...[
                              if (index > 0) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Container(height: 0.5, color: palette.separator)),
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  SizedBox(width: 108, child: Text(label, style: typo.footnote)),
                                  Expanded(child: Text(value, style: typo.mono.copyWith(color: palette.label))),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (attention != null) section(strings.needsAttention, [Notice(attention)]),
                      if (worker.background.isNotEmpty)
                        section('${strings.backgroundJobs} (${worker.background.length})', [
                          card(
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final (index, job) in worker.background.indexed) ...[
                                  if (index > 0) const SizedBox(height: 10),
                                  Text(
                                    [
                                      job.type == 'task' ? strings.subagent : strings.shell,
                                      if (job.startedAt != null) clockTime(job.startedAt!),
                                      if (job.elapsedSeconds != null) strings.runningFor(Duration(seconds: job.elapsedSeconds!)),
                                    ].join(' · '),
                                    style: typo.caption,
                                  ),
                                  if (job.type == 'task')
                                    Text(job.label, style: typo.body.copyWith(color: palette.label))
                                  else
                                    Text('${job.id} · ${job.label}', style: typo.mono.copyWith(color: palette.label)),
                                  if (job.progress.isNotEmpty) Text('→ ${job.progress}', style: typo.footnote, maxLines: 2, overflow: TextOverflow.ellipsis),
                                ],
                              ],
                            ),
                          ),
                        ]),
                      if (worker.report != null)
                        section('${strings.latestReport} · ${strings.reportState(worker.report!.state)}${worker.report!.at == null ? '' : ' · ${clockTime(worker.report!.at!)}'}', [
                          card(Foldable(fold: isLong(worker.report!.summary), child: FormattedText(worker.report!.summary))),
                        ]),
                      Padding(
                        padding: const EdgeInsets.only(top: grid * 2.5, bottom: grid),
                        child: Text('${strings.recentActivity} (${recent.length})', style: typo.section),
                      ),
                      if (recent.isEmpty)
                        Padding(
                          padding: const EdgeInsets.only(bottom: grid * 2.5),
                          child: Text(strings.noActivity, style: typo.footnote),
                        ),
                    ],
                  ),
                ),
              ),
              if (recent.isNotEmpty)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(grid * 2.5, 0, grid * 2.5, grid * 2.5),
                  sliver: SliverList.builder(
                    itemCount: recent.length,
                    addAutomaticKeepAlives: false,
                    itemBuilder: (context, index) {
                      final line = recent[recent.length - 1 - index];
                      return Padding(
                        key: ValueKey('recent-${line.id}'),
                        padding: const EdgeInsets.only(bottom: grid),
                        child: card(
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${line.role}${line.at == null ? '' : ' · ${clockTime(line.at!)}'}', style: typo.caption),
                              const SizedBox(height: 4),
                              Foldable(fold: isLong(line.text), height: 160, child: FormattedText(line.text)),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
