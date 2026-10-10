#!/usr/bin/env python3
"""Regenerate the iOS icon assets from desktop/AppIcon-1024.png (needs Pillow).

The Mac icon is a rounded tile with transparent margins; iOS wants a full-bleed opaque square (it masks the corners
itself), so the tile is cropped, laid over a gradient of its own edge colours and flattened."""
import json, os, sys
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = Image.open(os.path.join(root, 'desktop/AppIcon-1024.png')).convert('RGBA')
assets = os.path.join(root, 'ios/Gibbous/Assets.xcassets')

tile = src.crop((100, 100, 924, 924)).resize((1024, 1024), Image.LANCZOS)
bg = Image.new('RGBA', (1024, 1024))
top, bottom = (28, 33, 45), (15, 17, 24)
for y in range(1024):
    t = y / 1023
    c = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,)
    bg.paste(c, (0, y, 1024, y + 1))
icon = Image.alpha_composite(bg, tile).convert('RGB')
icon.save(os.path.join(assets, 'AppIcon.appiconset/AppIcon-1024.png'))

# Launch screen + connect screen: the tile (with its soft shadow) on the app background, 128pt.
logo = src.crop((60, 60, 964, 964))
for scale in (1, 2, 3):
    logo.resize((128 * scale, 128 * scale), Image.LANCZOS).save(os.path.join(assets, f'Logo.imageset/Logo@{scale}x.png'))
print('icons written to', assets)
