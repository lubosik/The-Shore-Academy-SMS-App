// Generates the PWA icons from The Shore Academy badge mark.
// The badge's outer ring is navy, so it is flattened onto brand cream
// (#E6D6B8) — same treatment as the iOS app icon — with a small inset so
// "maskable" (circular) cropping never clips the ring.
//
// This is a one-off local utility. The icons it writes are committed, so it is
// not part of the build and `canvas` is deliberately NOT in package.json:
// canvas has a native addon, and when its prebuilt binary fails to download it
// falls back to a node-gyp source build that needs Python, which the deploy
// image does not have. Listing it at all made every deploy hostage to that
// download. Install it on demand instead:
//
//   npm install --no-save canvas && node generate-icons.js
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const SOURCE = process.env.SHORE_LOGO ||
  '/Users/ghost/Downloads/The Shore Academy Logo Removed.png';
const CREAM = '#E6D6B8';

function generateIcon(logo, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Flatten onto cream — no transparency survives.
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, size, size);

  // Inset the badge so maskable crops keep the full ring visible.
  const inset = Math.round(size * 0.1);
  const drawSize = size - inset * 2;
  ctx.drawImage(logo, inset, inset, drawSize, drawSize);

  return canvas.toBuffer('image/png');
}

(async () => {
  const logo = await loadImage(SOURCE);
  const iconsDir = path.join(__dirname, 'public', 'icons');
  if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

  for (const size of [192, 512]) {
    fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), generateIcon(logo, size));
  }
  console.log('Icons generated: icon-192.png, icon-512.png');
})().catch(err => { console.error(err.message); process.exit(1); });
