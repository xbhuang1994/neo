/// The conversation: what was said, and a place to say more.
library;

import 'dart:async';

import 'package:cupertino_ui/cupertino_ui.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'format.dart';
import 'scope.dart';
import 'theme.dart';
import 'widgets.dart';

/// The most files one message carries, the largest of them, and the longest text: the backend's limits.
const int maxFiles = 3;
const int maxFileBytes = 5 * 1024 * 1024;
const int maxTextChars = 8000;

/// Picks the files to attach; replaced in tests.
typedef FilePicker = Future<List<OutgoingFile>> Function();

Future<List<OutgoingFile>> pickFiles() async {
  final picked = await openFiles();
  return [
    for (final file in picked)
      OutgoingFile(file.name, (file.mimeType?.isNotEmpty ?? false) ? file.mimeType! : mediaTypeOf(file.name), await file.readAsBytes()),
  ];
}

/// The conversation page.
class ChatPage extends StatelessWidget {
  const ChatPage({super.key, required this.onOpenSettings, this.picker = pickFiles});

  final VoidCallback onOpenSettings;
  final FilePicker picker;

  Future<void> _reset(BuildContext context) async {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final confirmed = await showCupertinoDialog<bool>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: Text(strings.resetConfirmTitle),
        content: Text(strings.resetConfirmBody),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.of(context).pop(false), child: Text(strings.cancel)),
          CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.of(context).pop(true), child: Text(strings.reset)),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await state.resetConversation();
    } on ApiException catch (error) {
      if (!context.mounted) return;
      await showCupertinoDialog<void>(
        context: context,
        builder: (context) => CupertinoAlertDialog(
          content: Text(error.message),
          actions: [CupertinoDialogAction(onPressed: () => Navigator.of(context).pop(), child: Text(strings.ok))],
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    return ColoredBox(
      color: palette.background,
      child: Column(
        children: [
          PageHeader(
            title: strings.chat,
            subtitle: const LinkPill(),
            actions: [
              Tappable(
                tooltip: strings.resetConversation,
                onTap: state.link == Link.online ? () => unawaited(_reset(context)) : null,
                padding: const EdgeInsets.all(8),
                child: Icon(CupertinoIcons.arrow_counterclockwise, size: 19, color: palette.secondary),
              ),
            ],
          ),
          LinkNotice(onOpenSettings: onOpenSettings),
          Expanded(
            child: state.messages.isEmpty
                ? switch (state.link) {
                    Link.starting || Link.connecting => const Center(child: CupertinoActivityIndicator(radius: 12)),
                    _ => EmptyState(icon: CupertinoIcons.chat_bubble_2, title: strings.chatEmptyTitle, hint: strings.chatEmptyHint),
                  }
                : Transcript(messages: state.messages),
          ),
          Composer(picker: picker),
        ],
      ),
    );
  }
}

/// The messages, oldest first; it stays at the newest one unless the person scrolled up.
class Transcript extends StatefulWidget {
  const Transcript({super.key, required this.messages});

  final List<ChatMessage> messages;

  @override
  State<Transcript> createState() => _TranscriptState();
}

class _TranscriptState extends State<Transcript> {
  final ScrollController _scroll = ScrollController();
  bool _follow = true;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      _follow = _scroll.position.maxScrollExtent - _scroll.position.pixels < 80;
    });
    _toEnd();
  }

  @override
  void didUpdateWidget(Transcript oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_follow) _toEnd();
  }

  void _toEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
      // What was just laid out may be taller than estimated: once more when it is known.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _scroll.hasClients && _follow) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CupertinoScrollbar(
      controller: _scroll,
      child: Selectable(
        child: ListView.builder(
          controller: _scroll,
          padding: const EdgeInsets.symmetric(horizontal: grid * 2.5, vertical: grid * 2),
          itemCount: widget.messages.length,
          itemBuilder: (context, index) => Padding(
            padding: const EdgeInsets.only(bottom: grid * 2),
            child: MessageView(key: ValueKey(widget.messages[index].id), message: widget.messages[index]),
          ),
        ),
      ),
    );
  }
}

/// One message: who and when, a bubble with the text, and the images and files that came with it.
class MessageView extends StatelessWidget {
  const MessageView({super.key, required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final mine = message.fromUser;
    final text = mine ? withoutAttachments(message.text) : message.text;
    final meta = [
      mine ? strings.you : strings.appName,
      if (message.source == 'wechat') strings.viaWeChat,
      if (message.at != null) clockTime(message.at!),
    ].join(' · ');
    final textColor = mine ? CupertinoColors.white : palette.label;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 680),
        child: Column(
          crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text(meta, style: typo.caption)),
            const SizedBox(height: 4),
            if (text.isNotEmpty)
              Container(
                decoration: BoxDecoration(color: mine ? palette.accent : palette.agentBubble, borderRadius: BorderRadius.circular(18)),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                child: Foldable(
                  fold: isLong(text),
                  buttonColor: mine ? CupertinoColors.white : null,
                  child: DefaultTextStyle.merge(style: TextStyle(color: textColor), child: FormattedText(text, color: textColor)),
                ),
              ),
            for (final image in message.images)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(radius),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 320, maxHeight: 320),
                    child: Image.memory(image.bytes, semanticLabel: image.name, fit: BoxFit.contain, errorBuilder: (context, error, stack) => FileChip(name: image.name, detail: image.mediaType)),
                  ),
                ),
              ),
            if (message.files.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  alignment: mine ? WrapAlignment.end : WrapAlignment.start,
                  children: [for (final file in message.files) FileChip(name: file.name, detail: file.mediaType)],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A file by name, with a detail after it and, when [onRemove] is given, a button to take it away.
class FileChip extends StatelessWidget {
  const FileChip({super.key, required this.name, this.detail, this.onRemove});

  final String name;
  final String? detail;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    return Container(
      decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(8)),
      padding: EdgeInsets.fromLTRB(8, 5, onRemove == null ? 10 : 4, 5),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(CupertinoIcons.paperclip, size: 14, color: palette.secondary),
          const SizedBox(width: 5),
          Flexible(child: Text(name, style: typo.footnote.copyWith(color: palette.label), maxLines: 1, overflow: TextOverflow.ellipsis)),
          if (detail != null && detail!.isNotEmpty) ...[const SizedBox(width: 6), Text(detail!, style: typo.caption)],
          if (onRemove != null)
            Tappable(onTap: onRemove, padding: const EdgeInsets.all(4), borderRadius: 999, child: Icon(CupertinoIcons.xmark, size: 12, color: palette.secondary)),
        ],
      ),
    );
  }
}

/// Where a message is written, files are attached, and both are sent.
class Composer extends StatefulWidget {
  const Composer({super.key, required this.picker});

  final FilePicker picker;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final TextEditingController _text = TextEditingController();
  final FocusNode _focus = FocusNode();
  final List<OutgoingFile> _files = [];
  bool _sending = false;
  String? _error;
  // A message that failed to send keeps its id, so that sending it again cannot make it two.
  String? _pendingId;
  String? _pendingDraft;

  @override
  void initState() {
    super.initState();
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  String get _draft => '${_text.text.trim()}\u0000${_files.map((file) => '${file.name}:${file.bytes.length}').join('\u0000')}';

  Future<void> _attach() async {
    final strings = Strings.read(context);
    final List<OutgoingFile> picked;
    try {
      picked = await widget.picker();
    } on Exception catch (error) {
      setState(() => _error = error.toString());
      return;
    }
    if (!mounted || picked.isEmpty) return;
    String? problem;
    for (final file in picked) {
      if (_files.length >= maxFiles) {
        problem = strings.tooManyFiles(maxFiles);
        break;
      }
      if (file.bytes.length > maxFileBytes) {
        problem = strings.fileTooLarge(file.name, maxFileBytes ~/ (1024 * 1024));
        continue;
      }
      _files.add(file);
    }
    setState(() => _error = problem);
  }

  Future<void> _send() async {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final text = _text.text.trim();
    if (_sending || (text.isEmpty && _files.isEmpty) || state.link != Link.online) return;
    if (text.characters.length > maxTextChars) {
      setState(() => _error = strings.textTooLong(maxTextChars));
      return;
    }
    final draft = _draft;
    if (_pendingDraft != draft) {
      _pendingDraft = draft;
      _pendingId = newMessageId();
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await state.send(text, List.of(_files), _pendingId!);
      _pendingDraft = null;
      _pendingId = null;
      _text.clear();
      _files.clear();
    } on ApiException catch (error) {
      _error = error.unreachable ? strings.sendFailed : error.message;
    } finally {
      if (mounted) {
        setState(() => _sending = false);
        _focus.requestFocus();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = Strings.read(context);
    final palette = Palette.of(context);
    final typo = Typo.of(context);
    final online = state.link == Link.online;
    final ready = online && !_sending && (_text.text.trim().isNotEmpty || _files.isNotEmpty);
    final length = _text.text.characters.length;
    return Container(
      decoration: BoxDecoration(color: palette.background, border: Border(top: BorderSide(color: palette.separator, width: 0.5))),
      padding: EdgeInsets.fromLTRB(grid * 2, grid * 1.25, grid * 2, grid * 1.25 + MediaQuery.paddingOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: grid), child: Notice(_error!)),
          if (_files.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: grid),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final file in _files)
                    FileChip(name: file.name, detail: byteSize(file.bytes.length), onRemove: _sending ? null : () => setState(() => _files.remove(file))),
                ],
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Tappable(
                tooltip: strings.attach,
                onTap: online && !_sending ? () => unawaited(_attach()) : null,
                padding: const EdgeInsets.all(9),
                borderRadius: 999,
                child: Icon(CupertinoIcons.paperclip, size: 20, color: palette.secondary),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: CallbackShortcuts(
                  bindings: {
                    const SingleActivator(LogicalKeyboardKey.enter, meta: true): () => unawaited(_send()),
                    const SingleActivator(LogicalKeyboardKey.enter, control: true): () => unawaited(_send()),
                  },
                  child: CupertinoTextField(
                    controller: _text,
                    focusNode: _focus,
                    enabled: !_sending,
                    minLines: 1,
                    maxLines: 6,
                    textInputAction: TextInputAction.newline,
                    keyboardType: TextInputType.multiline,
                    placeholder: strings.messagePlaceholder,
                    style: typo.body,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                    decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(19)),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Semantics(
                button: true,
                label: strings.send,
                child: GestureDetector(
                  onTap: ready ? () => unawaited(_send()) : null,
                  child: MouseRegion(
                    cursor: ready ? SystemMouseCursors.click : MouseCursor.defer,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 120),
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(color: ready ? palette.accent : palette.strongFill, shape: BoxShape.circle),
                      child: _sending
                          ? const CupertinoActivityIndicator(radius: 8)
                          : Icon(CupertinoIcons.arrow_up, size: 18, color: ready ? CupertinoColors.white : palette.tertiary),
                    ),
                  ),
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: 5, left: 48),
            child: Text(length > maxTextChars - 1000 ? '$length / $maxTextChars' : strings.sendShortcut, style: typo.caption.copyWith(color: length > maxTextChars ? palette.red : palette.tertiary)),
          ),
        ],
      ),
    );
  }
}
