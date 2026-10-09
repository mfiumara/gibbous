# Waning gibbous Moon from NASA's CGI Moon Kit (LRO colour mosaic + LOLA elevation), orthographic near side.
# usage: MOONKIT=dir render.py out.png size [phase_deg] [relief]   (see README.md for the data)
import os, sys, numpy as np, tifffile
from PIL import Image

out, size = sys.argv[1], int(sys.argv[2])
phase = np.radians(float(sys.argv[3]) if len(sys.argv) > 3 else 52)   # angle Sun-Moon-Earth; 0 = full
relief = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0            # elevation exaggeration for icon legibility
SS = 2                                                               # supersampling
N = size * SS
R_KM = 1737.4

DATA = os.environ.get('MOONKIT', 'moonkit')
color = tifffile.imread(f'{DATA}/lroc_color_poles_16k.tif')        # (8192, 16384, 3) uint8, lon -180..180
dem = tifffile.imread(f'{DATA}/ldem_16.tif').astype(np.float32)    # (2880, 5760) km
albedo_lin = (color.astype(np.float32) / 255) ** 2.2

# Elevation gradients (km per radian) on the DEM grid.
dh_dlat = -np.gradient(dem, axis=0) / np.radians(180 / dem.shape[0])   # row 0 = north
dh_dlon = np.gradient(dem, axis=1) / np.radians(360 / dem.shape[1])

def bilinear(img, fy, fx):
    h, w = img.shape[:2]
    x0 = np.floor(fx).astype(np.int64); y0 = np.clip(np.floor(fy).astype(np.int64), 0, h - 1)
    tx = (fx - x0)[..., None] if img.ndim == 3 else fx - x0
    ty = (fy - np.floor(fy))[..., None] if img.ndim == 3 else fy - np.floor(fy)
    x0 %= w; x1 = (x0 + 1) % w; y1 = np.clip(y0 + 1, 0, h - 1)
    a, b, c, d = img[y0, x0], img[y0, x1], img[y1, x0], img[y1, x1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty

# Screen → sphere (orthographic, viewer on +z, north up, lunar east on the right).
c = (N - 1) / 2
y, x = np.mgrid[0:N, 0:N].astype(np.float32)
u = (x - c) / (N * 0.5); v = (c - y) / (N * 0.5)
r2 = u * u + v * v
inside = r2 < 1
u, v = u[inside], v[inside]
z = np.sqrt(1 - u * u - v * v)
lat = np.arcsin(v); lon = np.arctan2(u, z)

def tex_coords(shape):
    h, w = shape[:2]
    return (np.pi / 2 - lat) / np.pi * h - 0.5, (lon + np.pi) / (2 * np.pi) * w - 0.5

alb = bilinear(albedo_lin, *tex_coords(albedo_lin.shape))
fy, fx = tex_coords(dem.shape)
g_lat = bilinear(dh_dlat, fy, fx) * relief / R_KM
g_lon = bilinear(dh_dlon, fy, fx) * relief / R_KM / np.maximum(np.cos(lat), 0.05)

# Local frame: radial n0, east e, north nn (in view coordinates).
n0 = np.stack([u, v, z], -1)
e = np.stack([np.cos(lon), np.zeros_like(lon), -np.sin(lon)], -1)
nn = np.stack([-np.sin(lat) * np.sin(lon), np.cos(lat), -np.sin(lat) * np.cos(lon)], -1)
n = n0 - g_lon[:, None] * e - g_lat[:, None] * nn
n /= np.linalg.norm(n, axis=-1, keepdims=True)

# Waning gibbous: Sun to the left (west limb lit, as seen from the northern hemisphere).
sun = np.array([-np.sin(phase), 0.0, np.cos(phase)], np.float32)
cos_i = n @ sun; cos_e = np.clip(n[:, 2], 1e-3, 1)
cos_i0 = n0 @ sun                                   # smooth-sphere incidence: the terminator itself
L = 0.65                                            # lunar-Lambert: mostly Lommel-Seeliger, the Moon's flat look
shade = np.where(cos_i > 0, (1 - L) * cos_i + L * 2 * cos_i / (cos_i + cos_e), 0)
shade *= np.clip(cos_i0 * 18 + 1.0, 0, 1)            # crater rims catch light just past the terminator, then night
I = alb * shade[:, None] * 1.72
I += alb * 0.0035                                   # faint earthshine so the whole disc reads

img = np.zeros((N, N, 4), np.float32)
lin = np.clip(I, 0, None)
lin = lin / (1 + lin * 0.35)                        # soft shoulder so the bright limb doesn't clip
srgb = np.clip(lin, 0, 1) ** (1 / 2.2)
srgb = np.clip((srgb - 0.5) * 1.08 + 0.5 + 0.01, 0, 1)   # a touch of print contrast
img[inside, :3] = srgb
# Analytic edge coverage for a clean limb.
cov = np.clip((1 - np.sqrt(np.maximum(r2, 0))) * N * 0.5 + 0.5, 0, 1)
img[..., 3] = cov
im = Image.fromarray((img * 255 + 0.5).astype(np.uint8), 'RGBA').resize((size, size), Image.LANCZOS)
im.save(out)
print('wrote', out, im.size)
