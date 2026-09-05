#!/usr/bin/env node
/**
 * preview_mouth_sweep.mjs — every character, every vowel, at page size.
 *
 * The portrait sheet answers "is this a cat". This answers the harder question:
 * does the MOUTH move legibly across the whole sweep without colliding with the
 * muzzle, beard, hem or nose it sits inside?
 *
 * Three real defects were visible only here, because each face was perfectly
 * fine at a single vowel: the ghost cropped above its own hem (a row of loose
 * dots where the scallops should be), the dog's aperture swelling to fill its
 * whole snout at EE, and the cat's nose, mouth and muzzle landing inside about
 * four pixels.
 *
 *   node tools/preview_mouth_sweep.mjs [--schwung ../schwung]
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
const harness = path.join(SCHWUNG, "tools", "param-pages", "harness.mjs");
if (!fs.existsSync(harness)) {
    console.error(`no schwung harness at ${harness}\npass --schwung <path>`);
    process.exit(2);
}
const { createFramebuffer, drawContext } = await import(harness);

const g = {};
new Function("globalThis", fs.readFileSync(path.join(ROOT, "src/ui/canvas.js"), "utf8"))(g);
const faces = g.MONK_FACES_FOR_TEST;

/* The face half of the page band, which is where these have to work. */
const W = 60, H = 37, GAP = 2;
const SWEEP = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const LABEL_W = 60;

const sheet = createFramebuffer(SWEEP.length * (W + GAP) - GAP + LABEL_W,
                                faces.length * (H + GAP) - GAP);

for (let i = 0; i < faces.length; i++) {
    for (let j = 0; j < SWEEP.length; j++) {
        const fb = createFramebuffer(W, H);
        const d = drawContext(fb);
        /* Wider than the frame so the readings fall outside it: this sheet is
         * about the face, not the layout. */
        g.canvas_overlay.drawPage(
            { width: W + 40, height: H, fillRect: fb.fillRect, print: fb.print,
              textWidth: fb.textWidth, line: d.line, drawCircle: d.drawCircle,
              fillCircle: d.fillCircle, drawArc: d.drawArc },
            { values: { face: faces[i].id, vowel: String(SWEEP[j]) },
              nowMs: 0, preset: null, width: W + 40, height: H });
        const ox = j * (W + GAP), oy = i * (H + GAP);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
            if (fb.pixels[y * W + x]) sheet.setPixel(ox + x, oy + y, 1);
    }
    const lbl = createFramebuffer(LABEL_W - 2, 9);
    lbl.print(0, 1, faces[i].name, 1);
    for (let y = 0; y < 9; y++) for (let x = 0; x < LABEL_W - 2; x++)
        if (lbl.pixels[y * (LABEL_W - 2) + x])
            sheet.setPixel(SWEEP.length * (W + GAP) + x, i * (H + GAP) + 14 + y, 1);
}

const out = path.join(ROOT, "faces-out", "mouth-sweep.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet.toPng(3));
console.log(`${faces.length} characters x ${SWEEP.length} vowels -> ${out}`);
