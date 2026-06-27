/**
 * Render every docs/img/*.svg to a PNG in docs/img/.rendered/ for visual review.
 * Diagrams were being authored blind and shipped with defects (e.g. a highlight
 * with no base coordinate floated over the title); always eyeball the PNGs before
 * committing an SVG. The .rendered/ output is gitignored — it's a review artifact.
 *
 *   npm run render-docs
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/img";
const OUT = join(DIR, ".rendered");
mkdirSync(OUT, { recursive: true });

const svgs = readdirSync(DIR).filter((f) => f.endsWith(".svg"));
for (const f of svgs) {
  const svg = readFileSync(join(DIR, f), "utf8");
  const png = new Resvg(svg, { background: "#0e1116" }).render().asPng();
  writeFileSync(join(OUT, f.replace(/\.svg$/, ".png")), png);
  console.log("rendered", f);
}
console.log(`\n${svgs.length} SVG(s) -> ${OUT}/  (open these and eyeball before committing)`);
