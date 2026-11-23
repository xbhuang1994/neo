/// The app's look: Apple's system colours, which follow light and dark appearance, on an 8-point grid.
library;

import 'package:cupertino_ui/cupertino_ui.dart';

/// The grid everything is spaced on.
const double grid = 8;

/// The corner radius of cards and bubbles.
const double radius = 12;

/// The width from which the app shows a sidebar instead of tabs.
const double wideLayout = 760;

/// The font used for code.
const List<String> monospace = ['SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono', 'monospace'];

/// The font that carries Chinese where the system's own cannot be reached: the web build.
const String cjkFont = 'NotoSansSC';

/// Invisible variation selectors (`U+FE01`–`U+FE0F`) so CanvasKit does not report `U+FE0E`/`U+FE0F` as missing.
const String variationSelectorFont = 'VariationSelectors';

/// Color emoji slices preloaded on web so emoji clusters (including `U+FE0F`) resolve on the first frame.
const List<String> emojiFonts = [
  'Noto Color Emoji 0',
  'Noto Color Emoji 1',
  'Noto Color Emoji 2',
  'Noto Color Emoji 3',
  'Noto Color Emoji 4',
  'Noto Color Emoji 5',
  'Noto Color Emoji 6',
  'Noto Color Emoji 7',
  'Noto Color Emoji 8',
  'Noto Color Emoji 9',
];

/// The fallback font chain used by the web build.
const List<String> webFallbackFonts = [cjkFont, ...emojiFonts, variationSelectorFont];

/// The colours of the current appearance.
class Palette {
  Palette.of(BuildContext context)
    : background = CupertinoColors.systemBackground.resolveFrom(context),
      grouped = CupertinoColors.systemGroupedBackground.resolveFrom(context),
      surface = CupertinoColors.secondarySystemGroupedBackground.resolveFrom(context),
      sidebar = CupertinoColors.secondarySystemBackground.resolveFrom(context),
      fill = CupertinoColors.tertiarySystemFill.resolveFrom(context),
      strongFill = CupertinoColors.secondarySystemFill.resolveFrom(context),
      separator = CupertinoColors.separator.resolveFrom(context),
      label = CupertinoColors.label.resolveFrom(context),
      secondary = CupertinoColors.secondaryLabel.resolveFrom(context),
      tertiary = CupertinoColors.tertiaryLabel.resolveFrom(context),
      accent = CupertinoTheme.of(context).primaryColor,
      green = CupertinoColors.systemGreen.resolveFrom(context),
      orange = CupertinoColors.systemOrange.resolveFrom(context),
      red = CupertinoColors.systemRed.resolveFrom(context),
      gray = CupertinoColors.systemGrey.resolveFrom(context),
      purple = CupertinoColors.systemPurple.resolveFrom(context),
      dark = CupertinoTheme.brightnessOf(context) == Brightness.dark;

  final Color background;
  final Color grouped;
  final Color surface;
  final Color sidebar;
  final Color fill;
  final Color strongFill;
  final Color separator;
  final Color label;
  final Color secondary;
  final Color tertiary;
  final Color accent;
  final Color green;
  final Color orange;
  final Color red;
  final Color gray;
  final Color purple;
  final bool dark;

  /// The bubble of what the agent said.
  Color get agentBubble => dark ? const Color(0xFF26262A) : const Color(0xFFEDEDF0);

  /// The background of a code block.
  Color get code => dark ? const Color(0xFF1B1B1F) : const Color(0xFFF6F6F8);
}

/// Text styles derived from the theme's.
class Typo {
  Typo.of(BuildContext context) : _base = CupertinoTheme.of(context).textTheme.textStyle, _palette = Palette.of(context);

  final TextStyle _base;
  final Palette _palette;

  TextStyle get body => _base.copyWith(fontSize: 15, height: 1.4, letterSpacing: -0.1);
  TextStyle get title => _base.copyWith(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: 0.2);
  TextStyle get headline => _base.copyWith(fontSize: 15, fontWeight: FontWeight.w600, letterSpacing: -0.1);
  TextStyle get caption => _base.copyWith(fontSize: 12, color: _palette.secondary, letterSpacing: 0);
  TextStyle get footnote => _base.copyWith(fontSize: 13, color: _palette.secondary, height: 1.35, letterSpacing: -0.05);
  TextStyle get section => _base.copyWith(fontSize: 13, color: _palette.secondary, fontWeight: FontWeight.w500, letterSpacing: 0);
  TextStyle get mono => _base.copyWith(fontSize: 12.5, height: 1.45, fontFamily: monospace.first, fontFamilyFallback: [...monospace.skip(1), ...(_base.fontFamilyFallback ?? const [cjkFont])], letterSpacing: 0);
}

/// The theme's fallback fonts alone, for texts in widgets that set their own font instead of the theme's.
///
/// An alert dialog draws in fonts of its own, so the bundled Chinese font of the web build does not reach it, and its
/// Chinese would show as empty boxes; this style, given to its texts, brings that font back.
TextStyle fallbackFonts(BuildContext context) => TextStyle(fontFamilyFallback: CupertinoTheme.of(context).textTheme.textStyle.fontFamilyFallback);

/// The app's theme: the system's blue, and the system's appearance unless [brightness] is given.
CupertinoThemeData appTheme({Brightness? brightness, bool bundledCjk = false}) {
  final text = const CupertinoTextThemeData().textStyle.copyWith(fontFamilyFallback: bundledCjk ? webFallbackFonts : null);
  return CupertinoThemeData(brightness: brightness, primaryColor: CupertinoColors.systemBlue, textTheme: CupertinoTextThemeData(textStyle: text));
}
