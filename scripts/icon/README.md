# App icon

The icon is a render of the real Moon, waning gibbous, made from NASA's [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720):
the LRO colour mosaic for surface albedo, and LOLA elevation for crater relief along the terminator. Credit: NASA's
Scientific Visualization Studio. The data is public domain.

```sh
mkdir -p moonkit && cd moonkit
curl -LO https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif   # 187 MB
curl -LO https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif                # 66 MB
cd .. && uv run --with numpy --with pillow --with tifffile --with imagecodecs sh -c '
  MOONKIT=moonkit python render.py moon-2048.png 2048 &&
  python compose.py moon-2048.png out'
cp out/AppIcon-1024.png ../../desktop/ && cp out/{icon-512,icon-192,apple-touch-icon,favicon-32,favicon-64}.png ../../web/public/
```

`render.py` takes an optional phase angle (default 52°; 0 is full) and relief exaggeration (default 4×).

## Background moon

The faint moon behind the app (`web/src/SkyMoon.tsx`) uses two textures baked from the same data: near-side albedo
and view-space normals carrying the crater relief. A small WebGL shader lights them for the current phase, using the
same lunar-Lambert model as the icon, plus earthshine on the night side.

```sh
MOONKIT=moonkit uv run --with numpy --with pillow --with tifffile --with imagecodecs python textures.py ../../web/public/moon
```
