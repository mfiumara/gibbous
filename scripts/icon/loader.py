# The loading moon: one full lunation as a sprite strip. Lights the baked near-side textures (textures.py) at full
# resolution exactly like SkyMoon's shader, then scales each frame down.
# usage: loader.py web/public/moon [frames] [frame_px]
import sys, numpy as np
from PIL import Image

d = sys.argv[1]
FRAMES = int(sys.argv[2]) if len(sys.argv) > 2 else 36
PX = int(sys.argv[3]) if len(sys.argv) > 3 else 96

alb = (np.asarray(Image.open(f'{d}/albedo.webp').convert('RGB'), np.float32) / 255) ** 2.2
n = np.asarray(Image.open(f'{d}/normal.webp').convert('RGB'), np.float32) / 255 * 2 - 1
n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
N = alb.shape[0]
y, x = np.mgrid[0:N, 0:N].astype(np.float32)
qx = (x + 0.5) / N * 2 - 1; qy = 1 - (y + 0.5) / N * 2
r = np.sqrt(qx * qx + qy * qy)
edge = np.clip((1 - r) * N / 2.5, 0, 1)
n0 = np.stack([qx, qy, np.sqrt(np.maximum(0, 1 - r * r))], -1)

strip = Image.new('RGBA', (PX * FRAMES, PX), (0, 0, 0, 0))
for i in range(FRAMES):
    e = 2 * np.pi * i / FRAMES                       # 0 new → waxing (lit right) → full → waning (lit left)
    sun = np.array([np.sin(e), 0, -np.cos(e)], np.float32)
    ci = n @ sun; ce = np.maximum(n[..., 2], 1e-3)
    shade = np.where(ci > 0, .35 * ci + .65 * 2 * ci / (ci + ce + 1e-6), 0) * np.clip(n0 @ sun * 18 + 1, 0, 1)
    c = alb * shade[..., None] * 1.7
    c += alb * .07 * (.5 - .5 * sun[2]) * np.clip(1 - ci * 4, 0, 1)[..., None]   # earthshine: a loader never goes blank
    c = c / (1 + c * .35)
    c = np.clip(c, 0, 1) ** (1 / 2.2)
    a = edge * np.clip(c.max(-1) * 6, 0, 1)
    frame = np.dstack([c * 255, a * 255]).astype(np.uint8)
    strip.paste(Image.fromarray(frame, 'RGBA').resize((PX, PX), Image.LANCZOS), (i * PX, 0))
strip.save(f'{d}/phases.webp', quality=88, method=6)
print('ok', strip.size)
