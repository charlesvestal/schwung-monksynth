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
 *   node tools/preview_faces.mjs [--out faces.png]
 *       [--portraits-out portraits.png] [--pickers-out pickers.png]
 *       [--pages-out picker-pages.png]
 *       [--sweep-out picker-mouth-sweep.png]
 *       [--schwung ../schwung]
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
const portraitsArg = arg("--portraits-out", "");
const PORTRAITS_OUT = portraitsArg ? path.resolve(ROOT, portraitsArg) : null;
const pickersArg = arg("--pickers-out", "");
const PICKERS_OUT = pickersArg ? path.resolve(ROOT, pickersArg) : null;
const pagesArg = arg("--pages-out", "");
const PAGES_OUT = pagesArg ? path.resolve(ROOT, pagesArg) : null;
const sweepArg = arg("--sweep-out", "");
const SWEEP_OUT = sweepArg ? path.resolve(ROOT, sweepArg) : null;

const harnessPath = path.join(SCHWUNG, "tools", "param-pages", "harness.mjs");
if (!fs.existsSync(harnessPath)) {
    console.error(`no schwung harness at ${harnessPath}\n` +
                  `pass --schwung <path to a schwung checkout>`);
    process.exit(2);
}
const { createFramebuffer, drawContext } = await import(harnessPath);
const { frameCtx } = await import(path.join(
    SCHWUNG, "src", "shared", "param_pages", "frame_ctx.mjs"));
const { drawHeader, drawFooter } = await import(path.join(
    SCHWUNG, "src", "shared", "param_pages", "render_page_movy.mjs"));

/*
 * RENDER THROUGH THE HOST'S OWN REGISTRATION PATH, not by calling drawCell.
 *
 * Calling the overlay's drawCell directly is what let a real defect through
 * once already: this module declared two widget kinds while the host registered
 * only one, so on the device the Vowel cell drew a built-in dial -- and this
 * tool, which never registered anything, rendered it perfectly. A preview that
 * bypasses the wiring cannot see a wiring bug.
 *
 * So the widgets are registered exactly as shadow_ui does, and every cell is
 * drawn through the registry. A kind the overlay fails to declare now fails
 * here too, which is the whole point.
 */
const registryPath = path.join(SCHWUNG, "src", "shared", "param_pages", "widget_registry.mjs");
const registry = await import(registryPath);

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
 * This module declares TWO widget kinds, which needs a host that can register
 * more than one. Say so plainly: without this the failure is a bare
 * "registerOverlayWidgets is not a function" pointing at this file, which reads
 * as a bug here rather than as an out-of-date checkout.
 */
if (typeof registry.registerOverlayWidgets !== "function") {
    console.error(
        "This schwung checkout predates multi-widget registration.\n" +
        `  checkout: ${SCHWUNG}\n` +
        "MonkSynth declares two custom widget kinds (custom:monkface and\n" +
        "custom:monkmouth), and a host that reads a single widgetKind string\n" +
        "registers only the first -- the Vowel cell then silently draws a\n" +
        "built-in dial. Update schwung, or point --schwung at a checkout that\n" +
        "has widget_registry.registerOverlayWidgets.");
    process.exit(2);
}

registry.clearWidgets();
const reg = registry.registerOverlayWidgets(overlay);
if (reg.skipped.length) {
    console.error("FAIL: the host would refuse these declarations:");
    for (const s2 of reg.skipped) console.error(`  ${s2.kind}: ${s2.why}`);
    process.exit(1);
}
console.log(`registered: ${reg.registered.join(", ")}\n`);

/* Draw a cell the way the page does: look the kind up in the registry. */
function drawThroughRegistry(kind, ctx, payload) {
    const impl = registry.getWidget(kind);
    if (!impl) throw new Error(`kind ${kind} is not registered`);
    impl.draw(ctx, payload);
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
const portraitFrames = [];
const pickerFrames = [];
const pickerPageFrames = [];
const pickerSweepRows = [];
let clipped = 0, fullClipped = 0, missing = new Set();
const portraitCropFailures = [];
const portraitCueFailures = [];
const pickerFailures = [];
const fullSilhouette = new Set(["fish", "ghost", "pizza"]);

function countRect(fb, x, y, w, h) {
    let n = 0;
    for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
            if (fb.pixels[yy * fb.width + xx]) n++;
    return n;
}

function litBounds(fb, x, y, w, h) {
    let x0 = x + w, y0 = y + h, x1 = x - 1, y1 = y - 1;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (!fb.pixels[yy * fb.width + xx]) continue;
        x0 = Math.min(x0, xx); y0 = Math.min(y0, yy);
        x1 = Math.max(x1, xx); y1 = Math.max(y1, yy);
    }
    return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function regionSignature(fb, x, y, w, h) {
    let out = "";
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++)
        out += fb.pixels[yy * fb.width + xx] ? "1" : "0";
    return out;
}

function differingPixels(a, b) {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
    return n;
}

/* Count 8-connected islands inside a review region. This catches a helmet
 * crown that is geometrically one ellipse but rasterises as three loose pixel
 * clusters at the top of the 1-bit panel. */
function componentCountRect(fb, x, y, w, h) {
    const lit = new Set();
    for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
            if (fb.pixels[yy * fb.width + xx]) lit.add(`${xx},${yy}`);
    let components = 0;
    while (lit.size) {
        components++;
        const stack = [lit.values().next().value];
        lit.delete(stack[0]);
        while (stack.length) {
            const [px, py] = stack.pop().split(",").map(Number);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const key = `${px + dx},${py + dy}`;
                if (lit.delete(key)) stack.push(key);
            }
        }
    }
    return components;
}

for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const row = [];

    /*
     * A fullscreen PORTRAIT needs its own composition. Reusing cropFull made
     * most humanoid heads only 12-18 pixels high because an entire robe was
     * fitted into the 55px drawing band. Fish, Ghost and Pizza are the three
     * exceptions whose whole-body silhouette is their identity.
     */
    if (!Array.isArray(f.portrait) || f.portrait.length !== 4) {
        portraitCropFailures.push(`${f.id}: no four-value portrait crop`);
    } else if (!fullSilhouette.has(f.id) && f.portrait[3] - f.portrait[1] > 0.82) {
        portraitCropFailures.push(`${f.id}: portrait crop is too loose to read at panel size`);
    }

    /* No "Who" cell any more: a 17x15 head is an illegible blob, and it only
     * existed to carry `face` to the cell beside it, which extra_keys now does.
     * The whole face still appears -- on the card and full screen, below. */
    /* The Vowel cell, across the sweep. */
    for (const v of SWEEP) {
        const s = frameSurface(CELL_W, CELL_H);
        drawThroughRegistry("custom:monkmouth", s.ctx,
            { values: { face: f.id, vowel: v }, group: { keys: ["vowel"] }, nowMs: 0 });
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
        const s = frameSurface(CARD_W, CARD_H);
        card(s.ctx, { w: CARD_W, h: CARD_H, name: "Vowel", value: v.toFixed(2), raw: v,
                      values: { face: f.id, vowel: v }, nowMs: 0 });
        row.push(s.fb);
    }
    /* The fullscreen face. */
    {
        const s = canvasSurface(FULL_W, FULL_H);
        s.ctx.state = { faceId: f.id, vowel: 0.5, amp: 0.6, name: f.name, preset: i, count: faces.length };
        overlay.draw(s.ctx);
        row.push(s.fb);
        portraitFrames.push(s.fb);

        /* Signature features must be PIXEL CLUSTERS, not one-pixel contours.
         * These two side regions are where pigtails and drooping dog ears
         * live in the final 74x55 portrait frame. Sparse contours read as
         * mouse ears and long hair respectively on the physical display. */
        if (f.id === "girl" || f.id === "dog") {
            const left = countRect(s.fb, 17, 13, 13, 24);
            const right = countRect(s.fb, 44, 13, 13, 24);
            const need = f.id === "girl" ? 60 : 75;
            if (left < need || right < need)
                portraitCueFailures.push(`${f.id}: signature side clusters are too sparse (${left}/${right})`);
        }
        if (f.id === "firefighter") {
            /* Stop above the shield: only the dome crown belongs here. */
            const pieces = componentCountRect(s.fb, 28, 4, 19, 4);
            if (pieces !== 1)
                portraitCueFailures.push(`${f.id}: helmet crown breaks into ${pieces} pixel islands`);
        }
        if (f.id === "fish") {
            if (countRect(s.fb, 32, 0, 12, 7) !== 0)
                portraitCueFailures.push(`${f.id}: dorsal fin is too tall for the portrait grid`);
            const baseSeam = countRect(s.fb, 35, 18, 8, 1);
            /* Four pixels are the legitimate two side/body junctions; the
             * former closed baseline filled all eight pixels in this row. */
            if (baseSeam > 4)
                portraitCueFailures.push(`${f.id}: dorsal fin has a closed base seam (${baseSeam} pixels)`);
        }
        if (f.id === "unicorn") {
            const leftRoot = s.fb.pixels[19 * s.fb.width + 27];
            const rightRoot = s.fb.pixels[19 * s.fb.width + 47];
            if (!leftRoot || !rightRoot)
                portraitCueFailures.push(`${f.id}: ear roots are not joined to the head`);
        }
        if (f.id === "punk") {
            const crest = countRect(s.fb, 25, 0, 24, 17);
            if (crest > 60)
                portraitCueFailures.push(`${f.id}: mohawk is too wide (${crest} upper pixels)`);
        }
        if (f.id === "pizza") {
            /* The two lower rings deliberately cross the slice boundary. They
             * must be clipped to partial toppings, not rendered as complete
             * circles dangling beside the outline. */
            const lowerLeft = countRect(s.fb, 24, 35, 7, 7);
            const lowerRight = countRect(s.fb, 45, 37, 7, 7);
            /* A clipped half-ring plus the redrawn one-pixel slice edge uses
             * at most 15 pixels here; the old complete rings used 22/16. */
            if (lowerLeft > 15 || lowerRight > 15)
                portraitCueFailures.push(`${f.id}: lower pepperoni are not edge-clipped (${lowerLeft}/${lowerRight})`);
        }
    }

    /* The exact frame Schwung gives drawPage inside the preset picker. This
     * path is intentionally separate from the 128x64 fullscreen portrait. */
    {
        const s = frameSurface(120, 45);
        let pickerProbe = null;
        const realHead = f.head;
        f.head = (u, d) => {
            pickerProbe = {
                scale: u.s, detail: d, x0: u.x(0), y0: u.y(0),
                xUnit: u.x(1) - u.x(0),
            };
            realHead(u, d);
        };
        overlay.drawPage(s.ctx, {
            values: { face: f.id, vowel: 0.5 },
            nowMs: 0,
            /* The live framebuffer captured a one-glyph non-name here. The
             * character table is authoritative once the index has resolved. */
            preset: { name: "Ä", index: i, count: faces.length, entered: true },
        });
        f.head = realHead;
        pickerFrames.push(s.fb);

        /* Compare the entire reserved strip with a clean font render. Merely
         * counting pixels let a portrait overdraw masquerade as a label. */
        const expectedName = frameSurface(120, 45);
        expectedName.ctx.print(0, 37, f.name, 1);
        for (let y = 37; y < 45; y++) for (let x = 0; x < 120; x++) {
            const p = y * 120 + x;
            if (s.fb.pixels[p] !== expectedName.fb.pixels[p]) {
                pickerFailures.push(`${f.id}: preset name row is incomplete or overdrawn`);
                y = 45;
                break;
            }
        }

        /* The picker uses each character's tight crop so it fills the small
         * frame, but retains panel detail so the corrected construction and
         * foreground/background ordering do not regress to the old card art. */
        if (!Array.isArray(f.picker) || f.picker.length !== 4)
            pickerFailures.push(`${f.id}: no four-value picker crop`);
        const pc = f.picker || f.crop;
        const readingW = Math.max(s.ctx.textWidth("AH"), s.ctx.textWidth(`${i + 1}/12`));
        const pickerFaceW = Math.max(16, 120 - readingW - 6);
        const pickerXScale = f.pickerXScale || 1;
        const pickerScale = Math.min(
            pickerFaceW / ((pc[2] - pc[0]) * pickerXScale),
            36 / (pc[3] - pc[1]));
        if (!pickerProbe || pickerProbe.detail !== 2)
            pickerFailures.push(`${f.id}: preset picker dropped portrait details`);
        if (!pickerProbe || Math.abs(pickerProbe.scale - pickerScale) > 0.01)
            pickerFailures.push(`${f.id}: preset picker is not scaled to its tight crop`);

        /* Both vertical sides of the old crop need breathing room. This is
         * the regression for crowns and chins being cut exactly at its edge;
         * outer garment strokes may still leave the close-up intentionally. */
        if (pc[1] >= f.crop[1] || pc[3] <= f.crop[3])
            pickerFailures.push(`${f.id}: picker crop has no crown/chin padding`);

        /* The live Officer page showed its mouth joined to the jaw, which
         * reads as a severed chin. Fish has the same geometry inside its lip
         * ring. Require at least one dark pixel between aperture and outline. */
        const chin = {
            fish: [0.80, 0.56, 0.645],
            firefighter: [0.50, 0.44, 0.505],
        }[f.id];
        if (chin && pickerProbe) {
            const x = Math.round(pickerProbe.x0 + chin[0] * pickerProbe.scale);
            const y0 = Math.round(pickerProbe.y0 + chin[1] * pickerProbe.scale) + 1;
            const y1 = Math.round(pickerProbe.y0 + chin[2] * pickerProbe.scale) - 1;
            let gap = false;
            for (let y = y0; y <= y1; y++)
                if (!s.fb.pixels[y * s.fb.width + x]) { gap = true; break; }
            if (!gap) pickerFailures.push(`${f.id}: mouth aperture merges into the chin outline`);
        }

        /* Render the WHOLE hardware page, not just the body tile: the real
         * header and footer fonts plus the real frame offset expose collisions
         * that disappear in a contact sheet of isolated 120x45 rectangles. */
        const page = frameSurface(128, 64);
        drawHeader(page.ctx, "S2 >* ROUND BASS", "FACE");
        overlay.drawPage(frameCtx(page.ctx, { x: 4, y: 9, w: 120, h: 45 }), {
            values: { face: f.id, vowel: 0.5 }, nowMs: 0,
            preset: { name: "Ä", index: i, count: faces.length, entered: true },
        });
        drawFooter(page.ctx, [["JOG", "PRST"], ["CLK", "EDIT"], ["BACK", "OUT"]]);
        pickerPageFrames.push(page.fb);
        const pageClipped = typeof page.fb.clipped === "function"
            ? page.fb.clipped() : (page.fb.clipped || 0);
        if (pageClipped)
            pickerFailures.push(`${f.id}: ${pageClipped} pixels clipped on the complete picker page`);

        /* Five complete pages make the animation reviewable as pixels rather
         * than as anchor numbers. Everything except the aperture is held
         * constant, so differences inside the face region are mouth motion. */
        const sweepPages = [];
        const sweepFaces = [];
        let invisibleMouths = 0;
        for (let sweepIndex = 0; sweepIndex < SWEEP.length; sweepIndex++) {
            const vowel = SWEEP[sweepIndex];
            const body = frameSurface(120, 45);
            overlay.drawPage(body.ctx, {
                values: { face: f.id, vowel }, nowMs: 0,
                preset: { name: "Ä", index: i, count: faces.length, entered: true },
            });
            sweepFaces.push(regionSignature(body.fb, 0, 0, pickerFaceW, 36));
            if (pickerProbe) {
                const mx = Math.round(pickerProbe.x0 + f.mc[0] * pickerProbe.xUnit);
                const my = Math.round(pickerProbe.y0 + f.mc[1] * pickerProbe.scale);
                if (countRect(body.fb, mx - 1, my - 1, 3, 3) === 0) invisibleMouths++;
            }

            const full = frameSurface(128, 64);
            drawHeader(full.ctx, "S2 >* ROUND BASS", "FACE");
            overlay.drawPage(frameCtx(full.ctx, { x: 4, y: 9, w: 120, h: 45 }), {
                values: { face: f.id, vowel }, nowMs: 0,
                preset: { name: "Ä", index: i, count: faces.length, entered: true },
            });
            drawFooter(full.ctx, [["JOG", "PRST"], ["CLK", "EDIT"], ["BACK", "OUT"]]);
            sweepPages.push(full.fb);

            /* Isolate the aperture through the real picker path. Device-size
             * bounds enforce visibility; enlarged renders compare aspect ratio
             * without one-pixel rounding disguising the underlying shape. */
            const savedHead = f.head, savedEyes = f.eyes;
            f.head = () => {};
            f.eyes = () => {};
            const isolated = frameSurface(120, 45);
            overlay.drawPage(isolated.ctx, {
                values: { face: f.id, vowel }, nowMs: 0,
                preset: { name: f.name, index: i, count: faces.length, entered: true },
            });
            const pickerMouth = litBounds(isolated.fb, 0, 0, pickerFaceW, 36);

            const largeCell = frameSurface(CELL_W * 10, CELL_H * 10);
            drawThroughRegistry("custom:monkmouth", largeCell.ctx,
                { values: { face: f.id, vowel }, group: { keys: ["vowel"] }, nowMs: 0 });
            const largeWidgetMouth = litBounds(largeCell.fb, 0, 0, largeCell.fb.width, largeCell.fb.height);
            const largePicker = frameSurface(1200, 450);
            overlay.drawPage(largePicker.ctx, {
                values: { face: f.id, vowel }, nowMs: 0,
                preset: { name: f.name, index: i, count: faces.length, entered: true },
            });
            const largeFaceW = 1200 - Math.max(largePicker.ctx.textWidth("AH"), largePicker.ctx.textWidth(`${i + 1}/12`)) - 6;
            const largePortraitMouth = litBounds(largePicker.fb, 0, 0, largeFaceW, 441);
            f.head = savedHead;
            f.eyes = savedEyes;
            if (largeWidgetMouth && largePortraitMouth) {
                const widgetAspect = largeWidgetMouth.w / largeWidgetMouth.h;
                const portraitAspect = largePortraitMouth.w / largePortraitMouth.h;
                if (Math.abs(Math.log(widgetAspect / portraitAspect)) > 0.12)
                    pickerFailures.push(`${f.id}: ${vowel.toFixed(2)} mouth shape differs between Vowel widget (${largeWidgetMouth.w}x${largeWidgetMouth.h}) and portrait (${largePortraitMouth.w}x${largePortraitMouth.h})`);
            } else {
                pickerFailures.push(`${f.id}: ${vowel.toFixed(2)} mouth missing from widget/portrait comparison`);
            }
            if ((f.id === "fish" || f.id === "cat") &&
                (!pickerMouth || pickerMouth.w < 4 || pickerMouth.h < 2 || pickerMouth.w * pickerMouth.h < 12))
                pickerFailures.push(`${f.id}: ${vowel.toFixed(2)} portrait mouth is too hard to see (${pickerMouth ? `${pickerMouth.w}x${pickerMouth.h}` : "none"})`);
        }
        pickerSweepRows.push(sweepPages);

        const uniqueMouthFrames = new Set(sweepFaces).size;
        const endMotion = differingPixels(sweepFaces[0], sweepFaces[sweepFaces.length - 1]);
        if (invisibleMouths)
            pickerFailures.push(`${f.id}: mouth is invisible at ${invisibleMouths} vowel anchors`);
        if (uniqueMouthFrames < 3 || endMotion < 4)
            pickerFailures.push(`${f.id}: mouth movement does not read (${uniqueMouthFrames} shapes, ${endMotion} changed pixels)`);

        const faceBounds = litBounds(s.fb, 0, 0, pickerFaceW, 36);
        if (!faceBounds || faceBounds.w < 24 || faceBounds.h < 18)
            pickerFailures.push(`${f.id}: picker head/silhouette is too small (${faceBounds ? `${faceBounds.w}x${faceBounds.h}` : "blank"})`);
        if (f.id === "fish" && faceBounds && faceBounds.w < 45)
            pickerFailures.push(`${f.id}: horizontal silhouette is only ${faceBounds.w}px wide (need 45)`);
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
const MIN_LIT = [4, 4, 4, 4, 4, 40, 40, 60];  /* per column, in row order */
const failures = [];
failures.push(...portraitCropFailures);
failures.push(...portraitCueFailures);
failures.push(...pickerFailures);
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
if (PORTRAITS_OUT) {
    const portraitRows = [];
    for (let i = 0; i < portraitFrames.length; i += 3)
        portraitRows.push(portraitFrames.slice(i, i + 3));
    fs.mkdirSync(path.dirname(PORTRAITS_OUT), { recursive: true });
    fs.writeFileSync(PORTRAITS_OUT, sheet(portraitRows, 4).toPng(3));
}
if (PICKERS_OUT) {
    const pickerRows = [];
    for (let i = 0; i < pickerFrames.length; i += 3)
        pickerRows.push(pickerFrames.slice(i, i + 3));
    fs.mkdirSync(path.dirname(PICKERS_OUT), { recursive: true });
    fs.writeFileSync(PICKERS_OUT, sheet(pickerRows, 4).toPng(3));
}
if (PAGES_OUT) {
    const pageRows = [];
    for (let i = 0; i < pickerPageFrames.length; i += 3)
        pageRows.push(pickerPageFrames.slice(i, i + 3));
    fs.mkdirSync(path.dirname(PAGES_OUT), { recursive: true });
    fs.writeFileSync(PAGES_OUT, sheet(pageRows, 4).toPng(3));
}
if (SWEEP_OUT) {
    fs.mkdirSync(path.dirname(SWEEP_OUT), { recursive: true });
    fs.writeFileSync(SWEEP_OUT, sheet(pickerSweepRows, 4).toPng(2));
}
console.log(`\n${faces.length} faces -> ${OUT}`);
if (PORTRAITS_OUT) console.log(`portrait review sheet -> ${PORTRAITS_OUT}`);
if (PICKERS_OUT) console.log(`preset-picker review sheet -> ${PICKERS_OUT}`);
if (PAGES_OUT) console.log(`full preset-page review sheet -> ${PAGES_OUT}`);
if (SWEEP_OUT) console.log(`full-page mouth sweep -> ${SWEEP_OUT}`);
console.log(`clipped pixels: ${clipped} total (cells crop on purpose)`);
console.log(`clipped on the PANEL: ${fullClipped}${fullClipped ? "   <-- art is running off the display" : ""}`);
if (missing.size) console.log(`MISSING GLYPHS: ${[...missing].join(" ")}`);

if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  " + f);
    process.exit(1);
}
console.log("all surfaces drew, nothing ran off the panel, every glyph exists");
