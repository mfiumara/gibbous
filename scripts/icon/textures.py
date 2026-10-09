# Unlit near-side textures for the in-app background moon: albedo + view-space normals (crater relief baked in),
# both orthographic discs, so the WebGL shader only has to light them for today's phase.
# usage: MOONKIT=dir textures.py out_dir [size] [relief]
import os, sys, numpy as np, tifffile
from PIL import Image

out = sys.argv[1]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 1536
relief = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
DATA = os.environ.get('MOONKIT', 'moonkit')
R_KM = 1737.4

color = tifffile.imread(f'{DATA}/lroc_color_poles_16k.tif')
dem = tifffile.imread(f'{DATA}/ldem_16.tif').astype(np.float32)
dh_dlat = -np.gradient(dem, axis=0) / np.radians(180 / dem.shape[0])
dh_dlon = np.gradient(dem, axis=1) / np.radians(360 / dem.shape[1])

def bilinear(img, fy, fx):
    h, w = img.shape[:2]
    x0 = np.floor(fx).astype(np.int64); y0 = np.clip(np.floor(fy).astype(np.int64), 0, h - 1)
    tx = fx - x0; ty = fy - np.floor(fy)
    if img.ndim == 3: tx, ty = tx[..., None], ty[..., None]
    x0 %= w; x1 = (x0 + 1) % w; y1 = np.clip(y0 + 1, 0, h - 1)
    return (img[y0, x0] * (1 - tx) + img[y0, x1] * tx) * (1 - ty) + (img[y1, x0] * (1 - tx) + img[y1, x1] * tx) * ty

SS = 2; M = N * SS
c = (M - 1) / 2
y, x = np.mgrid[0:M, 0:M].astype(np.float32)
u = (x - c) / (M * 0.5); v = (c - y) / (M * 0.5)
inside = u * u + v * v < 1
u, v = u[inside], v[inside]
z = np.sqrt(1 - u * u - v * v)
lat = np.arcsin(v); lon = np.arctan2(u, z)
tc = lambda s: ((np.pi / 2 - lat) / np.pi * s[0] - 0.5, (lon + np.pi) / (2 * np.pi) * s[1] - 0.5)

alb = bilinear(color.astype(np.float32), *tc(color.shape))
fy, fx = tc(dem.shape)
g_lat = bilinear(dh_dlat, fy, fx) * relief / R_KM
g_lon = bilinear(dh_dlon, fy, fx) * relief / R_KM / np.maximum(np.cos(lat), 0.05)
n0 = np.stack([u, v, z], -1)
e = np.stack([np.cos(lon), np.zeros_like(lon), -np.sin(lon)], -1)
nn = np.stack([-np.sin(lat) * np.sin(lon), np.cos(lat), -np.sin(lat) * np.cos(lon)], -1)
n = n0 - g_lon[:, None] * e - g_lat[:, None] * nn
n /= np.linalg.norm(n, axis=-1, keepdims=True)

def save(vals, name, fill):
    img = np.full((M, M, 3), fill, np.float32); img[inside] = vals
    Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8)).resize((N, N), Image.LANCZOS).save(f'{out}/{name}', quality=82, method=6)

os.makedirs(out, exist_ok=True)
save(alb, 'albedo.webp', 0)
save((n * 0.5 + 0.5) * 255, 'normal.webp', 127.5)   # rgb = xyz; outside the disc: a flat "facing you" normal
print('ok', N)
