"""A deterministic photo-like test picture for the image benchmark: smooth
sky/ground gradients, soft blobs (bokeh), hard-edged shapes and fine grain, so
a JPEG decoder sees what a camera picture gives it (all frequencies)."""
import math
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = int(sys.argv[2]), int(sys.argv[3])
q = int(sys.argv[4])
rng = random.Random(20261119)
img = Image.new('RGB', (W, H))
px = img.load()
for y in range(H):
    t = y / H
    for x in range(W):
        u = x / W
        if t < 0.55:
            r, g, b = 70 + 120 * t + 30 * u, 120 + 100 * t, 200 + 40 * (1 - t)
        else:
            k = (t - 0.55) / 0.45
            r, g, b = 90 + 60 * k + 20 * math.sin(u * 9), 110 - 30 * k + 15 * math.sin(u * 23 + k * 5), 50 + 20 * k
        px[x, y] = (int(r), int(g), int(b))
d = ImageDraw.Draw(img, 'RGBA')
for _ in range(60):
    x, y, r = rng.randrange(W), rng.randrange(H), rng.randrange(8, 90)
    d.ellipse((x - r, y - r, x + r, y + r), fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256), rng.randrange(40, 140)))
img = img.filter(ImageFilter.GaussianBlur(3))
d = ImageDraw.Draw(img, 'RGBA')
for _ in range(40):
    pts = [(rng.randrange(W), rng.randrange(H)) for _ in range(3)]
    d.polygon(pts, fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256), 200))
for i in range(0, W, 24):
    d.line((i, int(H * 0.7), i + 12, H), fill=(30, 40, 20, 160), width=2)
px = img.load()
for y in range(H):
    for x in range(W):
        n = rng.randrange(-4, 5)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
img.save(sys.argv[1], 'JPEG', quality=q, subsampling=2, optimize=True, progressive=False)
