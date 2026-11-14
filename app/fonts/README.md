# The bundled Chinese font

`NotoSansSC-Regular.otf` is a subset of **Noto Sans CJK SC Regular** (Latin, punctuation and the GB 2312 characters),
taken from the Noto CJK fonts, © 2014–2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
It is licensed under the SIL Open Font License, Version 1.1: https://openfontlicense.org

It is declared in `pubspec.yaml` and used as the fallback font of the web build, which cannot reach the system's
fonts: Chinese text shows without a request to any other site. The desktop apps carry the file too, and draw with
the system's fonts.

To make it again from the system's `NotoSansCJK-Regular.ttc`, see `packaging/make-web-font.py`.
