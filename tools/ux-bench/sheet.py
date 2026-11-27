#!/usr/bin/env python3
"""Paste screenshots into one labelled sheet, each fitted into a box: sheet.py <out.png> <box-px> <cols> <file>..."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

out, box, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
files = [f for f in sys.argv[4:] if Path(f).exists()]
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (box + 8), rows * (box + 18)), (200, 30, 30))
d = ImageDraw.Draw(sheet)
for k, f in enumerate(files):
    im = Image.open(f).convert("RGB")
    scale = box / max(im.width, im.height)
    im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))))
    x, y = (k % cols) * (box + 8), (k // cols) * (box + 18)
    sheet.paste(im, (x, y + 16))
    d.text((x + 2, y + 2), Path(f).stem[-60:], fill=(255, 255, 255))
sheet.save(out)
