# Icon set from the rendered moon: macOS app icon, iOS/PWA icons (full-bleed, maskable-safe), favicons.
# usage: compose.py moon-2048.png out_dir
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFilter

moon = Image.open(sys.argv[1]).convert('RGBA')
out = sys.argv[2]

def sky(size):
    # Deep night: near-black blue at the top falling to black, a cool bloom where the lit limb faces.
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    top, bottom = np.array([18, 21, 30]), np.array([5, 6, 9])
    g = top * (1 - y[..., None]) + bottom * y[..., None]
    bloom = np.exp(-(((x - 0.40) / 0.42) ** 2 + ((y - 0.46) / 0.42) ** 2))[..., None]
    g = g + bloom * np.array([26, 30, 38])
    return Image.fromarray(np.clip(g, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

def place(canvas, diameter, cx, cy):
    m = moon.resize((diameter, diameter), Image.LANCZOS)
    # Soft glow from the moon itself, so it sits in the sky instead of on it.
    glow = m.split()[3].point(lambda a: a * 0.55).filter(ImageFilter.GaussianBlur(diameter * 0.06))
    halo = Image.new('RGBA', m.size, (190, 205, 230, 0)); halo.putalpha(glow)
    pad = int(diameter * 0.2)
    big = Image.new('RGBA', (diameter + 2 * pad,) * 2, (0, 0, 0, 0)); big.paste(halo, (pad, pad), halo)
    big = big.filter(ImageFilter.GaussianBlur(diameter * 0.05))
    canvas.alpha_composite(big, (cx - diameter // 2 - pad, cy - diameter // 2 - pad))
    canvas.alpha_composite(m, (cx - diameter // 2, cy - diameter // 2))

def squircle_mask(size, inset, radius):
    s = 4  # draw big, shrink: smooth edges
    m = Image.new('L', (size * s,) * 2, 0)
    ImageDraw.Draw(m).rounded_rectangle([inset * s, inset * s, (size - inset) * s, (size - inset) * s], radius * s, fill=255)
    return m.resize((size, size), Image.LANCZOS)

# macOS: Apple's 1024 grid, 824 body, ~185 corner radius, soft drop shadow. The moon is nudged right so its
# lit face (left) sits in the optical centre.
S = 1024
body = sky(S)
place(body, 640, S // 2 + 30, S // 2)
mask = squircle_mask(S, 100, 185)
icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0)); shadow.putalpha(mask.point(lambda a: a * 0.5))
icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)), (0, 10))
body.putalpha(mask)
icon.alpha_composite(body)
# Hairline highlight along the top edge of the tile, like light catching glass.
edge = squircle_mask(S, 100, 185); inner = squircle_mask(S, 102, 183)
rim = Image.fromarray(np.clip(np.asarray(edge, np.int16) - np.asarray(inner, np.int16), 0, 255).astype(np.uint8))
fade = Image.linear_gradient('L').resize((S, S)).point(lambda v: 255 - v).point(lambda v: v * 0.22)
rim = Image.fromarray((np.asarray(rim, np.float32) * np.asarray(fade, np.float32) / 255).astype(np.uint8))
hl = Image.new('RGBA', (S, S), (255, 255, 255, 0)); hl.putalpha(rim)
icon.alpha_composite(hl)
icon.save(f'{out}/AppIcon-1024.png')

# iOS home screen + PWA: full-bleed square (the OS rounds it). Maskable needs the subject inside the
# central 80% circle, so the moon stays at ~62% of the tile.
for size, name, frac in [(512, 'icon-512.png', 0.62), (192, 'icon-192.png', 0.66), (180, 'apple-touch-icon.png', 0.70)]:
    c = sky(size); place(c, int(size * frac), size // 2 + int(size * 0.02), size // 2)
    c.convert('RGB').save(f'{out}/{name}')

# Favicons: just the moon, transparent, a little extra contrast so craters survive 32px.
for size in (32, 64):
    m = moon.resize((size, size), Image.LANCZOS)
    rgb = np.asarray(m, np.float32); rgb[..., :3] = np.clip((rgb[..., :3] - 128) * 1.15 + 136, 0, 255)
    lum = rgb[..., :3].mean(-1) / 255
    rgb[..., 3] *= np.clip((lum - 0.03) * 14, 0, 1)   # night side transparent: on a white tab only the lit gibbous shows
    Image.fromarray(rgb.astype(np.uint8), 'RGBA').save(f'{out}/favicon-{size}.png')
print('ok')
