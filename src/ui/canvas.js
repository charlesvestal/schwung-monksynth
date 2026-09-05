/*
 * MonkSynth — all three module-supplied draw surfaces, and the twelve faces
 * they share.
 *
 *   drawCell  "custom:monkmouth" that character's mouth, in the Vowel cell
 *   vowel_card                    the face + vowel name, floating on a turn
 *   draw                          the fullscreen face, and the character picker
 *
 * ONE FILE ON PURPOSE. `card_script` and `canvas_script` are both resolved by
 * loading a path and picking a name off globalThis, so `canvas.js#vowel_card`
 * and `canvas.js` reach the same file — and they must, because all four
 * surfaces draw the same twelve faces. Splitting them would mean two copies of
 * FACES, which is the one thing worth avoiding here. (The usual advice to keep
 * a card file small applies when the card would drag an unrelated editor in
 * with it; here the shared table IS what the card needs.)
 *
 * ------------------------------------------------------------------------
 * WHAT THE ART IS, AND WHAT IT IS NOT
 *
 * The iOS characters are full-colour UIBezierPath drawings with clip masks,
 * alpha and HSB-derived tones. None of that survives a 128x64 1-bit panel, so
 * the SILHOUETTES here are re-authored rather than translated.
 *
 * What IS ported verbatim is the RIG — every number below (mouth anchors,
 * mouthCentre, mouthBoxFraction, eye positions, head centre and radius, prop
 * geometry) is lifted from the matching AU/UI/*Character.swift, because that
 * art is already authored in a unit square and a unit square is exactly what
 * this contract wants. So the mouths move the way MonkSynth's mouths move,
 * which is the part a player would notice.
 *
 * THE FRAME IS NOT THE SCREEN. (0,0) is the top-left of whatever box we were
 * handed and ctx.width/ctx.height are its size — a 17x15 knob cell, a 104x46
 * card, or the whole panel. Nothing here may name an absolute coordinate.
 * Everything goes through `unit()` below.
 *
 * NO READS. There is no getParam on drawCell, draw or tick. Values arrive as
 * arguments, or are cached by onOpen/onMidi, which are events rather than
 * frames.
 */

/* ------------------------------------------------------------------ helpers */

/*
 * A unit-square mapper over a sub-rectangle of the frame.
 *
 * `crop` is the region of the character's own unit square we want to see,
 * as [x0, y0, x1, y1]. The cell surfaces crop to the head; the big surfaces
 * show more of the body. The crop is fitted into the frame WITHOUT stretching
 * — a squashed face reads as a different character — so the shorter axis wins
 * and the result is centred.
 */
/*
 * ONE DRAWING VOCABULARY OVER TWO DIFFERENT CONTEXTS.
 *
 * A widget/card frameCtx carries fillRect, print, textWidth, setPixel, line,
 * fillCircle, drawCircle and drawArc. The fullscreen canvas ctx carries a
 * DIFFERENT set: fillRect, print, setPixel, drawRect, `drawLine` (not `line`),
 * now() and random() — and no circle of any kind, no textWidth.
 *
 * The faces have to draw identically on both, so everything is normalized onto
 * fillRect here, which both do have. That is also how frameCtx implements its
 * own circle, so a shape drawn through this shim is pixel-consistent with a
 * built-in one rather than merely similar.
 */
function norm(ctx) {
    const fill = (x, y, w, h, c) => ctx.fillRect(x, y, w, h, c);
    return {
        width: ctx.width,
        height: ctx.height,
        fillRect: fill,
        print: (x, y, t, c) => ctx.print(x, y, t, c),
        /* No textWidth on the canvas ctx. 6px/char matches the default font's
         * advance, and it is only ever used to CENTRE a label — being a pixel
         * out is invisible, and guessing is better than not centring at all. */
        textWidth: (t) => (typeof ctx.textWidth === "function"
            ? ctx.textWidth(t) : String(t).length * 6),
        line(x0, y0, x1, y1, c) {
            if (typeof ctx.line === "function") { ctx.line(x0, y0, x1, y1, c); return; }
            /* Bresenham, because drawLine is optional on the canvas ctx too
             * (it is gated on `display` existing) and a missing line would
             * silently erase every curve in every face. */
            let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
            let err = dx - dy, x = x0, y = y0;
            for (;;) {
                fill(x, y, 1, 1, c);
                if (x === x1 && y === y1) break;
                const e2 = 2 * err;
                if (e2 > -dy) { err -= dy; x += sx; }
                if (e2 < dx) { err += dx; y += sy; }
            }
        },
        drawCircle(cx, cy, r, c) {
            if (typeof ctx.drawCircle === "function") { ctx.drawCircle(cx, cy, r, c); return; }
            if (r < 1) { fill(cx, cy, 1, 1, c); return; }
            let x = r, y = 0, err = 1 - r;
            while (x >= y) {
                for (const p of [[x,y],[y,x],[-x,y],[-y,x],[x,-y],[y,-x],[-x,-y],[-y,-x]])
                    fill(cx + p[0], cy + p[1], 1, 1, c);
                y++;
                if (err < 0) err += 2 * y + 1;
                else { x--; err += 2 * (y - x) + 1; }
            }
        },
    };
}

function unit(rawCtx, crop) {
    const ctx = norm(rawCtx);
    const cw = crop[2] - crop[0], ch = crop[3] - crop[1];
    const s = Math.min(ctx.width / cw, ctx.height / ch);
    const ox = (ctx.width - cw * s) / 2 - crop[0] * s;
    const oy = (ctx.height - ch * s) / 2 - crop[1] * s;
    return {
        ctx,
        s,
        x(fx) { return ox + fx * s; },
        y(fy) { return oy + fy * s; },
        /* A length in unit-square terms, never below one pixel: a stroke that
         * rounds to zero makes a feature vanish at cell size instead of
         * simplifying, which is worse than drawing it one pixel thick. */
        n(f) { const v = Math.round(f * s); return v < 1 ? 1 : v; },
    };
}

/*
 * An axis-aligned ellipse, outlined or filled.
 *
 * Row-scanned, the way the host's own fillCircle is, so a shape drawn here sits
 * beside a built-in one without looking like a different object. The outline
 * case has to close its own gaps: near the top and bottom the width changes by
 * several pixels per row, so plotting just the two edge pixels leaves a dotted
 * crown. Each row therefore bridges horizontally back to the previous row's
 * edge on both sides.
 */
function ellipse(u, fcx, fcy, frw, frh, fill, color) {
    const cx = u.x(fcx), cy = u.y(fcy);
    const rw = Math.max(0.5, frw * u.s), rh = Math.max(0.5, frh * u.s);
    const c = color === undefined ? 1 : color;
    const y0 = Math.round(cy - rh), y1 = Math.round(cy + rh);
    let pa = -1, pb = -1;
    for (let y = y0; y <= y1; y++) {
        const dy = (y + 0.5 - cy) / rh;
        if (dy < -1 || dy > 1) continue;
        const half = rw * Math.sqrt(Math.max(0, 1 - dy * dy));
        const xa = Math.round(cx - half), xb = Math.round(cx + half);
        const w = Math.max(1, xb - xa);
        if (fill) {
            u.ctx.fillRect(xa, y, w, 1, c);
        } else {
            u.ctx.fillRect(xa, y, 1, 1, c);
            u.ctx.fillRect(xa + w - 1, y, 1, 1, c);
            if (pa >= 0) {
                /* Bridge both edges back to the previous row. */
                if (Math.abs(xa - pa) > 1) {
                    const lo = Math.min(xa, pa);
                    u.ctx.fillRect(lo, y, Math.abs(xa - pa), 1, c);
                }
                const b = xa + w - 1;
                if (Math.abs(b - pb) > 1) {
                    const lo = Math.min(b, pb);
                    u.ctx.fillRect(lo, y, Math.abs(b - pb), 1, c);
                }
            }
            pa = xa; pb = xa + w - 1;
        }
    }
}

/* A straight line in unit coords. */
function uline(u, x0, y0, x1, y1, color) {
    u.ctx.line(Math.round(u.x(x0)), Math.round(u.y(y0)),
               Math.round(u.x(x1)), Math.round(u.y(y1)),
               color === undefined ? 1 : color);
}

/* A filled triangle — ears, horns, mohawk spikes, the pizza slice. */
function tri(u, ax, ay, bx, by, cx2, cy2, color) {
    const c = color === undefined ? 1 : color;
    const px = [u.x(ax), u.x(bx), u.x(cx2)], py = [u.y(ay), u.y(by), u.y(cy2)];
    const y0 = Math.round(Math.min(py[0], py[1], py[2]));
    const y1 = Math.round(Math.max(py[0], py[1], py[2]));
    for (let y = y0; y <= y1; y++) {
        let lo = Infinity, hi = -Infinity;
        for (let e = 0; e < 3; e++) {
            const f = (e + 1) % 3;
            const ya = py[e], yb = py[f];
            if (ya === yb) continue;
            const t = (y + 0.5 - ya) / (yb - ya);
            if (t < 0 || t > 1) continue;
            const x = px[e] + (px[f] - px[e]) * t;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
        }
        if (hi < lo) continue;
        const xa = Math.round(lo), xb = Math.round(hi);
        u.ctx.fillRect(xa, y, Math.max(1, xb - xa), 1, c);
    }
}

/*
 * A quadratic curve, as a polyline.
 *
 * The Swift art is mostly addQuadCurve, and at these sizes a curve is a
 * handful of pixels — so the segment count is derived from how many pixels the
 * curve actually spans rather than being a constant. A fixed count either
 * wastes bindings on a 6px cell feature or visibly facets a 64px one.
 */
function quad(u, x0, y0, cx, cy, x1, y1, color) {
    const span = Math.abs(u.x(x1) - u.x(x0)) + Math.abs(u.y(y1) - u.y(y0));
    const n = Math.max(2, Math.min(14, Math.round(span / 2)));
    let px = u.x(x0), py = u.y(y0);
    for (let i = 1; i <= n; i++) {
        const t = i / n, m = 1 - t;
        const qx = m * m * u.x(x0) + 2 * m * t * u.x(cx) + t * t * u.x(x1);
        const qy = m * m * u.y(y0) + 2 * m * t * u.y(cy) + t * t * u.y(y1);
        u.ctx.line(Math.round(px), Math.round(py), Math.round(qx), Math.round(qy),
                   color === undefined ? 1 : color);
        px = qx; py = qy;
    }
}

/* ------------------------------------------------------------- eye styles --
 *
 * Six shared styles, because the twelve characters only use six. Each takes
 * the unit mapper, the character's own geometry and whether the eye is shut.
 */

/* A stroked arc bowing DOWNWARD — monk, old man, fire fighter. */
function arcEyes(u, cxs, fy, hw, depth, shut) {
    const d = shut ? depth[1] : depth[0];
    for (const cx of cxs) quad(u, cx - hw, fy, cx, fy + d, cx + hw, fy, 1);
}

/* Sclera + pupil — cow, dog, little girl, unicorn, pizza. */
function roundEyes(u, cxs, fy, r, pupil, shut) {
    for (const cx of cxs) {
        if (shut) { uline(u, cx - r, fy, cx + r, fy, 1); continue; }
        ellipse(u, cx, fy, r, r, false, 1);
        ellipse(u, cx, fy, r * pupil, r * pupil, true, 1);
    }
}

/* Solid, no sclera and no pupil — the ghost's hollow sockets. */
function solidEyes(u, cxs, fy, rw, rh, shut) {
    for (const cx of cxs) {
        if (shut) uline(u, cx - rw, fy, cx + rw, fy, 1);
        else ellipse(u, cx, fy, rw, rh, true, 1);
    }
}

/* Filled almond with a vertical slit — the cat, and only the cat. */
function almondEyes(u, cxs, fy, hw, hh, shut) {
    for (const cx of cxs) {
        if (shut) { uline(u, cx - hw * 0.6, fy, cx + hw * 0.6, fy, 1); continue; }
        ellipse(u, cx, fy, hw, hh, true, 1);
        /* The slit is drawn UNLIT out of the filled almond — a lit slit on a
         * lit eye would be invisible. */
        ellipse(u, cx, fy, hw * 0.22, hh * 0.8, true, 0);
    }
}

/* A straight angular eyeliner flick, mirrored so both sweep away from the
 * nose — the punk. `outward` is what does the mirroring in the Swift. */
function flickEyes(u, cxs, fy, hw, flick, shut) {
    const f = shut ? flick[1] : flick[0];
    for (let i = 0; i < cxs.length; i++) {
        const out = i === 0 ? -1 : 1;
        uline(u, cxs[i] - hw * out, fy + f * 0.25, cxs[i] + hw * out, fy - f, 1);
    }
}

/* ------------------------------------------------------------ the twelve ---
 *
 * `crop` is the head-and-props box the small surfaces show; `cropFull` is what
 * the fullscreen face shows. Two crops rather than one because a 17x15 cell
 * showing a whole body is four grey pixels, and a fullscreen view showing only
 * a head throws away the robe, the tail and the pizza.
 *
 * `d` is a DETAIL BUDGET derived from the frame size by faceDetail() below:
 * 0 for a knob cell, 1 for a card, 2 for the panel. A feature that would land
 * on fewer than a couple of pixels is skipped at low detail rather than drawn
 * as noise — but never the feature that IS the character (the mohawk, the
 * horn, the ears), which is why the budget is per-feature and not a scale.
 */
const FACES = [
{
    id: "monk", name: "Monk",
    anchors: [[0.16,0.26],[0.26,0.30],[0.34,0.22],[0.40,0.13],[0.44,0.07]],
    mc: [0.5,0.394], mbf: 0.27,
    crop: [0.29,0.09,0.71,0.51], cropFull: [0.02,0.06,0.98,1.00],
    head(u, d) {
        /* Ears first, so the head circle overlaps their inner half and leaves
         * the outer crescent — exactly the layering the Swift relies on. */
        if (d >= 1) for (const cx of [0.337, 0.663]) ellipse(u, cx, 0.318, 0.0225, 0.038, false, 1);
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.30)), Math.round(0.17 * u.s), 1);
        if (d < 2) return;
        /* Neck, then the robe: shoulders, hem, and the drape line whose upper
         * side is the bare shoulder. */
        uline(u, 0.44, 0.43, 0.43, 0.50); uline(u, 0.56, 0.43, 0.57, 0.50);
        quad(u, 0.20, 0.58, 0.27, 0.50, 0.43, 0.50);
        quad(u, 0.57, 0.50, 0.73, 0.50, 0.80, 0.58);
        quad(u, 0.80, 0.58, 0.90, 0.66, 0.92, 0.78);
        quad(u, 0.20, 0.58, 0.10, 0.66, 0.08, 0.78);
        uline(u, 0.92, 0.78, 0.90, 0.99); uline(u, 0.08, 0.78, 0.10, 0.99);
        quad(u, 0.10, 0.99, 0.50, 1.02, 0.90, 0.99);
        quad(u, 0.57, 0.50, 0.74, 0.64, 0.95, 0.80);   /* the drape */
    },
    eyes(u, shut, d) { arcEyes(u, [0.415, 0.585], 0.296, 0.05, [0.027, 0.011], shut); },
},
{
    id: "fish", name: "Fish",
    /* A PROFILE, facing right: one eye, and a mouth off-axis at fx 0.80. */
    anchors: [[0.42,0.30],[0.55,0.46],[0.62,0.62],[0.50,0.48],[0.34,0.28]],
    mc: [0.80,0.56], mbf: 0.20,
    /* The whole fish, not a head crop: it is a profile creature and the tail is
     * half of what makes it a fish. The head-only box cut it off, which reads
     * as a clipped drawing rather than as a close-up. */
    crop: [0.00,0.14,1.00,0.92], cropFull: [0.00,0.02,1.00,0.98],
    head(u, d) {
        quad(u, 0.16, 0.50, 0.50, 0.20, 0.88, 0.56);      /* back */
        quad(u, 0.88, 0.56, 0.48, 0.90, 0.16, 0.50);      /* belly */
        if (d >= 1) {
            tri(u, 0.24, 0.50, 0.02, 0.26, 0.11, 0.50);   /* tail, upper lobe */
            tri(u, 0.24, 0.50, 0.02, 0.76, 0.11, 0.50);   /* tail, lower lobe */
        }
        if (d >= 2) {
            quad(u, 0.38, 0.30, 0.50, 0.08, 0.62, 0.28);  /* dorsal */
            quad(u, 0.50, 0.62, 0.44, 0.86, 0.40, 0.64);  /* pectoral */
        }
        /* The puckered lip ring frames the aperture, so it is never dropped —
         * without it the mouth reads as a hole in a blob. */
        ellipse(u, 0.80, 0.56, 0.085, 0.085, false, 1);
    },
    eyes(u, shut, d) {
        if (shut) { uline(u, 0.525, 0.38, 0.675, 0.38, 1); return; }
        ellipse(u, 0.60, 0.38, 0.075, 0.075, false, 1);
        ellipse(u, 0.60, 0.38, 0.030, 0.030, true, 1);
    },
},
{
    id: "unicorn", name: "Unicorn",
    anchors: [[0.20,0.10],[0.34,0.16],[0.46,0.20],[0.54,0.15],[0.58,0.09]],
    mc: [0.5,0.60], mbf: 0.26,
    crop: [0.22,-0.08,0.78,0.68], cropFull: [0.02,-0.10,0.98,1.00],
    head(u, d) {
        /* Ears and horn BEFORE the head, same reason as the monk's ears. The
         * horn is the character; it is drawn at every detail level. */
        for (const s of [-1, 1]) {
            const cx = 0.5 + s * 0.1295;
            tri(u, cx - 0.05, 0.198, cx + 0.05, 0.198, cx, -0.042);
        }
        tri(u, 0.466, 0.156, 0.534, 0.156, 0.518, -0.135);
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.30)), Math.round(0.185 * u.s), 1);
        /* Spiral hints up the horn — three short diagonals, large sizes only. */
        if (d >= 2) for (const t of [0.2, 0.42, 0.64]) {
            const y = 0.156 + (-0.135 - 0.156) * t, w = 0.034 * (1 - t);
            uline(u, 0.5 - w, y, 0.5 + w + 0.01, y - 0.012);
        }
        ellipse(u, 0.5, 0.494, 0.135, 0.150, false, 1);   /* muzzle */
        if (d >= 1) for (const nx of [0.468, 0.532]) ellipse(u, nx, 0.520, 0.011, 0.011, true, 1);
        if (d < 2) return;
        /* The mane, three strands down the LEFT side only. */
        /* Rooted ON the head's left EDGE and bowed further left, never across
         * it. The Swift roots them at fx 0.34-0.40, which is inside the head
         * circle — harmless when the head is a filled cream disc, but on 1-bit
         * outline art a strand starting inside the outline draws a line across
         * the face. Same curve, moved off the silhouette. */
        const mane = [[0.335,0.185,0.06,0.46],[0.315,0.28,0.10,0.62],[0.345,0.375,0.14,0.80]];
        for (const m of mane) quad(u, m[0], m[1], m[2] - 0.02, (m[1] + m[3]) / 2, m[2], m[3]);
        uline(u, 0.40, 0.457, 0.30, 0.55); uline(u, 0.60, 0.457, 0.70, 0.55);
        uline(u, 0.30, 0.55, 0.14, 0.99); uline(u, 0.70, 0.55, 0.86, 0.99);
    },
    eyes(u, shut, d) { roundEyes(u, [0.425, 0.575], 0.29, 0.048, 0.62, shut); },
},
{
    id: "girl", name: "Little Girl",
    /* The head-to-body ratio IS the identity: r 0.115 against the monk's 0.17. */
    anchors: [[0.10,0.16],[0.16,0.20],[0.22,0.15],[0.26,0.10],[0.30,0.06]],
    mc: [0.5,0.255], mbf: 0.30,
    crop: [0.24,0.03,0.76,0.35], cropFull: [0.02,0.02,0.98,1.00],
    head(u, d) {
        for (const cx of [0.3275, 0.6725]) {           /* pigtail buns */
            ellipse(u, cx, 0.19, 0.0713, 0.0713, false, 1);
            if (d >= 2) uline(u, cx, 0.19 + 0.0713 * 0.6, cx - (cx < 0.5 ? 0.02 : -0.02), 0.19 + 0.0713 * 2.0);
        }
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.20)), Math.round(0.115 * u.s), 1);
        /* Bangs: the arc across the brow plus the crown peak. */
        quad(u, 0.4004, 0.1425, 0.5, 0.163, 0.5996, 0.1425);
        if (d >= 1) {
            quad(u, 0.4004, 0.1425, 0.454, 0.033, 0.5, 0.0678);
            quad(u, 0.5, 0.0678, 0.546, 0.033, 0.5996, 0.1425);
        }
        if (d < 2) return;
        uline(u, 0.455, 0.298, 0.455, 0.34); uline(u, 0.545, 0.298, 0.545, 0.34);
        quad(u, 0.455, 0.34, 0.22, 0.62, 0.08, 0.99);   /* the dress cone */
        quad(u, 0.545, 0.34, 0.78, 0.62, 0.92, 0.99);
        uline(u, 0.08, 0.99, 0.92, 0.99);
        uline(u, 0.10, 0.92, 0.90, 0.92);               /* hem trim */
        uline(u, 0.445, 0.40, 0.26, 0.46); uline(u, 0.555, 0.40, 0.74, 0.46);
    },
    eyes(u, shut, d) { roundEyes(u, [0.455, 0.545], 0.20, 0.03, 0.68, shut); },
},
{
    id: "oldman", name: "Old Man",
    anchors: [[0.14,0.16],[0.22,0.20],[0.30,0.15],[0.36,0.10],[0.40,0.06]],
    mc: [0.5,0.40], mbf: 0.24,
    crop: [0.25,0.10,0.75,0.68], cropFull: [0.02,0.08,0.98,1.00],
    head(u, d) {
        if (d >= 1) for (const cx of [0.3383, 0.6617]) ellipse(u, cx, 0.30, 0.021, 0.035, false, 1);
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.30)), Math.round(0.165 * u.s), 1);
        /* Side tufts, which bulge PAST the silhouette — that overhang is what
         * makes the bald crown read as bald rather than as a plain circle. */
        for (const s of [-1, 1]) {
            const bx = 0.5 + s * 0.1617, tx = 0.5 + s * 0.1452;
            quad(u, bx, 0.308, 0.5 + s * 0.2228, 0.280, tx, 0.237);
        }
        /* The beard covers the lower face and the mouth opens inside it. */
        quad(u, 0.3383, 0.308, 0.3845, 0.614, 0.5, 0.638);
        quad(u, 0.5, 0.638, 0.6155, 0.614, 0.6617, 0.308);
        if (d >= 2) for (const w of [[0.201,0.0825],[0.181,0.0693],[0.160,0.0462]])
            quad(u, 0.5 - w[1], w[0], 0.5, w[0] - 0.012, 0.5 + w[1], w[0]);
        if (d < 2) return;
        quad(u, 0.28, 0.52, 0.18, 0.70, 0.06, 0.99);
        quad(u, 0.72, 0.52, 0.82, 0.70, 0.94, 0.99);
        uline(u, 0.06, 0.99, 0.94, 0.99);
        uline(u, 0.5, 0.68, 0.5, 0.99);                  /* cardigan zip */
    },
    eyes(u, shut, d) {
        arcEyes(u, [0.44, 0.56], 0.28, 0.032, [0.014, 0.005], shut);
        /* The heavy brow is always drawn — it is the age cue, not an eye. */
        for (const cx of [0.44, 0.56]) quad(u, cx - 0.045, 0.25, cx, 0.225, cx + 0.045, 0.245);
    },
},
{
    id: "cow", name: "Cow",
    anchors: [[0.18,0.08],[0.30,0.14],[0.42,0.20],[0.50,0.13],[0.56,0.07]],
    mc: [0.5,0.60], mbf: 0.34,
    crop: [0.10,-0.02,0.90,0.74], cropFull: [0.02,-0.02,0.98,1.00],
    head(u, d) {
        /* Ears and horns before the head. Both are identity cues, so both
         * survive to detail 0. */
        for (const s of [-1, 1]) {
            const rx = 0.5 + s * 0.1615;
            quad(u, rx, 0.2035, 0.5 + s * 0.30, 0.21, 0.5 + s * 0.3615, 0.285);
            quad(u, 0.5 + s * 0.3615, 0.285, 0.5 + s * 0.30, 0.33, rx, 0.327);
            tri(u, 0.5 + s * 0.0684 - s * 0.012, 0.11, 0.5 + s * 0.0684 + s * 0.012, 0.11,
                   0.5 + s * 0.1254, 0.004);
        }
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.27)), Math.round(0.19 * u.s), 1);
        ellipse(u, 0.5, 0.540, 0.19, 0.15, false, 1);    /* the big muzzle */
        if (d >= 1) for (const nx of [0.425, 0.575]) ellipse(u, nx, 0.522, 0.018, 0.013, true, 1);
        /* The dark patch over one eye, as an outline — a filled patch at 1 bit
         * would swallow the eye it is supposed to sit around. */
        if (d >= 2) {
            quad(u, 0.30, 0.20, 0.33, 0.09, 0.46, 0.11);
            quad(u, 0.46, 0.11, 0.49, 0.24, 0.42, 0.33);
            quad(u, 0.42, 0.33, 0.33, 0.31, 0.30, 0.20);
        }
        if (d < 2) return;
        quad(u, 0.22, 0.64, 0.12, 0.80, 0.05, 0.99);
        quad(u, 0.78, 0.64, 0.88, 0.80, 0.95, 0.99);
        uline(u, 0.05, 0.99, 0.95, 0.99);
    },
    eyes(u, shut, d) { roundEyes(u, [0.425, 0.575], 0.26, 0.044, 0.62, shut); },
},
{
    id: "dog", name: "Dog",
    anchors: [[0.20,0.14],[0.32,0.24],[0.44,0.34],[0.52,0.40],[0.58,0.44]],
    mc: [0.5,0.56], mbf: 0.30,
    crop: [0.26,0.09,0.74,0.70], cropFull: [0.02,0.08,0.98,1.00],
    head(u, d) {
        /* Long drooping ears past the jawline — the dog cue, kept at detail 0. */
        for (const s of [-1, 1]) {
            const rx = 0.5 + s * 0.170;
            quad(u, rx, 0.272, 0.5 + s * 0.26, 0.42, 0.5 + s * 0.198, 0.587);
            quad(u, 0.5 + s * 0.198, 0.587, 0.5 + s * 0.135, 0.44, rx, 0.30);
        }
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.30)), Math.round(0.185 * u.s), 1);
        ellipse(u, 0.5, 0.522, 0.15, 0.13, false, 1);            /* snout */
        ellipse(u, 0.5, 0.522 - 0.13 * 0.28, 0.035, 0.026, true, 1); /* nose */
        if (d < 2) return;
        quad(u, 0.24, 0.62, 0.14, 0.80, 0.06, 0.99);
        quad(u, 0.76, 0.62, 0.86, 0.80, 0.94, 0.99);
        uline(u, 0.06, 0.99, 0.94, 0.99);
    },
    eyes(u, shut, d) { roundEyes(u, [0.43, 0.57], 0.28, 0.042, 0.60, shut); },
},
{
    id: "ghost", name: "Ghost",
    anchors: [[0.30,0.30],[0.34,0.36],[0.36,0.38],[0.34,0.34],[0.30,0.28]],
    mc: [0.5,0.56], mbf: 0.22,
    crop: [0.06,0.02,0.94,0.76], cropFull: [0.02,0.01,0.98,0.99],
    head(u, d) {
        /* One continuous sheet: no head/body split at all. */
        quad(u, 0.5, 0.04, 0.78, 0.02, 0.92, 0.20);
        quad(u, 0.92, 0.20, 0.92, 0.33, 0.92, 0.46);
        uline(u, 0.92, 0.46, 0.92, 0.72);
        uline(u, 0.08, 0.46, 0.08, 0.72);
        quad(u, 0.08, 0.46, 0.08, 0.20, 0.22, 0.02);
        quad(u, 0.22, 0.02, 0.36, 0.02, 0.5, 0.04);
        /* Five scalloped hem lobes. At cell size they collapse to one lit row,
         * which still reads as a hem, so the loop is not gated. */
        const pts = [0.92, 0.76, 0.60, 0.44, 0.28, 0.08];
        const ctl = [0.84, 0.68, 0.52, 0.36, 0.20];
        for (let i = 0; i < 5; i++) quad(u, pts[i], 0.72, ctl[i], 0.94, pts[i + 1], 0.72);
    },
    eyes(u, shut, d) { solidEyes(u, [0.40, 0.60], 0.34, 0.026, 0.034, shut); },
},
{
    id: "firefighter", name: "Fire Fighter",
    anchors: [[0.16,0.18],[0.26,0.26],[0.36,0.32],[0.44,0.24],[0.48,0.16]],
    mc: [0.5,0.44], mbf: 0.25,
    crop: [0.23,0.09,0.77,0.54], cropFull: [0.02,0.08,0.98,1.00],
    head(u, d) {
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.34)), Math.round(0.165 * u.s), 1);
        /* The helmet is the character. Dome then brim, brim last so its flare
         * cuts across the dome the way the real silhouette does. */
        ellipse(u, 0.5, 0.206, 0.175, 0.0809, false, 1);
        ellipse(u, 0.5, 0.287, 0.223, 0.0297, true, 1);
        if (d >= 1) ellipse(u, 0.5, 0.129, 0.018, 0.018, true, 1);      /* knob */
        if (d >= 2) ellipse(u, 0.5, 0.206, 0.045, 0.030, false, 0);     /* badge */
        if (d < 2) return;
        uline(u, 0.425, 0.489, 0.425, 0.52); uline(u, 0.575, 0.489, 0.575, 0.52);
        quad(u, 0.24, 0.62, 0.14, 0.80, 0.06, 0.99);
        quad(u, 0.76, 0.62, 0.86, 0.80, 0.94, 0.99);
        uline(u, 0.06, 0.99, 0.94, 0.99);
        /* Inset to the coat's own width at those heights; the Swift's 0.10-0.90
         * band is inside a FILLED coat, and on outline art it hangs past it. */
        uline(u, 0.115, 0.78, 0.885, 0.78); uline(u, 0.10, 0.86, 0.90, 0.86);
    },
    eyes(u, shut, d) {
        /* NOTE the fy: 0.34 + 0.01. This is the one character whose eye offset
         * ADDS to the head centre; every other one subtracts. Ported as found. */
        arcEyes(u, [0.435, 0.565], 0.35, 0.048, [0.024, 0.010], shut);
    },
},
{
    id: "punk", name: "Punk",
    anchors: [[0.18,0.12],[0.28,0.10],[0.36,0.08],[0.42,0.14],[0.46,0.20]],
    mc: [0.5,0.42], mbf: 0.24,
    crop: [0.30,-0.01,0.70,0.52], cropFull: [0.02,-0.01,0.98,1.00],
    head(u, d) {
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.32)), Math.round(0.15 * u.s), 1);
        /* Five mohawk spikes — the dominant cue, so never gated on detail. */
        const spikes = [[0.42,0.14],[0.46,0.08],[0.50,0.02],[0.54,0.08],[0.58,0.14]];
        for (const sp of spikes) tri(u, sp[0] - 0.02, 0.1925, sp[0] + 0.02, 0.1925, sp[0], sp[1]);
        if (d >= 2) {
            ellipse(u, 0.6275, 0.3725, 0.02, 0.02, false, 1);   /* safety pin */
            uline(u, 0.425, 0.4475, 0.425, 0.50); uline(u, 0.575, 0.4475, 0.575, 0.50);
            quad(u, 0.26, 0.56, 0.16, 0.78, 0.06, 0.99);
            quad(u, 0.74, 0.56, 0.84, 0.78, 0.94, 0.99);
            uline(u, 0.06, 0.99, 0.94, 0.99);
            for (const sx of [0.20, 0.32, 0.68, 0.80])       /* jacket studs */
                tri(u, sx - 0.022, 0.60, sx + 0.022, 0.60, sx, 0.578);
        }
    },
    eyes(u, shut, d) { flickEyes(u, [0.425, 0.575], 0.31, 0.034, [0.022, 0.004], shut); },
},
{
    id: "pizza", name: "Pizza",
    /* Not humanoid: the silhouette IS a slice, point-DOWN. No head circle. */
    anchors: [[0.24,0.10],[0.36,0.20],[0.46,0.30],[0.52,0.22],[0.56,0.14]],
    mc: [0.5,0.56], mbf: 0.26,
    crop: [0.04,0.02,0.96,0.86], cropFull: [0.01,0.00,0.99,1.00],
    head(u, d) {
        quad(u, 0.5, 0.97, 0.20, 0.68, 0.09, 0.16);
        quad(u, 0.09, 0.16, 0.5, 0.06, 0.91, 0.16);
        quad(u, 0.91, 0.16, 0.80, 0.68, 0.5, 0.97);
        if (d >= 1) quad(u, 0.09, 0.24, 0.5, 0.14, 0.91, 0.24);   /* crust line */
        if (d >= 2) for (const p of [[0.26,0.46,0.075],[0.74,0.42,0.065],[0.50,0.80,0.075]])
            ellipse(u, p[0], p[1], p[2], p[2], false, 1);
    },
    eyes(u, shut, d) { roundEyes(u, [0.40, 0.60], 0.40, 0.042, 0.55, shut); },
},
{
    id: "cat", name: "Cat",
    anchors: [[0.08,0.10],[0.14,0.14],[0.20,0.10],[0.24,0.06],[0.28,0.04]],
    mc: [0.5,0.345], mbf: 0.20,
    crop: [0.28,-0.01,0.72,0.46], cropFull: [0.02,-0.01,0.98,1.00],
    head(u, d) {
        for (const s of [-1, 1]) {                       /* sharp triangle ears */
            tri(u, 0.5 + s * 0.026, 0.28, 0.5 + s * 0.149, 0.28, 0.5 + s * 0.096, 0.0113);
        }
        u.ctx.drawCircle(Math.round(u.x(0.5)), Math.round(u.y(0.28)), Math.round(0.175 * u.s), 1);
        ellipse(u, 0.5, 0.376, 0.118, 0.083, false, 1);  /* muzzle */
        tri(u, 0.472, 0.307, 0.528, 0.307, 0.5, 0.328);  /* nose */
        if (d >= 2) {
            for (const s of [-1, 1]) for (const dy of [-0.02, 0, 0.02])
                uline(u, 0.5 + s * 0.0875, 0.335 + dy * 0.5, 0.5 + s * 0.219, 0.335 + dy);
            uline(u, 0.405, 0.455, 0.405, 0.60); uline(u, 0.595, 0.455, 0.595, 0.60);
            quad(u, 0.405, 0.60, 0.30, 0.78, 0.24, 0.99);
            quad(u, 0.595, 0.60, 0.70, 0.78, 0.76, 0.99);
            uline(u, 0.24, 0.99, 0.76, 0.99);
            quad(u, 0.74, 0.88, 0.99, 0.55, 0.88, 0.42); /* the tail */
        }
    },
    eyes(u, shut, d) { almondEyes(u, [0.44, 0.56], 0.27, 0.052, 0.036, shut); },
},
];

/* Index by id, so a reordering of the C table cannot repaint the wrong face. */
const FACE_BY_ID = {};
for (let i = 0; i < FACES.length; i++) FACE_BY_ID[FACES[i].id] = FACES[i];

/* --------------------------------------------------------------- the mouth */

/*
 * The vowel reaches the mouth SMOOTHLY.
 *
 * It was quantised to 24 steps, ported from CharacterView.vowelFrameCount --
 * the original Delay Lama animated a sprite sheet, and the iOS port records
 * that a continuous version "read as slicker and less alive".
 *
 * That reasoning does not survive the move to this screen. On a phone the mouth
 * is a couple of hundred pixels tall and 24 frames is visible animation; in a
 * 17x15 knob cell the aperture is a handful of pixels, so the same 24 steps are
 * most of its travel and the thing simply jumps. Judged on hardware as
 * stair-stepping, which is exactly what it is here.
 *
 * Kept as a function rather than deleted at the call sites: it is the one knob
 * to turn if the stepped look is ever wanted at a larger size.
 */
const VOWEL_STEPS = 0;      /* 0 = continuous; 24 = the original sprite cadence */

function quantisedVowel(v) {
    const c = v < 0 ? 0 : (v > 1 ? 1 : v);
    if (VOWEL_STEPS < 2) return c;
    const steps = VOWEL_STEPS - 1;
    return Math.round(c * steps) / steps;
}

/* Continuous interpolation across a character's five anchor shapes,
 * roughly OO / OH / AH / EH / EE. */
function mouthShape(face, v) {
    const a = face.anchors;
    const scaled = (v < 0 ? 0 : v > 1 ? 1 : v) * (a.length - 1);
    const i = Math.min(Math.floor(scaled), a.length - 2);
    const t = scaled - i;
    return [a[i][0] + (a[i + 1][0] - a[i][0]) * t,
            a[i][1] + (a[i + 1][1] - a[i][1]) * t];
}

/*
 * The aperture: a filled blob at the character's mouth centre.
 *
 * `boost` is the stepped amplitude swell (1..1.35). It is stepped for the same
 * reason the vowel is — a continuously scaling mouth reintroduces exactly the
 * glide that quantising the vowel removes.
 */
function drawMouth(u, face, vowel, boost) {
    const [w, h] = mouthShape(face, quantisedVowel(vowel));
    const b = boost || 1;
    ellipse(u, face.mc[0], face.mc[1],
            w * face.mbf * 0.5 * b, h * face.mbf * 0.5 * b, true, 1);
}

function ampBoost(amp) {
    if (!(amp > 0)) return 1;
    const a = Math.round(Math.min(1, amp) * 4) / 4;   /* ampSteps = 4 */
    return 1 + a * 0.35;
}

/* The five anchor names, for the card's reading. */
const VOWEL_NAMES = ["OO", "OH", "AH", "EH", "EE"];

function vowelName(v) {
    const c = v < 0 ? 0 : (v > 1 ? 1 : v);
    return VOWEL_NAMES[Math.min(VOWEL_NAMES.length - 1, Math.round(c * (VOWEL_NAMES.length - 1)))];
}

/* ------------------------------------------------------------- the animator
 *
 * Ported from IdleAnimator: a 48-tick loop with blinks at ticks 14-17 and
 * 31-34. It is driven ENTIRELY by the clock, which is not a compromise — it is
 * how the iOS idle state works too, and it is the only thing that can animate
 * on a draw path where reads are structurally unavailable.
 */
function blinking(nowMs) {
    const tick = Math.floor((nowMs || 0) / 125) % 48;
    return (tick >= 14 && tick < 17) || (tick >= 31 && tick < 34);
}

/*
 * The detail budget, from the frame we were actually handed.
 *
 * 0 = a knob cell, 1 = a card, 2 = the panel. Derived from the frame rather
 * than passed in, because the same function is called at sixteen different
 * sizes across the two renderers and none of the callers knows which.
 */
function faceDetail(ctx) {
    const m = Math.min(ctx.width, ctx.height);
    /*
     * The 50 is load-bearing and was set by a REGRESSION, not by taste.
     *
     * It was 56. Then the fullscreen layout gave up nine rows to the name
     * caption, which took the face frame from 128x64 to 74x55 — under the
     * threshold — and every one of the twelve silently lost its body: the
     * Little Girl's dress, the monk's robe, the cat's tail, all gone, with no
     * error and a still-plausible picture. A card's content rect is about
     * 100x40, so 50 keeps the card at detail 1 while leaving the panel six
     * rows of margin. Do not raise it without re-rendering the sheet.
     */
    return m < 26 ? 0 : (m < 50 ? 1 : 2);
}

/* Resolve a face from whatever the host handed us. */
function faceFrom(v) {
    if (typeof v === "string" && FACE_BY_ID[v]) return FACE_BY_ID[v];
    const i = Number(v);
    if (Number.isFinite(i) && i >= 0 && i < FACES.length) return FACES[i | 0];
    return null;
}

/* Head + eyes + mouth, at one detail level, in one crop. */
function paintFace(rawCtx, face, crop, vowel, amp, nowMs) {
    const u = unit(rawCtx, crop);
    const d = faceDetail(rawCtx);
    face.head(u, d);
    face.eyes(u, blinking(nowMs), d);
    drawMouth(u, face, vowel, ampBoost(amp));
}

/* ==========================================================================
 * SURFACE 1 + 2 — the in-grid cells
 *
 * ONE KIND, TWO CELLS. The host registers exactly one custom kind per module
 * (`ov.widgetKind` is a single string, read once from a hardcoded canvas.js),
 * so `face` and `vowel` both declare "custom:monkface" and this drawCell
 * decides from the key it was handed:
 *
 *   face   the head, cropped to the head — a READOUT of WHO you are. It is
 *          declared access:"read", so the cell also wears the dotted stroke and
 *          cannot be mistaken for something turnable.
 *   vowel  the SAME character, cropped tight to the mouth region, so the
 *          aperture is large enough that turning the knob visibly moves it. A
 *          whole face in a 17x15 box moves by about one pixel; the mouth alone
 *          moves by five.
 *
 * `face` is read as a SIBLING KEY off the page's value map. That is the whole
 * reason the contract pins `face` to the same page as `vowel`: there is no
 * getParam here, so a widget can only learn the character from a key that
 * happens to be on the page beside it.
 * ========================================================================== */

/* The mouth-region crop: the aperture's own box, grown enough to keep a little
 * of the surrounding muzzle/beard/lip for context. Derived from the character's
 * rig rather than hand-tuned per face, so a new character needs no new number. */
function mouthCrop(face) {
    /*
     * A crop shaped like the MOUTH, not a square.
     *
     * Sized from the widest and tallest anchors across the whole sweep, so the
     * crop never changes as you turn -- a crop that tracked the value would
     * zoom with the mouth and the morph would appear not to happen at all.
     *
     * It matches the mouth's own ASPECT because unit() fits without stretching,
     * by the shorter axis. A square crop around a wide, flat mouth therefore
     * fitted by its unused height and threw away most of the cell: punk, pizza
     * and cat drew three lit pixels at OO, which is not a picture. Matching the
     * aspect lets whichever axis actually binds do the fitting.
     *
     * The 0.62 half-extent (a hair over half) leaves a pixel of air at the
     * widest anchor so the mouth never touches the cell edge -- which is what
     * made the previous version read as clipped by the header.
     */
    let mw = 0, mh = 0;
    for (const a of face.anchors) {
        if (a[0] > mw) mw = a[0];
        if (a[1] > mh) mh = a[1];
    }
    const rw = mw * face.mbf * 0.62;
    const rh = mh * face.mbf * 0.62;
    return [face.mc[0] - rw, face.mc[1] - rh, face.mc[0] + rw, face.mc[1] + rh];
}

/*
 * READ THE DEVICE. Only ever called from onOpen / onMidi, which are EVENTS --
 * never from draw or tick, where getParam is not on the context at all.
 *
 * A PLAIN FUNCTION, NOT A METHOD, and the method form was a real bug here. The
 * host invokes a canvas hook UNBOUND -- `fn(canvasHookCtx(name), payload)` in
 * invokeCanvasOverlayHook -- so `this` inside onOpen was undefined and
 * `this._refresh(ctx)` threw a TypeError. That throw is ONE-STRIKE: the whole
 * overlay is disabled for the session, so the device showed
 * "onOpen error: TypeError" and the face never drew again.
 *
 * Note drawCell is the other way round -- registerOverlayWidgets BINDS it, so
 * `this` works there. Two hooks on one object with different `this`, which is
 * why the safe rule for an overlay is simply never to use `this` at all.
 */
function refreshFromDevice(ctx) {
    const st = ctx.state || (ctx.state = {});
    if (typeof ctx.getParam !== "function") return;
    const id = ctx.getParam("face_id");
    if (typeof id === "string" && id.length) st.faceId = id;
    const v = Number(ctx.getParam("vowel:effective"));
    if (Number.isFinite(v)) st.vowel = v;
    const a = Number(ctx.getParam("amplitude"));
    if (Number.isFinite(a)) st.amp = a;
    const n = ctx.getParam("preset_name");
    if (typeof n === "string" && n.length) st.name = n;
    const i = parseInt(ctx.getParam("preset"), 10);
    if (Number.isFinite(i)) st.preset = i;
    const c = parseInt(ctx.getParam("preset_count"), 10);
    if (Number.isFinite(c) && c > 0) st.count = c;
}

globalThis.canvas_overlay = {
    /*
     * ONE widget: the mouth. There was briefly a second, a whole-head readout
     * in a "Who" cell, and it went because at 17x15 a head is an illegible blob
     * -- and because it only existed to carry `face` to the cell next to it,
     * which `extra_keys` now does without spending a knob slot.
     */
    widgetKind: "custom:monkmouth",

    /* Drawn proportionally at every size, so there is no nominal frame. */

    drawCell(ctx, { values, group, nowMs }) {
        const keys = (group && group.keys) || [];
        const key = keys[0] || "";
        const face = faceFrom(values ? values.face : null);



        /*
         * NO ANSWER, NO PICTURE. A face we cannot identify must not fall back
         * to the Monk — a confidently wrong character is worse than an empty
         * cell, because it looks like it worked. Draw the frame's own hint and
         * stop.
         */
        if (!face) {
            const c = norm(ctx);
            if (c.width >= 12 && c.height >= 8) c.print(0, Math.max(0, (c.height >> 1) - 4), "--", 1);
            return;
        }

        const t = typeof nowMs === "number" ? nowMs : 0;

        if (key === "vowel") {
            const raw = values ? Number(values.vowel) : NaN;
            if (!Number.isFinite(raw)) return;        /* same rule as above */
            /*
             * THE MOUTH ALONE.
             *
             * This drew face.head() around the aperture "so it reads as a mouth
             * in a head". At 17x15 that head is a ring filling the cell edge to
             * edge, sitting hard against the header rule above it -- which is
             * exactly what "the vowel widget is cut off by the header" was. The
             * aperture on its own is legible, and unmistakably a mouth the
             * moment it moves.
             */
            const u = unit(ctx, mouthCrop(face));
            drawMouth(u, face, raw, 1);
            return;
        }

        paintFace(ctx, face, face.crop, 0.5, 0, t);
    },

    /* ======================================================================
     * SURFACE 4 — the fullscreen face, and the character picker
     *
     * Reached by clicking `big_face`. This is the one surface with room for the
     * whole character, so it is also where you CHOOSE one: the jog steps the
     * preset, which loads that character's voice and face together.
     *
     * WHAT ANIMATES AND WHAT DOES NOT, and why that is not a compromise.
     * `draw` and `tick` are handed a context with getParam REMOVED — a read is
     * ~2.8 ms against a 1.68 ms whole-page render, so it is not merely
     * discouraged, it is absent. Therefore:
     *
     *   the blink and the idle breath  come from the clock, needing no read,
     *                                  exactly as IdleAnimator does on iOS
     *   the vowel, amp and character   are cached by onOpen and refreshed by
     *                                  onMidi, which are EVENTS, not frames
     *
     * So the face is alive while you are not touching it, and correct the
     * instant you are. What is genuinely unavailable is the mouth tracking a
     * held note's amplitude in real time while the panel sits idle; that would
     * need a per-frame read. It is named here rather than faked.
     * ====================================================================== */


    /* ======================================================================
     * SURFACE 5 — THE FACE PAGE
     *
     * A page of its own in the jog rotation, not a view you dive into. The
     * host draws the header (including the touch strip while a knob is held)
     * and the footer; this gets the band between them and nothing else, frame
     * scoped, so it cannot paint chrome and does not have to draw any.
     *
     * IT ANIMATES BECAUSE IT IS A PAGE. The host redraws every tick and the
     * page carries the level's own knobs, so `values` is the same cache the
     * grid renders from -- already fresh, at no extra read. The vowel here is
     * the live one, the character comes from `face` (declared as an extra key
     * on the vowel widget), and the blink comes from the clock.
     *
     * Still NO READS: this is a draw path like any other.
     * ====================================================================== */
    drawPage(ctx, { values, nowMs }) {
        const c = norm(ctx);
        const w = c.width, h = c.height;
        if (w < 24 || h < 16) return;

        const face = faceFrom(values ? values.face : null);
        const rawV = values ? Number(values.vowel) : NaN;
        const v = Number.isFinite(rawV) ? rawV : 0.5;

        /* No answer, no picture -- the same rule the cells and the card obey. */
        if (!face) {
            const msg = "loading character...";
            c.print(Math.max(0, (w - c.textWidth(msg)) >> 1), (h >> 1) - 3, msg, 1);
            return;
        }

        /*
         * The face gets the height; the reading sits beside it only if there is
         * room left over. Sized from the band rather than from constants: this
         * is the same drawing that runs in a 17x15 cell, and the band is
         * whatever the host has after its own chrome.
         */
        /*
         * The face takes the band's HEIGHT (it is the binding axis at every
         * size this page is ever given), sits at the left, and the two readings
         * are right-aligned against the band's own edge. Right-aligned rather
         * than placed just past the face: the face's width follows the band
         * height, so a fixed offset drifts as soon as anything about the chrome
         * changes.
         */
        const label = vowelName(v);
        const nm = String(face.name);

        /*
         * The face gets everything the text does not need.
         *
         * It was a SQUARE (min(w, h)), which throws away most of a 128x44 band
         * for any character wider than it is tall -- the fish lost its tail to
         * the crop and still only filled a quarter of the screen. unit() fits
         * without stretching, so a wide box simply lets a wide character grow;
         * a round head is still bound by the height and is unchanged.
         */
        const textW = Math.max(c.textWidth(label), c.textWidth(nm));
        const faceW = Math.max(16, w - textW - 6);

        /*
         * THE HEAD, not the whole figure.
         *
         * cropFull shows the character standing up -- robe, dress, tail -- and
         * in a 44px band that makes the head about a third of it, which is a
         * mouth of four pixels on the one screen whose job is showing the
         * mouth. face.crop is the head-and-props box the cells use, so the same
         * band gives a head roughly three times the size. The body is what a
         * 128x64 panel cannot afford here.
         */
        paintFace(subFrame(c, 0, 0, faceW, h), face, face.crop, v, 0, nowMs || 0);

        const lw = c.textWidth(label);
        const nw = c.textWidth(nm);
        const room = w - faceW - 4;
        if (lw <= room) c.print(w - lw, 2, label, 1);
        if (nw <= room) c.print(w - nw, h - 8, nm, 1);
    },
    onOpen(ctx) { refreshFromDevice(ctx); },

    onMidi(ctx, { data }) {
        if (!data || data.length < 3) return;
        const status = data[0] & 0xF0, d1 = data[1], d2 = data[2];
        if (status !== 0xB0) return;

        /* Jog turn: step the character. CC 14 is a signed delta. */
        if (d1 === 14) {
            const st = ctx.state || (ctx.state = {});
            const count = st.count || FACES.length;
            const delta = d2 < 64 ? d2 : d2 - 128;
            if (!delta) return;
            let next = (st.preset || 0) + (delta > 0 ? 1 : -1);
            if (next < 0) next = count - 1;
            if (next >= count) next = 0;
            if (typeof ctx.setParam === "function") ctx.setParam("preset", String(next));
            st.preset = next;
            refreshFromDevice(ctx);
        }
    },

    draw(ctx) {
        ctx.clear();
        const st = ctx.state || {};
        const face = faceFrom(st.faceId);

        if (!face) {
            /* The read has not answered yet. Say so; do not draw a monk. */
            ctx.print(2, 26, "loading character...", 1);
            return;
        }

        /*
         * LAYOUT, AND WHY THE NAME IS ALONG THE BOTTOM.
         *
         * It started in a right-hand column and the render showed the obvious:
         * a 62% face leaves ~45px, which is seven characters, so "Little Girl"
         * and "Fire Fighter" were cut to "Little G" and "Fire Fig" — the two
         * names most in need of being read. The bottom strip is the full 128px
         * (21 characters), which fits every one of the twelve with room over.
         *
         * The short readings that DO fit in a column stay in one.
         */
        const NAME_H = 9;
        const bodyH = ctx.height - NAME_H;
        const faceW = Math.round(ctx.width * 0.58);

        paintFace(subFrame(ctx, 0, 0, faceW, bodyH),
                  face, face.cropFull, st.vowel === undefined ? 0.5 : st.vowel,
                  st.amp || 0, ctx.now ? ctx.now() : 0);

        const x = faceW + 5;
        ctx.print(x, 4, vowelName(st.vowel === undefined ? 0.5 : st.vowel), 1);
        if (st.count) ctx.print(x, 18, `${(st.preset || 0) + 1}/${st.count}`, 1);
        /* A rule, then the name — so the strip reads as a caption rather than
         * as something the face is standing on. */
        ctx.fillRect(0, bodyH - 1, ctx.width, 1, 1);
        const nm = String(st.name || face.name);
        ctx.print(1, bodyH + 1, nm, 1);

        /*
         * The jog hint goes on the caption strip, right-aligned, and only if it
         * genuinely fits beside the name — that the jog changes CHARACTER is
         * not guessable, but a hint that collides with "Fire Fighter" is worse
         * than no hint. 21 characters across; the longest name is 12.
         */
        const hint = "jog:who";
        const hw = (typeof ctx.textWidth === "function" ? ctx.textWidth(hint) : hint.length * 6);
        const nw = (typeof ctx.textWidth === "function" ? ctx.textWidth(nm) : nm.length * 6);
        if (nw + 6 + hw <= ctx.width) ctx.print(ctx.width - hw - 1, bodyH + 1, hint, 1);
    },
};

/*
 * A frame over part of a ctx — the same idea frameCtx implements for widgets,
 * needed here because the fullscreen face shares the panel with its readout and
 * the face code is written against a frame it owns entirely. Clips, so a face
 * whose crop overshoots cannot paint over the text beside it.
 */
function subFrame(ctx, ox, oy, w, h) {
    return {
        width: w,
        height: h,
        fillRect(x, y, rw, rh, c) {
            let x0 = Math.round(x), y0 = Math.round(y);
            let x1 = x0 + Math.round(rw), y1 = y0 + Math.round(rh);
            if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
            if (x1 > w) x1 = w; if (y1 > h) y1 = h;
            if (x1 <= x0 || y1 <= y0) return;
            ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0, c);
        },
        print(x, y, t, c) { ctx.print(ox + x, oy + y, t, c); },
    };
}

/* ==========================================================================
 * SURFACE 3 — the card that floats while Vowel turns
 *
 * The marquee. A cell says "vowel is at 0.6"; this says what 0.6 MEANS — the
 * character actually mouthing it, beside the anchor's name.
 *
 * Declared as: "card_script": "canvas.js#vowel_card", card_w 104, card_h 46.
 * Same file as everything above, because all four surfaces draw the same
 * twelve faces and a second copy of FACES is the one thing worth avoiding.
 *
 * SAME CONTRACT AS A CELL. (0,0) is the inside of the card, ctx.width/height
 * are its size, the host has already cleared it and drawn its border, and
 * nothing drawn outside can land. `o.raw` MAY BE NULL — a read that did not
 * answer — and the rule is that a drawer prints a word and stops rather than
 * drawing a mouth at zero, which would be indistinguishable from a real OO.
 * ========================================================================== */

globalThis.vowel_card = function (ctx, o) {
    const c = norm(ctx);
    const w = c.width, h = c.height;
    if (w < 24 || h < 16) return;

    /*
     * THE SOUNDING VOWEL, not the knob's.
     *
     * `raw` is the base -- what the knob is set to -- and `values` carries the
     * live value merged over it. Pad pressure sweeps this parameter, so the
     * mouth on this card has to show what is actually being sung; a card that
     * showed the knob would contradict the cell right next to it.
     */
    const live = o.values ? Number(o.values.vowel) : NaN;
    const n = Number.isFinite(live)
        ? live
        : ((o.raw === null || o.raw === undefined) ? NaN : Number(o.raw));

    /* The name, always — the card is present and honest even knowing nothing. */
    c.print(0, 0, String(o.name || "Vowel"), 1);

    if (!Number.isFinite(n)) {
        c.print(0, h - 8, "--", 1);
        return;
    }

    /* The anchor name, right-aligned against the frame's own width. */
    const label = vowelName(n);
    const tw = c.textWidth(label);
    if (tw <= w) c.print(w - tw, 0, label, 1);

    /*
     * The face fills the card below the name row.
     *
     * A card is 104x46, which lands in detail budget 1 — head and props, no
     * body — so it is cropped to the head rather than the full figure. The
     * character comes from `o.face`, which the module serves beside the value;
     * if it did not answer we are back to the no-picture rule above.
     */
    /*
     * THE CHARACTER, READ OFF THE PAGE.
     *
     * `values` is the page's value map -- the same one drawCell gets -- so the
     * card learns which of the twelve is loaded exactly the way the cells do.
     * This used to be a stamp on globalThis written by drawCell, because the
     * card payload carried only this parameter's own value; the host carries
     * the siblings now, so the side channel is gone.
     *
     * Same null rule as `raw`: an absent or unanswered `face` means we do not
     * know the character, and not knowing must not become a picture.
     */
    const face = faceFrom(o.values ? o.values.face : null);
    const top = 9;
    if (!face) {
        c.print(0, top + 2, "vowel " + n.toFixed(2), 1);
        return;
    }

    const fw = Math.min(w, Math.round((h - top) * 1.1));
    paintFace(subFrame(c, 0, top, fw, h - top), face, face.crop, n, 0,
              typeof o.nowMs === "number" ? o.nowMs : 0);

    /*
     * A VERTICAL travel bar down the right edge, so the card also answers
     * "where in the sweep am I" — the one thing the mouth alone cannot say.
     *
     * It is drawn as a narrow track with two end caps and a marker. The first
     * version filled the whole remaining WIDTH for each of those three rows,
     * which put two 60px rules across the card and read as a rendering fault
     * rather than as a control. Only the render showed that.
     */
    const TRACK_W = 3;
    const bx = w - TRACK_W;
    if (bx > fw + 2) {
        const y0 = top + 1, y1 = h - 2;
        c.fillRect(bx + 1, y0, 1, y1 - y0, 1);              /* the track */
        c.fillRect(bx, y0, TRACK_W, 1, 1);                  /* caps */
        c.fillRect(bx, y1 - 1, TRACK_W, 1, 1);
        const y = Math.round(y0 + (y1 - y0 - 2) * n);
        c.fillRect(bx, y, TRACK_W, 2, 1);                   /* the marker */
    }
};

/*
 * A test hook, following the repo's existing `GLYPHS_FOR_TEST` convention.
 *
 * The face table is otherwise function-scoped and unreachable, which means the
 * only way to review twelve faces at three sizes would be on the device, one
 * character at a time. tools/preview_faces.mjs renders the whole set to a PNG
 * from this. Nothing on the device reads it.
 */
globalThis.MONK_FACES_FOR_TEST = FACES;
