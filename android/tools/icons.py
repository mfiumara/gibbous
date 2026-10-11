#!/usr/bin/env python3
"""Generate the Android launcher, notification and store icons from the iOS app icon.

    python3 android/tools/icons.py      # needs Pillow (pip install pillow)

Writes android/app/src/main/res/{mipmap-*,drawable-*}/... and android/store/icon-512.png.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "ios/Gibbous/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
LOGO = ROOT / "ios/Gibbous/Assets.xcassets/Logo.imageset/Logo@3x.png"
RES = ROOT / "android/app/src/main/res"
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
CX, CY, R = 548, 510, 400  # the moon disc in the 1024 icon
TOP, BOTTOM = (30, 34, 47), (15, 18, 25)  # the icon's background gradient

src = Image.open(SRC).convert("RGB")
moon = src.crop((CX - R, CY - R, CX + R, CY + R))
S = 2 * R

def disc_mask(size, soft=1.5):
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    return m.resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(soft))

disc = moon.convert("RGBA")
disc.putalpha(disc_mask(S))
# The sunlit part as a clean geometric gibbous (left half disc + the terminator ellipse), centred on its own box.
K = 0.62  # terminator half-width / radius, measured on the icon
def gibbous(size):
    big = size * 4
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    w = (1 + K) / 2  # the shape's width as a fraction of the diameter
    r = big / 2 / max(w, 1) if w > 1 else big / 2
    cx = big / 2 + (r - r * K) / 2  # shift so the shape is centred
    d.pieslice((cx - r, big / 2 - r, cx + r, big / 2 + r), 90, 270, fill=255)
    d.ellipse((cx - r * K, big / 2 - r, cx + r * K, big / 2 + r), fill=255)
    return m.resize((size, size), Image.LANCZOS)
silhouette = Image.new("RGBA", (S, S), (255, 255, 255, 0))
silhouette.putalpha(gibbous(S))

def gradient(size):
    g = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return g

def place(img, canvas, diameter):
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    sm = img.resize((diameter, diameter), Image.LANCZOS)
    o = (canvas - diameter) // 2
    out.alpha_composite(sm, (o, o))
    return out

for name, k in DENS.items():
    # Adaptive icon layers: 108dp canvas, moon inside the 66dp safe zone.
    d = RES / f"mipmap-{name}"
    d.mkdir(parents=True, exist_ok=True)
    c = round(108 * k)
    place(disc, c, round(64 * k)).save(d / "ic_launcher_foreground.png", optimize=True)
    place(silhouette, c, round(60 * k)).save(d / "ic_launcher_monochrome.png", optimize=True)
    gradient(c).save(d / "ic_launcher_background.png", optimize=True)
    # Notification small icon: 24dp, white on transparent.
    n = RES / f"drawable-{name}"
    n.mkdir(parents=True, exist_ok=True)
    place(silhouette, round(24 * k), round(22 * k)).save(n / "ic_notification.png", optimize=True)

nodpi = RES / "drawable-nodpi"
nodpi.mkdir(parents=True, exist_ok=True)
Image.open(LOGO).save(nodpi / "logo.png", optimize=True)

store = ROOT / "android/store"
store.mkdir(parents=True, exist_ok=True)
icon = gradient(512).convert("RGBA")
icon.alpha_composite(place(disc, 512, 400))
icon.save(store / "icon-512.png", optimize=True)
print("icons written")
