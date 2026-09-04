#!/usr/bin/env node
/**
 * preview_faces.mjs — render all twelve characters, at all four surfaces, to a
 * PNG contact sheet.
 *
 * WHY THIS EXISTS. The faces are 1-bit art re-authored from colour bezier
 * drawings, and whether a re-authored silhouette actually READS at 17x15 is not
 * a thing source review can answer. Reviewing this on hardware would mean
 * twelve characters x four surfaces of jog-stepping per iteration. So the
 * device's own framebuffer is modelled here and the whole set is rendered flat.
 *
 * Borrows schwung's harness (the real 1-bit framebuffer, the real 5x7 font and
 * the real native drawing verbs) rather than reimplementing them, so what comes
 * out is what the panel would show.
 *
 *   node tools/preview_faces.mjs [--out faces.png] [--schwung ../schwung]
 *
 * Node-only, dev-only. Nothing here ships.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function arg(name, dflt) {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const SCHWUNG = path.resolve(ROOT, arg("--schwung", "../schwung"));
const OUT = path.resolve(ROOT, arg("--out", "faces-out/faces.png"));

const harnessPath = path.join(SCHWUNG, "tools", "param-pages", "harness.mjs");
if (!fs.existsSync(harnessPath)) {
    console.error(`no schwung harness at ${harnessPath}\n` +
                  `pass --schwung <path to a schwung checkout>`);
    process.exit(2);
}
const { createFramebuffer, drawContext } = await import(harnessPath);

/* ---- load canvas.js the way the device does: as a script over globalThis ---- */

const src = fs.readFileSync(path.join(ROOT, "src", "ui", "canvas.js"), "utf8");
const sandbox = {};
const load = new Function("globalThis", src +
    "\n;return { overlay: globalThis.canvas_overlay," +
    "           card: globalThis.vowel_card," +
    "           faces: globalThis.MONK_FACES_FOR_TEST };");
const { overlay, card, faces } = load(sandbox);

if (!overlay || !card || !faces) {
    console.error("canvas.js did not expose canvas_overlay / vowel_card / faces");
    process.exit(1);
}

/*
 * EACH SURFACE GETS THE PRIMITIVES IT REALLY HAS, and that is the point.
 *
 * A widget/card frameCtx and the fullscreen canvas ctx carry DIFFERENT verb
 * sets on the device — the canvas has no `line`, no circle and no textWidth.
 * Handing both the same rich context here would test a context that does not
 * exist and hide whether canvas.js's own fallbacks work. So the canvas surface
 * is deliberately given the leaner set.
 *
 * Note also that harness.drawContext does NOT carry width/height (they live on
 * the framebuffer), while the device's frameCtx does. Supplying them is what
 * this wrapper is mostly for: without them every coordinate is NaN, which shows
 * up as a hang rather than an error.
 */
function frameSurface(w, h) {
    const fb = createFramebuffer(w, h);
    const ctx = drawContext(fb);
    return { fb, ctx: { ...ctx, width: w, height: h, setPixel: fb.setPixel } };
}

function canvasSurface(w, h) {
    const fb = createFramebuffer(w, h);
    return {
        fb,
        ctx: {
            width: w, height: h,
            fillRect: fb.fillRect,
            print: fb.print,
            setPixel: fb.setPixel,
            drawRect: (x, y, rw, rh, c) => {
                fb.fillRect(x, y, rw, 1, c); fb.fillRect(x, y + rh - 1, rw, 1, c);
                fb.fillRect(x, y, 1, rh, c); fb.fillRect(x + rw - 1, y, 1, rh, c);
            },
            clear: () => fb.clearScreen(),
            now: () => 0,
            random: () => 0.5,
            state: {},
        },
    };
}

/* Compose framebuffers into a grid sheet with 1px separators. */
function sheet(rows, gap = 3) {
    const w = Math.max(...rows.map((r) => r.reduce((a, f) => a + f.width + gap, 0) - gap));
    const h = rows.reduce((a, r) => a + Math.max(...r.map((f) => f.height)) + gap, 0) - gap;
    const out = createFramebuffer(w, h);
    let y = 0;
    for (const r of rows) {
        let x = 0;
        for (const f of r) {
            for (let yy = 0; yy < f.height; yy++)
                for (let xx = 0; xx < f.width; xx++)
                    if (f.pixels[yy * f.width + xx]) out.setPixel(x + xx, y + yy, 1);
            x += f.width + gap;
        }
        y += Math.max(...r.map((f) => f.height)) + gap;
    }
    return out;
}

const CELL_W = 17, CELL_H = 15;
const CARD_W = 104, CARD_H = 46;
const FULL_W = 128, FULL_H = 64;

/* The vowel sweep sampled at the five anchors, so the sheet shows the morph. */
const SWEEP = [0.0, 0.25, 0.5, 0.75, 1.0];

const rows = [];
let clipped = 0, fullClipped = 0, missing = new Set();

for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const row = [];

    /* The Who cell. */
    {
        const s = frameSurface(CELL_W, CELL_H);
        overlay.drawCell(s.ctx, { values: { face: f.id }, group: { keys: ["face"] }, nowMs: 0 });
        row.push(s.fb);
    }
    /* The Vowel cell, across the sweep. */
    for (const v of SWEEP) {
        const s = frameSurface(CELL_W, CELL_H);
        overlay.drawCell(s.ctx, { values: { face: f.id, vowel: v }, group: { keys: ["vowel"] }, nowMs: 0 });
        row.push(s.fb);
    }
    /*
     * The card, at two vowels.
     *
     * Faithful to the device in one way that matters: the card is given ONLY
     * { w, h, name, value, raw } — no face — so it can only work if drawCell
     * stamped the character first. That stamp is done here by drawing a face
     * cell immediately before, which is exactly the order the page uses.
     */
    for (const v of [0.0, 1.0]) {
        const stamp = frameSurface(CELL_W, CELL_H);
        overlay.drawCell(stamp.ctx, { values: { face: f.id }, group: { keys: ["face"] }, nowMs: 0 });
        const s = frameSurface(CARD_W, CARD_H);
        card(s.ctx, { w: CARD_W, h: CARD_H, name: "Vowel", value: v.toFixed(2), raw: v });
        row.push(s.fb);
    }
    /* The fullscreen face. */
    {
        const s = canvasSurface(FULL_W, FULL_H);
        s.ctx.state = { faceId: f.id, vowel: 0.5, amp: 0.6, name: f.name, preset: i, count: faces.length };
        overlay.draw(s.ctx);
        row.push(s.fb);
    }

    /*
     * CLIPPING IS EXPECTED IN A CELL AND A DEFECT ON THE PANEL.
     *
     * A knob cell deliberately crops into the middle of a face, so its clip
     * count is meaningless. The fullscreen face is supposed to fit inside the
     * frame it was given, so ANY clipping there is art running off the display
     * — which the harness comment calls out as the only way to catch it. They
     * are counted separately for that reason; one pooled number hid it.
     */
    for (const fb of row) {
        clipped += (typeof fb.clipped === "function" ? fb.clipped() : (fb.clipped || 0));
        for (const g of (typeof fb.missingGlyphs === "function" ? fb.missingGlyphs() : (fb.missingGlyphs || []))) missing.add(g);
    }
    const lastFb = row[row.length - 1];
    fullClipped += (typeof lastFb.clipped === "function" ? lastFb.clipped() : (lastFb.clipped || 0));
    rows.push(row);
    console.log(`${String(i).padStart(2)}  ${f.id.padEnd(12)} ${f.name}`);
}

/*
 * THE ASSERTIONS. --check makes this a test rather than a viewer.
 *
 * "It rendered" is not the bar; a face that draws four pixels also rendered.
 * Each surface has to put enough on the screen to BE a face, the panel must
 * not clip (a cell clips by design, the panel clipping means art is running
 * off the display), and every glyph must exist in the device atlas.
 */
const MIN_LIT = [8, 4, 4, 4, 4, 4, 40, 40, 60];  /* per column, in row order */
const failures = [];
for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
        const lit = rows[r][c].countLit();
        const need = MIN_LIT[c] === undefined ? 4 : MIN_LIT[c];
        if (lit < need) failures.push(`${faces[r].id} surface ${c}: only ${lit} lit pixels (need ${need})`);
    }
}
if (fullClipped) failures.push(`${fullClipped} pixels clipped on the PANEL - art is running off the display`);
if (missing.size) failures.push(`glyphs missing from the device font: ${[...missing].join(" ")}`);

const out = sheet(rows);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.toPng(3));
console.log(`\n${faces.length} faces -> ${OUT}`);
console.log(`clipped pixels: ${clipped} total (cells crop on purpose)`);
console.log(`clipped on the PANEL: ${fullClipped}${fullClipped ? "   <-- art is running off the display" : ""}`);
if (missing.size) console.log(`MISSING GLYPHS: ${[...missing].join(" ")}`);

if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  " + f);
    process.exit(1);
}
console.log("all surfaces drew, nothing ran off the panel, every glyph exists");
