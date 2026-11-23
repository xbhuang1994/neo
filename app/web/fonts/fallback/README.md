# Local Fallback Fonts for Web

These font files are self-hosted copies of the exact Noto fallback assets referenced by Flutter Web's CanvasKit renderer so the browser never makes remote requests or logs 404 fallback errors:

- `notocoloremoji/v39/*.woff2` (10 slices): Noto Color Emoji — Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- `notosanssymbols/v47/*.woff2`: Noto Sans Symbols — SIL Open Font License, Version 1.1 (https://openfontlicense.org)
- `notosanssymbols2/v25/*.woff2` (6 files): Noto Sans Symbols 2 — SIL Open Font License, Version 1.1
- `notosansmath/v19/*.woff2`: Noto Sans Math — SIL Open Font License, Version 1.1
- `notosans/v42/*.woff2`: Noto Sans — SIL Open Font License, Version 1.1
- `notosanssc/v40/*.woff2`: Noto Sans SC — SIL Open Font License, Version 1.1
- `roboto/v32/*.woff2`: Roboto — Apache License 2.0
- `_empty.ttf`: minimal valid TrueType font returned locally for unbundled exotic scripts in Flutter's fallback table so they do not 404.
