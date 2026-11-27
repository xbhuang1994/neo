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

/// Color emoji slices served locally on web and resolved on demand by Flutter's FontFallbackManager.
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
@immutable
class Palette {
  Palette._resolve(BuildContext context)
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

  /// Returns the cached [Palette] from [ThemeTokens] in O(1), falling back to resolving directly in isolated tests.
  factory Palette.of(BuildContext context) => ThemeTokens.maybeOf(context)?.palette ?? Palette._resolve(context);

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

  @override
  bool operator ==(Object other) =>
      other is Palette &&
      dark == other.dark &&
      background == other.background &&
      surface == other.surface &&
      label == other.label &&
      accent == other.accent;

  @override
  int get hashCode => Object.hash(dark, background, surface, label, accent);
}

/// Pre-computed text styles derived from the theme's, eliminating per-build `copyWith` allocations.
@immutable
class Typo {
  Typo._from(TextStyle base, Palette palette)
    : _base = base,
      body = base.copyWith(fontSize: 15, height: 1.4, letterSpacing: -0.1),
      title = base.copyWith(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: 0.2),
      headline = base.copyWith(fontSize: 15, fontWeight: FontWeight.w600, letterSpacing: -0.1),
      caption = base.copyWith(fontSize: 12, color: palette.secondary, letterSpacing: 0),
      footnote = base.copyWith(fontSize: 13, color: palette.secondary, height: 1.35, letterSpacing: -0.05),
      section = base.copyWith(fontSize: 13, color: palette.secondary, fontWeight: FontWeight.w500, letterSpacing: 0),
      mono = base.copyWith(
        fontSize: 12.5,
        height: 1.45,
        fontFamily: monospace.first,
        fontFamilyFallback: List<String>.unmodifiable([...monospace.skip(1), ...(base.fontFamilyFallback ?? const [cjkFont])]),
        letterSpacing: 0,
      ),
      fallbackStyle = TextStyle(fontFamilyFallback: base.fontFamilyFallback);

  /// Returns the cached [Typo] from [ThemeTokens] in O(1), falling back to resolving directly in isolated tests.
  factory Typo.of(BuildContext context) {
    final cached = ThemeTokens.maybeOf(context);
    if (cached != null) return cached.typo;
    return Typo._from(CupertinoTheme.of(context).textTheme.textStyle, Palette._resolve(context));
  }

  final TextStyle _base;
  final TextStyle body;
  final TextStyle title;
  final TextStyle headline;
  final TextStyle caption;
  final TextStyle footnote;
  final TextStyle section;
  final TextStyle mono;
  final TextStyle fallbackStyle;

  @override
  bool operator ==(Object other) => other is Typo && _base == other._base && caption.color == other.caption.color;

  @override
  int get hashCode => Object.hash(_base, caption.color);
}

/// Caches resolved [Palette] and [Typo] once per theme/appearance change so descendants perform one O(1) lookup.
class ThemeTokens extends InheritedWidget {
  const ThemeTokens({super.key, required this.palette, required this.typo, required super.child});

  final Palette palette;
  final Typo typo;

  static ThemeTokens? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<ThemeTokens>();

  @override
  bool updateShouldNotify(ThemeTokens oldWidget) => palette != oldWidget.palette || typo != oldWidget.typo;
}

/// Resolves and provides [ThemeTokens] at the root of the app.
class ThemeTokensScope extends StatelessWidget {
  const ThemeTokensScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final palette = Palette._resolve(context);
    final typo = Typo._from(CupertinoTheme.of(context).textTheme.textStyle, palette);
    return ThemeTokens(palette: palette, typo: typo, child: child);
  }
}

/// The theme's fallback fonts alone, for texts in widgets that set their own font instead of the theme's.
///
/// An alert dialog draws in fonts of its own, so the bundled Chinese font of the web build does not reach it, and its
/// Chinese would show as empty boxes; this style, given to its texts, brings that font back.
TextStyle fallbackFonts(BuildContext context) {
  final cached = ThemeTokens.maybeOf(context);
  if (cached != null) return cached.typo.fallbackStyle;
  return TextStyle(fontFamilyFallback: CupertinoTheme.of(context).textTheme.textStyle.fontFamilyFallback);
}

/// The app's theme: the system's blue, and the system's appearance unless [brightness] is given.
CupertinoThemeData appTheme({Brightness? brightness, bool bundledCjk = false}) {
  final text = const CupertinoTextThemeData().textStyle.copyWith(fontFamilyFallback: bundledCjk ? webFallbackFonts : null);
  return CupertinoThemeData(brightness: brightness, primaryColor: CupertinoColors.systemBlue, textTheme: CupertinoTextThemeData(textStyle: text));
}
