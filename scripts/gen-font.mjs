// Builds media/offshoot.woff — a one-glyph icon font holding the Offshoot mark,
// so it can be contributed via package.json `contributes.icons` and used as
// `$(offshoot)` in places that take a ThemeIcon (e.g. the status bar).
import fs from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SVGIcons2SVGFontStream } from "svgicons2svgfont";
import svg2ttf from "svg2ttf";
import ttf2woff from "ttf2woff";

const here = dirname(fileURLToPath(import.meta.url));
const media = join(here, "..", "media");
const glyphPath = join(media, "offshoot-glyph.svg");
const CODEPOINT = 0xea01; // private use area

const svgFont = await new Promise((resolve, reject) => {
  const chunks = [];
  const fontStream = new SVGIcons2SVGFontStream({
    fontName: "offshoot",
    normalize: true,
    fontHeight: 1000,
    log: () => {}
  });
  fontStream.on("data", (c) => chunks.push(c));
  fontStream.on("end", () => resolve(chunks.join("")));
  fontStream.on("error", reject);

  const glyph = fs.createReadStream(glyphPath);
  glyph.metadata = { unicode: [String.fromCharCode(CODEPOINT)], name: "offshoot" };
  fontStream.write(glyph);
  fontStream.end();
});

const ttf = svg2ttf(svgFont, {});
const woff = ttf2woff(Buffer.from(ttf.buffer));
fs.writeFileSync(join(media, "offshoot.woff"), Buffer.from(woff.buffer));
console.log(
  `wrote media/offshoot.woff (glyph at \\u${CODEPOINT.toString(16).toUpperCase()})`
);

// Silence unused import in case the stream import shape changes across versions.
void Readable;
