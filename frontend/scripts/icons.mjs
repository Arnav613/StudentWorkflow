/*
 * Home-screen icons, generated from the same mark as the favicon.
 *
 * Run with `npm run icons`. The PNGs are committed, so this is not part of
 * the build: a phone icon that changes only when someone deliberately
 * regenerates it is one less thing a deploy can get wrong, and Vercel does
 * not have to install sharp to ship a page.
 *
 * Two shapes, because Android and iOS want different things:
 *
 *   `icon-*.png` is the mark as drawn — rounded corners included — for
 *   contexts that composite it as-is (the manifest's `any` purpose, the
 *   install prompt, the task switcher).
 *
 *   `maskable-*.png` is full-bleed: the background runs edge to edge and the
 *   glyph sits inside the 80% safe zone the maskable spec guarantees. Android
 *   crops icons to whatever shape the launcher uses, and a rounded square fed
 *   through a circular mask loses its corners and gains a halo. Passing the
 *   same file for both purposes is the single most common way a PWA icon ends
 *   up looking wrong on exactly one person's phone.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "public");

const BG = "#18181B";

// The glyph alone, on a transparent 32-unit square — the favicon minus its
// background plate, so each shape below can supply its own.
const glyph = `
  <rect x="9" y="6.5" width="14" height="3" rx="1.5" fill="#fff" opacity="0.35"/>
  <rect x="7" y="12" width="18" height="3" rx="1.5" fill="#fff" opacity="0.6"/>
  <path d="M10 21.5l3.6 3.6L23 16" stroke="#fff" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** The mark as drawn: rounded plate, glyph at full size. */
const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${BG}"/>${glyph}
</svg>`;

/*
 * Full bleed, glyph scaled to 78% and re-centred. 78 rather than the spec's
 * 80 because the tick's stroke is rounded and its cap overshoots the path's
 * bounding box by half a stroke width — measured at the drawn edge, 80 puts
 * it just outside the safe circle.
 */
const S = 0.78;
const offset = (32 - 32 * S) / 2;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BG}"/>
  <g transform="translate(${offset} ${offset}) scale(${S})">${glyph}</g>
</svg>`;


/*
 * Android's status-bar badge. Monochrome by contract: the platform throws
 * away every colour in this file and keeps the alpha channel, so it is drawn
 * as a solid white glyph on transparency. Feeding it the full-colour mark
 * yields a filled grey blob, which is the usual reason a badge looks broken.
 *
 * Just the tick — the two bars are illegible at 72px once flattened.
 */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M6 17l6.5 6.5L26 10" stroke="#fff" stroke-width="4"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

/*
 * iOS ignores the manifest's icons for the home screen and reads
 * `apple-touch-icon` instead — and it ignores transparency and corner radii
 * too, compositing the image onto a white plate and applying its own
 * squircle. So this one is the plain mark at 180px, the size iOS asks for.
 */
const sizes = { icon: [192, 512], maskable: [192, 512] };

mkdirSync(out, { recursive: true });

const render = (svg, file, size) =>
  sharp(Buffer.from(svg))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(out, file));

const jobs = [
  ...sizes.icon.map((s) => render(plain, `icons/icon-${s}.png`, s)),
  ...sizes.maskable.map((s) => render(maskable, `icons/maskable-${s}.png`, s)),
  render(badge, "icons/badge-72.png", 72),
  // Overwrites the existing file with the same mark at the size iOS wants.
  render(plain, "apple-touch-icon.png", 180),
];

mkdirSync(resolve(out, "icons"), { recursive: true });
await Promise.all(jobs);
console.log("wrote", jobs.length, "icons to public/");
