// iOS launch screens for the Home Screen app (web/public/splash/*.png, linked from web/index.html). Without one, iOS
// flashes white between tapping the icon and the first paint. Each is the app icon centred on basalt at the exact
// pixel size of one iPhone (~170KB each; a phone only fetches its own). Run: node scripts/splash.ts   (needs system Chrome)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

// [css width, css height, device pixel ratio]: portrait iPhones from the SE (2nd/3rd gen) to the 16 Pro Max.
export const SPLASH: [number, number, number][] = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [414, 896, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3], [375, 812, 3],
  [414, 896, 2], [375, 667, 2],
];
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const icon = fs.readFileSync(new URL('../desktop/AppIcon-1024.png', import.meta.url)).toString('base64');
const out = new URL('../web/public/splash/', import.meta.url);
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  for (const [w, h, dpr] of SPLASH) {
    // Drawn on a canvas at device pixels. The icon file has the macOS margin around its squircle, so 34% of the width
    // shows a ~28%-wide tile, like a launch logo.
    const png = await page.evaluate(async (w, h, icon) => {
      const img = new Image(); img.src = `data:image/png;base64,${icon}`; await img.decode();
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d')!; g.fillStyle = '#16181d'; g.fillRect(0, 0, w, h);
      const s = Math.round(w * .34); g.imageSmoothingQuality = 'high'; g.drawImage(img, (w - s) >> 1, (h - s) >> 1, s, s);
      // 6 bits per channel inside the icon (invisible on the photo, ~25% smaller files); the basalt around it stays exact.
      const d = g.getImageData((w - s) >> 1, (h - s) >> 1, s, s);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) if (px[i] !== 0x16 || px[i + 1] !== 0x18 || px[i + 2] !== 0x1d)
        for (let k = i; k < i + 3; k++) px[k] = Math.min(255, (px[k] + 2) & ~3);
      g.putImageData(d, (w - s) >> 1, (h - s) >> 1);
      return c.toDataURL('image/png').split(',')[1];
    }, w * dpr, h * dpr, icon);
    const file = `${w * dpr}x${h * dpr}.png`;
    fs.writeFileSync(new URL(file, out), Buffer.from(png, 'base64'));
    console.log(file);
  }
} finally { await browser.close(); }
