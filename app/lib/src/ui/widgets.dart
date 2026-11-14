/// Small pieces the pages share.
library;

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:flutter/foundation.dart';

import '../l10n/strings.dart';
import 'format.dart';
import 'theme.dart';

/// A small rounded label, tinted with its colour.
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, required this.color, this.dot = false});

  final String text;
  final Color color;

  /// Show a dot before the text, as for a live state.
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final style = Typo.of(context).caption.copyWith(color: color, fontWeight: FontWeight.w600);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)), const SizedBox(width: 5)],
          Flexible(child: Text(text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis)),
        ],
      ),
    );
  }
}

/// A block of code with its language named above it; long lines scroll sideways.
class CodeBlock extends StatelessWidget {
  const CodeBlock(this.code, {super.key, required this.language});

  final String code;
  final String language;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(8), border: Border.all(color: palette.separator.withValues(alpha: 0.4), width: 0.5)),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(language.toUpperCase(), style: typo.caption.copyWith(fontSize: 10, letterSpacing: 0.6, color: palette.tertiary)),
          const SizedBox(height: 4),
          SingleChildScrollView(scrollDirection: Axis.horizontal, child: Text(code, style: typo.mono.copyWith(color: palette.label), softWrap: false)),
        ],
      ),
    );
  }
}

/// A message's text, as text and code blocks.
class FormattedText extends StatelessWidget {
  const FormattedText(this.text, {super.key, this.color});

  final String text;

  /// The colour of running text; code keeps its own.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final typo = Typo.of(context);
    final segments = formatMessage(text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (index, segment) in segments.indexed) ...[
          if (index > 0) const SizedBox(height: grid),
          switch (segment) {
            TextSegment() => Text(segment.text, style: typo.body.copyWith(color: color)),
            CodeSegment() => CodeBlock(segment.text, language: segment.language),
          },
        ],
      ],
    );
  }
}

/// Shows [child] cut off at [height] with a button to show it whole, when [fold] is set.
class Foldable extends StatefulWidget {
  const Foldable({super.key, required this.fold, required this.child, this.height = 220, this.buttonColor});

  final bool fold;
  final Widget child;
  final double height;
  final Color? buttonColor;

  @override
  State<Foldable> createState() => _FoldableState();
}

class _FoldableState extends State<Foldable> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (!widget.fold) return widget.child;
    final strings = Strings.read(context);
    final color = widget.buttonColor ?? Palette.of(context).accent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_open) widget.child else ClipRect(child: ConstrainedBox(constraints: BoxConstraints(maxHeight: widget.height), child: SingleChildScrollView(physics: const NeverScrollableScrollPhysics(), child: widget.child))),
        const SizedBox(height: 6),
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => _open = !_open),
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: Text(_open ? strings.collapse : strings.expand, style: Typo.of(context).caption.copyWith(color: color, fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    );
  }
}

/// A plain tappable area that dims under the pointer, for rows and icon buttons on a desktop.
class Tappable extends StatefulWidget {
  const Tappable({super.key, required this.onTap, required this.child, this.padding = EdgeInsets.zero, this.borderRadius = 8, this.selected = false, this.tooltip});

  final VoidCallback? onTap;
  final Widget child;
  final EdgeInsetsGeometry padding;
  final double borderRadius;
  final bool selected;
  final String? tooltip;

  @override
  State<Tappable> createState() => _TappableState();
}

class _TappableState extends State<Tappable> {
  bool _hover = false;
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final enabled = widget.onTap != null;
    final color = widget.selected
        ? palette.strongFill
        : _down
        ? palette.strongFill
        : _hover && enabled
        ? palette.fill
        : const Color(0x00000000);
    final content = AnimatedContainer(
      duration: const Duration(milliseconds: 90),
      padding: widget.padding,
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(widget.borderRadius)),
      child: Opacity(opacity: enabled ? 1 : 0.4, child: widget.child),
    );
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.tooltip,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapUp: enabled ? (_) => setState(() => _down = false) : null,
          onTapCancel: enabled ? () => setState(() => _down = false) : null,
          child: content,
        ),
      ),
    );
  }
}

/// An icon with a title and a line of explanation, for a page with nothing to show yet.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.hint, this.action});

  final IconData icon;
  final String title;
  final String? hint;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Padding(
          padding: const EdgeInsets.all(grid * 3),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 44, color: palette.tertiary),
              const SizedBox(height: grid * 2),
              Text(title, style: typo.headline.copyWith(fontSize: 17), textAlign: TextAlign.center),
              if (hint != null) ...[const SizedBox(height: grid), Text(hint!, style: typo.footnote, textAlign: TextAlign.center)],
              if (action != null) ...[const SizedBox(height: grid * 2), action!],
            ],
          ),
        ),
      ),
    );
  }
}

/// A page's top bar: a large title on the left, actions on the right, a hairline below.
class PageHeader extends StatelessWidget {
  const PageHeader({super.key, required this.title, this.subtitle, this.leading, this.actions = const []});

  final String title;
  final Widget? subtitle;
  final Widget? leading;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Container(
      decoration: BoxDecoration(color: palette.background, border: Border(bottom: BorderSide(color: palette.separator, width: 0.5))),
      padding: EdgeInsets.fromLTRB(grid * 2.5, grid * 1.5 + MediaQuery.paddingOf(context).top, grid * 2, grid * 1.5),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: grid)],
          Expanded(
            child: Row(
              children: [
                Flexible(child: Text(title, style: typo.title, maxLines: 1, overflow: TextOverflow.ellipsis)),
                if (subtitle != null) ...[const SizedBox(width: grid * 1.5), subtitle!],
              ],
            ),
          ),
          ...actions,
        ],
      ),
    );
  }
}

/// A line that says what went wrong, tinted red, or what went right, tinted green.
class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.good = false});

  final String text;
  final bool good;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final color = good ? palette.green : palette.red;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
      child: Text(text, style: Typo.of(context).footnote.copyWith(color: color)),
    );
  }
}

/// Lets the text below it be selected and copied, with the controls of the platform it runs on.
class Selectable extends StatefulWidget {
  const Selectable({super.key, required this.child});

  final Widget child;

  @override
  State<Selectable> createState() => _SelectableState();
}

class _SelectableState extends State<Selectable> {
  final FocusNode _focus = FocusNode();

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final touch = defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android;
    return SelectableRegion(
      focusNode: _focus,
      selectionControls: touch ? cupertinoTextSelectionHandleControls : cupertinoDesktopTextSelectionHandleControls,
      contextMenuBuilder: (context, state) => CupertinoAdaptiveTextSelectionToolbar.buttonItems(anchors: state.contextMenuAnchors, buttonItems: state.contextMenuButtonItems),
      child: widget.child,
    );
  }
}
