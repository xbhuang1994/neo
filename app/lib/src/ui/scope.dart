/// Gives the pages the app's state with granular per-aspect subscriptions so unrelated polls do not rebuild hidden or unaffected UI.
library;

import 'package:cupertino_ui/cupertino_ui.dart';

import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'theme.dart';
import 'widgets.dart';

/// Provides [AppState] to descendants using an [InheritedModel] keyed by [AppAspect].
class AppScope extends StatelessWidget {
  const AppScope({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  /// Subscribes [context] to [AppState]. Pass [aspect] to rebuild only when that specific slice changes.
  static AppState of(BuildContext context, {AppAspect? aspect}) {
    if (aspect != null) {
      return InheritedModel.inheritFrom<_AppModel>(context, aspect: aspect)!.state;
    }
    return context.dependOnInheritedWidgetOfExactType<_AppModel>()!.state;
  }

  /// Reads [AppState] without registering a rebuild dependency (for callbacks and event handlers).
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<_AppModel>()!.state;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, child) => _AppModel(
        state: state,
        connectionRev: state.connectionRev,
        messagesRev: state.messagesRev,
        workersRev: state.workersRev,
        workerDetailRev: state.workerDetailRev,
        activityRev: state.activityRev,
        devicesRev: state.devicesRev,
        healthRev: state.healthRev,
        badgesRev: state.badgesRev,
        child: child!,
      ),
      child: child,
    );
  }
}

class _AppModel extends InheritedModel<AppAspect> {
  const _AppModel({
    required this.state,
    required this.connectionRev,
    required this.messagesRev,
    required this.workersRev,
    required this.workerDetailRev,
    required this.activityRev,
    required this.devicesRev,
    required this.healthRev,
    required this.badgesRev,
    required super.child,
  });

  final AppState state;
  final int connectionRev;
  final int messagesRev;
  final int workersRev;
  final int workerDetailRev;
  final int activityRev;
  final int devicesRev;
  final int healthRev;
  final int badgesRev;

  @override
  bool updateShouldNotify(_AppModel oldWidget) =>
      !identical(state, oldWidget.state) ||
      connectionRev != oldWidget.connectionRev ||
      messagesRev != oldWidget.messagesRev ||
      workersRev != oldWidget.workersRev ||
      workerDetailRev != oldWidget.workerDetailRev ||
      activityRev != oldWidget.activityRev ||
      devicesRev != oldWidget.devicesRev ||
      healthRev != oldWidget.healthRev ||
      badgesRev != oldWidget.badgesRev;

  @override
  bool updateShouldNotifyDependent(_AppModel oldWidget, Set<AppAspect> dependencies) {
    if (!identical(state, oldWidget.state)) return true;
    for (final aspect in dependencies) {
      final changed = switch (aspect) {
        AppAspect.connection => connectionRev != oldWidget.connectionRev,
        AppAspect.messages => messagesRev != oldWidget.messagesRev,
        AppAspect.workers => workersRev != oldWidget.workersRev,
        AppAspect.workerDetail => workerDetailRev != oldWidget.workerDetailRev,
        AppAspect.activity => activityRev != oldWidget.activityRev,
        AppAspect.devices => devicesRev != oldWidget.devicesRev,
        AppAspect.health => healthRev != oldWidget.healthRev,
        AppAspect.badges => badgesRev != oldWidget.badgesRev,
      };
      if (changed) return true;
    }
    return false;
  }
}

/// The connection in one small label: connected, paused, or what is in the way.
class LinkPill extends StatelessWidget {
  const LinkPill({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context, aspect: AppAspect.connection);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final (text, color) = switch (state.link) {
      Link.online when state.health?.paused == true => (strings.paused, palette.orange),
      Link.online => (strings.online, palette.green),
      Link.starting => (strings.startingBackend, palette.orange),
      Link.connecting => (strings.connecting, palette.orange),
      Link.offline => (strings.offline, palette.red),
      Link.tokenNeeded => (strings.tokenNeeded, palette.red),
      Link.backendFailed => (strings.backendFailed, palette.red),
      Link.alreadyRunning => (strings.alreadyRunning, palette.red),
    };
    return Pill(text, color: color, dot: true);
  }
}

/// What is in the way of the connection, with what to do about it; nothing while connected.
class LinkNotice extends StatelessWidget {
  const LinkNotice({super.key, required this.onOpenSettings});

  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context, aspect: AppAspect.connection);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final kernelProblem = state.link == Link.online ? state.health?.kernelProblem : null;
    final (String title, String? detail, String? action, VoidCallback? run) = switch (state.link) {
      Link.online when kernelProblem != null => (strings.kernelMissing, kernelProblem, strings.settings, onOpenSettings),
      Link.online || Link.starting || Link.connecting => ('', null, null, null),
      Link.offline => (strings.offline, state.linkDetail == 'timeout' ? null : state.linkDetail, strings.retry, state.retry),
      Link.tokenNeeded => (strings.tokenNeeded, null, strings.settings, onOpenSettings),
      Link.backendFailed => (strings.backendFailed, state.linkDetail, strings.retry, state.retry),
      Link.alreadyRunning => (strings.alreadyRunning, strings.alreadyRunningHint, strings.retry, state.retry),
    };
    if (title.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: palette.orange.withValues(alpha: 0.12), border: Border(bottom: BorderSide(color: palette.separator, width: 0.5))),
      padding: const EdgeInsets.symmetric(horizontal: grid * 2.5, vertical: grid * 1.25),
      child: Row(
        children: [
          Icon(CupertinoIcons.exclamationmark_triangle_fill, size: 16, color: palette.orange),
          const SizedBox(width: grid),
          Expanded(
            child: Selectable(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: typo.headline.copyWith(fontSize: 13)),
                  if (detail != null && detail.isNotEmpty) Text(detail, style: typo.footnote, maxLines: 3, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
          ),
          if (action != null)
            SelectionContainer.disabled(
              child: CupertinoButton(padding: const EdgeInsets.symmetric(horizontal: 12), minimumSize: const Size(0, 30), onPressed: run, child: Text(action, style: typo.headline.copyWith(fontSize: 13, color: palette.accent))),
            ),
        ],
      ),
    );
  }
}
