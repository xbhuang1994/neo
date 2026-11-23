# Bundled Fonts

## `NotoSansSC-Regular.otf`

`NotoSansSC-Regular.otf` is a subset of **Noto Sans CJK SC Regular** (Latin, punctuation and the GB 2312 characters),
taken from the Noto CJK fonts, © 2014–2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
It is licensed under the SIL Open Font License, Version 1.1: https://openfontlicense.org

It is declared in `pubspec.yaml` and used as the fallback font of the web build, which cannot reach the system's
fonts: Chinese text shows without a request to any other site. The desktop apps carry the file too, and draw with
the system's fonts.

To make it again from the system's `NotoSansCJK-Regular.ttc`, see `packaging/make-web-font.py`.

## `VariationSelectors.ttf`

A minimal valid zero-width TrueType font mapping Unicode Variation Selectors (`U+FE01`–`U+FE0F`, including `U+FE0E`
and `U+FE0F`) to empty glyphs, declared in `pubspec.yaml`. Flutter Web's Noto fallback table leaves `U+FE01`–`U+FE0F`
unmapped, so without this asset CanvasKit reports `U+FE0F` in emoji sequences (such as `⚠️` or `⚙️`) as a missing
character.
