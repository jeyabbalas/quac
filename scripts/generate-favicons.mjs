/**
 * Derive the favicon set from the brand artwork — `assets/logo/quac-duck.svg` is the
 * single source of truth, so the tab icon is the same duck as the header mark rather
 * than a redrawing of it. Outputs (all COMMITTED): public/favicon.svg, favicon-32.png,
 * apple-touch-icon.png. Like scripts/record-ajv-errors.mjs this stays out of the `pre`
 * hooks and CI — re-run it by hand (`npm run favicons`) after the artwork changes and
 * commit the three files together.
 *
 * P19 hand-drew the favicon on the premise that the duck was a raster it couldn't
 * downscale. That premise died with `a44d234` (assets replaced by three clean vector
 * paths), so the artwork itself is what we place here.
 *
 * Two things earn their complexity:
 *   - Placement is measured, not eyeballed. We sample the artwork's outline, solve for
 *     its minimal enclosing circle, and drop that circle concentric with the disk. A
 *     bounding-box centre would sit off to the left (the bill juts right) and would
 *     force a smaller duck to keep the tail clear of the ring.
 *   - Path coordinates are baked into the 32-unit icon space instead of riding on a
 *     `transform`. Favicons pass through rasterisers far dumber than a browser; a file
 *     whose numbers are already in its own viewBox has nothing left to get wrong.
 *
 * Rasterising is Playwright, not `sharp` (P19's call, unchanged): already a devDep,
 * already browser-cached in CI, and it renders through the engine that paints the tab.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artworkPath = join(root, 'assets', 'logo', 'quac-duck.svg');
const publicDir = join(root, 'public');

/* Brand hexes as literals: an SVG served as an icon cannot read tokens.css. Keep the
   first three in step with it. The bill keeps the ARTWORK's orange, not --q-orange
   (#ff9f1c): on --q-yellow that measures 1.42:1 and the bill dissolves into the head at
   16 px, where the artwork's #f95d1d holds 2.19:1 and still reads as a bill. */
const SKY = '#00ccff'; // --q-sky
const INK = '#111111'; // --q-ink
const YELLOW = '#ffd21e'; // --q-yellow
const BILL = '#f95d1d';
const PAPER = '#ffffff'; // --q-paper

/** Artwork hex → icon hex. An unmapped fill is a hard error: the artwork changed. */
const RECOLOUR = new Map([
  ['#fec511', YELLOW],
  ['#050505', INK],
  ['#f95d1d', BILL],
]);

const SIZE = 32; // viewBox units; the icon is one disk, edge to edge
const RING = 2; // ink ring, drawn last so the duck can meet it without a seam
const MARGIN = 1.2; // sky between duck and ring — 0.8 crowds the head, 1.8 wastes the tile
const DUCK_RADIUS = SIZE / 2 - RING - MARGIN;

const PATH_RE = /<path\b[^>]*?\bd="([^"]+)"[^>]*?\bfill="([^"]+)"[^>]*>/g;

/**
 * The artwork's filled shapes in draw order (body, outline, bill), already recoloured.
 * @returns {{ svg: string; shapes: { d: string; fill: string }[] }}
 */
function readArtwork() {
  const svg = readFileSync(artworkPath, 'utf8');
  /** @type {{ d: string; fill: string }[]} */
  const shapes = [];
  for (const [, d, fill] of svg.matchAll(PATH_RE)) {
    if (d === undefined || fill === undefined)
      throw new Error(`unreadable <path> in ${artworkPath}`);
    const recoloured = RECOLOUR.get(fill.toLowerCase());
    if (recoloured === undefined)
      throw new Error(`unmapped artwork fill "${fill}" — update RECOLOUR`);
    shapes.push({ d, fill: recoloured });
  }
  if (shapes.length === 0) throw new Error(`no <path> found in ${artworkPath}`);
  return { svg, shapes };
}

/**
 * Minimal enclosing circle of the drawn outline, in artwork units. Bădoiu–Clarkson:
 * step the centre 1/(i+1) of the way toward the current farthest point. Deterministic,
 * and converges well inside the 0.01-unit precision we round to.
 * @param {import('playwright').Page} page
 * @param {string} svg
 * @returns {Promise<{ cx: number; cy: number; r: number }>}
 */
async function measureArtwork(page, svg) {
  await page.setContent(svg.replace(/<\?xml[^>]*\?>/, ''));
  /* global document -- the callback below is serialised into the page, not run in node */
  return page.evaluate(() => {
    /** @type {[number, number][]} */
    const points = [];
    for (const el of document.querySelectorAll('path')) {
      const length = el.getTotalLength();
      const samples = Math.max(600, Math.ceil(length / 2));
      for (let i = 0; i < samples; i++) {
        const { x, y } = el.getPointAtLength((length * i) / samples);
        points.push([x, y]);
      }
    }
    const root = document.querySelector('svg');
    if (!root || points.length === 0) throw new Error('artwork has no drawable path');
    const box = root.getBBox();
    /** @type {[number, number]} */
    let centre = [box.x + box.width / 2, box.y + box.height / 2];
    /** @param {[number, number]} c */
    const farthest = (c) => {
      let point = c;
      let squared = -1;
      for (const p of points) {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
        if (d > squared) [point, squared] = [p, d];
      }
      return { point, distance: Math.sqrt(squared) };
    };
    for (let i = 1; i <= 3000; i++) {
      const { point } = farthest(centre);
      centre = [
        centre[0] + (point[0] - centre[0]) / (i + 1),
        centre[1] + (point[1] - centre[1]) / (i + 1),
      ];
    }
    return { cx: centre[0], cy: centre[1], r: farthest(centre).distance };
  });
}

/** @param {number} v */
const round = (v) => {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
};

/**
 * Rewrite absolute M/C/Z path data into icon space. Absolute-only is what the artwork
 * uses (225 C, 9 M, 9 Z) and all this can safely handle — a relative command would
 * accumulate the translate, so we refuse rather than emit a mangled duck.
 * @param {string} d
 * @param {{ x: (n: number) => number; y: (n: number) => number }} place
 */
function bake(d, place) {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  /** @type {string[]} */
  const out = [];
  /** @type {number | null} */
  let pendingX = null;
  for (const token of tokens) {
    if (!/[A-Za-z]/.test(token)) {
      if (pendingX === null) {
        pendingX = Number(token);
      } else {
        out.push(round(place.x(pendingX)), round(place.y(Number(token))));
        pendingX = null;
      }
      continue;
    }
    if (!'MCZ'.includes(token)) throw new Error(`path command "${token}" is not absolute M/C/Z`);
    if (pendingX !== null) throw new Error(`odd coordinate count before "${token}"`);
    out.push(token);
  }
  if (pendingX !== null) throw new Error('path data ended mid-coordinate');
  return out.join(' ');
}

/**
 * @param {{ d: string; fill: string }[]} shapes
 * @param {{ cx: number; cy: number; r: number }} circle
 */
function composeIcon(shapes, { cx, cy, r }) {
  const scale = DUCK_RADIUS / r;
  const place = {
    /** @param {number} x */ x: (x) => (x - cx) * scale + SIZE / 2,
    /** @param {number} y */ y: (y) => (y - cy) * scale + SIZE / 2,
  };
  const duck = shapes
    .map(({ d, fill }) => `  <path d="${bake(d, place)}" fill="${fill}" fill-rule="evenodd"/>`)
    .join('\n');
  return `<!-- GENERATED by scripts/generate-favicons.mjs from assets/logo/quac-duck.svg.
     Do not hand-edit: change the artwork (or the script's placement constants) and run
     \`npm run favicons\`. Colours are brand hexes as literals because an SVG served as
     an icon cannot read tokens.css — see the script for the one that isn't a token. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(SIZE)} ${String(SIZE)}" role="img" aria-label="QuaC">
  <circle cx="16" cy="16" r="15" fill="${SKY}"/>
${duck}
  <circle cx="16" cy="16" r="15" fill="none" stroke="${INK}" stroke-width="${String(RING)}"/>
</svg>
`;
}

/* iOS masks the corners of the touch icon and does not honour alpha, hence the paper
   square; its inset keeps the disk clear of the mask's curve. */
const targets = [
  { file: 'favicon-32.png', size: 32, background: /** @type {string | null} */ (null), inset: 0 },
  { file: 'apple-touch-icon.png', size: 180, background: PAPER, inset: 0.08 },
];

const { svg, shapes } = readArtwork();
const browser = await chromium.launch();
try {
  const measurePage = await browser.newPage();
  const circle = await measureArtwork(measurePage, svg);
  await measurePage.close();
  console.log(
    `generate-favicons: duck fits a circle r=${circle.r.toFixed(1)} at ` +
      `(${circle.cx.toFixed(1)}, ${circle.cy.toFixed(1)}) in artwork units`,
  );

  const icon = composeIcon(shapes, circle);
  writeFileSync(join(publicDir, 'favicon.svg'), icon);
  console.log(`generate-favicons: wrote public/favicon.svg (${String(SIZE)}-unit viewBox)`);

  for (const { file, size, background, inset } of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const pad = Math.round(size * inset);
    const drawn = size - 2 * pad;
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:${String(size)}px;height:${String(size)}px;` +
        `background:${background ?? 'transparent'}}` +
        `svg{display:block;position:absolute;inset:${String(pad)}px;` +
        `width:${String(drawn)}px;height:${String(drawn)}px}</style>` +
        icon,
    );
    const png = await page.screenshot({ omitBackground: background === null });
    writeFileSync(join(publicDir, file), png);
    await page.close();
    console.log(`generate-favicons: wrote public/${file} (${String(size)}×${String(size)})`);
  }
} finally {
  await browser.close();
}
