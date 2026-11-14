#!/usr/bin/env python3
"""Make the web build's Chinese font: a subset of Noto Sans CJK SC Regular with Latin, punctuation and GB 2312.

Usage: make-web-font.py [NotoSansCJK-Regular.ttc] [app/fonts/NotoSansSC-Regular.otf]
Needs fontTools (pip install fonttools).
"""
import sys

from fontTools import subset
from fontTools.ttLib import TTCollection

source = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
target = sys.argv[2] if len(sys.argv) > 2 else "app/fonts/NotoSansSC-Regular.otf"

face = next(index for index, font in enumerate(TTCollection(source).fonts) if font["name"].getDebugName(1) == "Noto Sans CJK SC")
ranges = [(0x20, 0x7F), (0xA0, 0x100), (0x2000, 0x2070), (0x2190, 0x2200), (0x2460, 0x2500), (0x25A0, 0x2600), (0x3000, 0x3040), (0xFF00, 0xFFF0)]
characters = {code for low, high in ranges for code in range(low, high)} | {0x2026, 0x2014, 0x00B7, 0x2318, 0x2713, 0x2715, 0x2022}
for high in range(0xA1, 0xF8):
    for low in range(0xA1, 0xFF):
        try:
            characters.add(ord(bytes([high, low]).decode("gb2312")))
        except UnicodeDecodeError:
            pass

options = subset.Options()
options.font_number = face
options.layout_features = ["kern", "liga", "locl", "vert"]
options.name_IDs = [1, 2, 3, 4, 6]
options.notdef_outline = True
options.desubroutinize = True
font = subset.load_font(source, options)
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=characters)
subsetter.subset(font)
subset.save_font(font, target, options)
print(f"{target}: {len(font.getGlyphOrder())} glyphs")
