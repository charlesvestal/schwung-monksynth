#!/usr/bin/env bash
#
# help.json MUST LOAD, FIT THE DISPLAY, AND SPEAK.
#
# Three ways to ship help nobody ever sees, all of them silent:
#
#  1. The loader's whole test is `if (helpData.children)`. A file naming its
#     topics anything else -- `sections`, `pages` -- is DISCARDED without a
#     word and the viewer says "No help content available", as though the file
#     were absent. A 2026-08 catalog sweep found 12 modules in that state. This
#     module shipped one too, copied from schwung's own reference fixture,
#     which had the same bug.
#
#  2. A help line is drawn, never wrapped and never truncated. Everything past
#     x=127 is dropped by set_pixel with no error anywhere, so an over-long
#     line loses its tail and nothing says so. The budget is PIXELS: the atlas
#     is proportional, so "." advances 3px and "W" 6px.
#
#  3. The bitmap font is ASCII plus a handful of accents. An em dash or a curly
#     quote renders as a 1px gap.
#
# Also checks the SPOKEN names, since `name` is what the screen reader reads
# and `short_name` is only the four-character cell label. An abbreviation in
# `name` is an abbreviation read aloud.
#
# Needs a schwung checkout for the real font; skipped without one.
set -euo pipefail
cd "$(dirname "$0")/.."
SCHWUNG="${SCHWUNG:-../schwung}"
if [ ! -f "$SCHWUNG/tools/param-pages/harness.mjs" ]; then
    echo "SKIP: no schwung checkout at $SCHWUNG (set SCHWUNG=<path>)"
    exit 0
fi

export SCHWUNG_HARNESS
SCHWUNG_HARNESS="$(cd "$SCHWUNG" && pwd)/tools/param-pages/harness.mjs"

node --input-type=module -e '
const fs = await import("node:fs");
const { createFramebuffer } = await import(process.env.SCHWUNG_HARNESS);

let fails = 0;
const fail = (m) => { console.error("FAIL: " + m); fails++; };
const fb = createFramebuffer(128, 64);
const BUDGET = 128 - 4;          /* drawScrollableText prints at x=4 */

const help = JSON.parse(fs.readFileSync("src/help.json", "utf8"));
if (!Array.isArray(help.children) || !help.children.length) {
  fail("help.json has no top-level children[] -- the loader discards it silently");
} else {
  let leaves = 0, lines = 0;
  (function rec(nodes, trail) {
    for (const n of nodes || []) {
      const where = trail ? `${trail} > ${n.title || "?"}` : (n.title || "?");
      if (Array.isArray(n.lines)) {
        leaves++;
        for (const ln of n.lines) {
          lines++;
          const s = String(ln);
          const w = fb.textWidth(s);
          if (w > BUDGET) fail(`${where}: ${w}px runs off the display: "${s}"`);
          for (const ch of s) if (ch.charCodeAt(0) > 126)
            fail(`${where}: no glyph for "${ch}"`);
        }
      }
      if (Array.isArray(n.children)) rec(n.children, where);
    }
  })(help.children, "");
  if (leaves === 0) fail("help.json has branches but no leaf topics with lines[]");
  console.log(`  ${leaves} topics, ${lines} lines, widest fits`);
}

/* ---- spoken names ---- */
const mod = JSON.parse(fs.readFileSync("src/module.json", "utf8"));
for (const p of mod.capabilities.chain_params) {
  const nm = String(p.name || "");
  if (!nm) { fail(`${p.key} has no name -- the screen reader would say the key`); continue; }
  /* A name is SPOKEN. Abbreviations belong in short_name. */
  if (/\b(Prs|Vib|Dly|Atk|Dec|Sus|Rel|Uni|Det|Spr|Lvl|Brth|Gld|Vow)\b/.test(nm))
    fail(`${p.key} name "${nm}" is abbreviated -- that is what gets read aloud`);
  if (nm.includes("&"))
    fail(`${p.key} name "${nm}" contains & -- a speech synth may say anything or nothing`);
}
for (const [k, lvl] of Object.entries(mod.ui_hierarchy.levels)) {
  const lb = String(lvl.label || "");
  if (lb.includes("&")) fail(`level ${k} label "${lb}" contains &`);
}

if (fails) { console.error(fails + " failure(s)"); process.exit(1); }
console.log("PASS: help loads, fits the display, stays in ASCII, and the names speak");
'
