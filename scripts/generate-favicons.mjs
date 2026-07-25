/**
 * Rasterise public/favicon.svg into the PNG siblings browsers still ask for
 * (P19 task 1): favicon-32.png and apple-touch-icon.png. Outputs are COMMITTED;
 * this script is deliberately NOT wired into the `pre` hooks or CI — same discipline as
 * scripts/record-ajv-errors.mjs. Re-run it by hand (`npm run favicons`) after
 * editing the SVG, and commit the two PNGs alongside it.
 *
 * Deviation from phase-19's sketch: it names `sharp`. We rasterise with
 * Playwright instead — already a devDependency, already browser-cached in CI,
 * and it renders the SVG through the same engine that will paint the tab, so
 * what you commit is what Chrome shows. One fewer native dependency.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const svg = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');

/** --q-paper: iOS masks the corners of the touch icon and does not honour alpha. */
const PAPER = '#ffffff';

const targets = [
  { file: 'favicon-32.png', size: 32, background: null },
  { file: 'apple-touch-icon.png', size: 180, background: PAPER },
];

const browser = await chromium.launch();
try {
  for (const { file, size, background } of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:${String(size)}px;height:${String(size)}px;` +
        `background:${background ?? 'transparent'}}` +
        `svg{display:block;width:${String(size)}px;height:${String(size)}px}</style>` +
        svg,
    );
    const png = await page.screenshot({ omitBackground: background === null });
    writeFileSync(join(publicDir, file), png);
    await page.close();
    console.log(`generate-favicons: wrote public/${file} (${String(size)}×${String(size)})`);
  }
} finally {
  await browser.close();
}
