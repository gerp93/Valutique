// One-off icon generation from the source mark. Run with: npm run icons
//
// assets/logo.svg is the master. Every raster below -- including assets/logo.png
// itself -- is generated from it, so no size is ever hand-exported and none can
// drift from the others.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'logo.svg');

// Sizes each destination needs, and why it exists.
const TARGETS = [
  // electron-builder auto-generates .ico/.icns for win/mac/linux from this one source.
  { file: ['build', 'icon.png'], size: 1024 },
  // The source mark checked in for the README and as the canonical raster.
  { file: ['assets', 'logo.png'], size: 512 },
  // BrowserWindow icon (dev window + taskbar), set at runtime in main.ts.
  { file: ['assets', 'icon.png'], size: 256 },
  // In-app usage: the sidebar mark next to the product name.
  { file: ['src', 'renderer', 'assets', 'logo.png'], size: 128 },
];

async function main() {
  const svg = fs.readFileSync(SRC);

  for (const target of TARGETS) {
    const dest = path.join(ROOT, ...target.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // The source is already square, so density-render at the target size rather
    // than rasterizing once and upscaling -- keeps the small sizes crisp.
    await sharp(svg, { density: 384 }).resize(target.size, target.size).png().toFile(dest);
    console.log(`${target.size.toString().padStart(4)}px  ${path.relative(ROOT, dest)}`);
  }

  console.log('Icons generated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
