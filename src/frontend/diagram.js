// The arithmetic coding diagram, after the one in the 3Blue1Brown video
// "This algorithm changed how I think about compression" (about 23:00 to 25:00).
//
// It draws the step stream of llama-zip.js (see "Observing the coder" in its
// README): the text so far with the current token highlighted, the binary
// number that grows as bits are settled, an exact number line with the coder's
// interval, and stacked layers of probability bars. Each layer splits the
// chosen bar of the layer above. The camera zooms into the chosen bar until it
// fills the width, the older layers slide up and fade, and the next layer
// appears under them.
//
// Three parts, so the logic runs without a page:
//   createPlayer()  queue, position, speed and the clock of the animation
//   renderFrame()   a step list and a position to strings of SVG and HTML
//   createDiagram() the DOM, the controls and the requestAnimationFrame loop
// Colours come from the page's CSS variables through classes in style.css.
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 'max'];

const
    WIDTH = 720,
    HEIGHT = 300,
    X0 = 20,
    BAR_WIDTH = 680,
    AXIS_Y = 46,
    ROW_TOP = 64,
    ROW_STEP = 36,
    ROW_HEIGHT = 30,
    SLOTS = 5,
    STEP_MS = 1600,
    MAX_STEP_MS = 40,
    MAX_KEPT_STEPS = 2000,
    TEXT_CHARS = 300,
    BIN_CHARS = 64,
    MAX_SLIVERS = 240,
    OTHERS = 'other tokens (not individually listed)';

const
    clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x)),
    lerp = (a, b, k) => a + (b - a) * k,
    ease = k => k * k * (3 - 2 * k),
    esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])),
    // Whitespace made visible, as the video does, and a name for the end token.
    visible = (piece, isEos) => isEos ? '[end]' : piece.replace(/ /g, '␣').replace(/\n/g, '↵').replace(/\t/g, '⇥'),
    fmtBits = bits => bits < 10 ? bits.toFixed(2) : bits < 100 ? bits.toFixed(1) : bits.toFixed(0),
    fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`,
    pct = p => p >= 0.1 ? `${(p * 100).toFixed(0)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : '<0.1%';

// ---- player ----------------------------------------------------------------

export const createPlayer = ({ stepMs = STEP_MS } = {}) => {
    const player = {
        steps: [], pos: 0, t: 0, playing: false, speed: 1, final: false, once: false,
        duration: () => player.speed === 'max' ? MAX_STEP_MS : stepMs / player.speed,
        // Steps that arrived and have not played yet.
        buffered: () => Math.max(0, player.steps.length - 1 - player.pos),
        finished: () => player.final && player.steps.length > 0 && player.pos >= player.steps.length - 1 && player.t >= 1,
        reset: () => Object.assign(player, { steps: [], pos: 0, t: 0, playing: false, final: false, once: false }),
        push: steps => {
            for (const step of steps)
                if (player.steps.length < MAX_KEPT_STEPS) player.steps.push(step);
            // Extends the exact interval of every step, so drawing never has to catch up.
            coderState(player.steps);
        },
        // Moves the clock by dt milliseconds. Returns true when the frame changed.
        advance: dt => {
            if (!player.playing || !player.steps.length) return false;
            player.t += dt / player.duration();
            while (player.t >= 1) {
                if (player.once) {
                    player.t = 1;
                    player.playing = player.once = false;
                    return true;
                }
                if (player.pos + 1 < player.steps.length) {
                    player.t -= 1;
                    player.pos++;
                }
                else {
                    player.t = 1;
                    if (player.final) player.playing = false;
                    break;
                }
            }
            return true;
        },
        play: () => {
            if (player.finished()) Object.assign(player, { pos: 0, t: 0 });
            player.playing = true;
            player.once = false;
        },
        pause: () => {
            player.playing = false;
        },
        // One step forward: finishes the current one first.
        step: () => {
            player.playing = false;
            if (player.t < 1 && player.steps.length) player.t = 1;
            else if (player.pos + 1 < player.steps.length) {
                player.pos++;
                player.t = 0;
                player.playing = player.once = true;
            }
        },
        back: () => {
            player.playing = false;
            if (player.t > 0 && player.t < 1) player.t = 0;
            else if (player.pos > 0) {
                player.pos--;
                player.t = 1;
            }
        },
        restart: () => Object.assign(player, { pos: 0, t: 0 }),
        // Skips the buffer to the newest step.
        live: () => {
            if (player.steps.length) Object.assign(player, { pos: player.steps.length - 1, t: 0 });
        }
    };
    return player;
};


// ---- exact interval ----------------------------------------------------------
//
// Where the message sits on the number line, exactly. The coder only holds a
// 64-bit window, and the steps carry the rest in pieces, so this puts them
// together. After a step the encoder has
//   - finalised bits b1..bn, the "prefix" (the sum of every step's newBits;
//     outputBits is capped at its last 256 bits, so the player accumulates
//     newBits from the first step instead),
//   - u held-back underflow bits (pendingUnderflow),
//   - a window [low, high] of 64-bit integers, high inclusive.
// Each shift doubles the scale and writes a bit. Each underflow also doubles
// the scale, with the map w' = 2w - 1/2 on the window, and writes nothing yet.
// Undoing u underflows turns a window position w' (a fraction in [0, 1)) into
//   x = 1/2 - 2^-(u+1) + w' * 2^-u
// of the scale after n shifts, and undoing the n shifts adds the prefix:
//   absolute = 0.b1..bn + 2^-n * x
// This is also why the held-back bits are written as the inverse of the next
// shift's bit: x lies in [0.0111..1, 0.1000..0] with u ones, so the prefix
// then becomes b, then u times (1 - b). The interval after a step is
// [low / 2^64, (high + 1) / 2^64) mapped this way. Multiplying by 2^(n+u+65)
// gives integers, so the interval is { lo, hi, shift } meaning lo / 2^shift.
// BigInt keeps all of it exact, however many bits the message has.
//
// windowReset does not matter here. It marks a new context window of the
// model, and the coder carries on with the same interval.
// A step list that does not start at the first step (or misses steps) has its
// prefix rebuilt from outputBits, which is right for its last 256 bits and
// zero before that.
const
    UNIT = { lo: 0n, hi: 1n << 65n, shift: 65 },
    TAIL = 10n ** 18n,
    powers = new Map();
const tenPower = n => {
    if (!powers.has(n)) powers.set(n, 10n ** BigInt(n));
    if (powers.size > 8) powers.delete(powers.keys().next().value);
    return powers.get(n);
};
const coders = new WeakMap();

// The running state per step, extended as steps arrive (the player calls it on push).
export const coderState = steps => {
    let memo = coders.get(steps);
    if (!memo) coders.set(steps, memo = { prefix: 0n, bits: 0, list: [] });
    for (let i = memo.list.length; i < steps.length; i++) {
        const
            step = steps[i],
            fresh = step.newBits || '';
        if (memo.bits + fresh.length === step.emittedBits)
            memo.prefix = fresh ? (memo.prefix << BigInt(fresh.length)) | BigInt(`0b${fresh}`) : memo.prefix;
        else
            memo.prefix = step.outputBits ? BigInt(`0b${step.outputBits}`) : 0n;
        memo.bits = step.emittedBits;
        memo.list.push({
            bits: step.emittedBits, pending: step.pendingUnderflow, prefix: memo.prefix,
            low: BigInt(`0x${step.coderLow}`), high: BigInt(`0x${step.coderHigh}`)
        });
    }
    return memo.list;
};

// The coder's interval after step `index` (-1 is before the first step) as { lo, hi, shift }.
export const coderInterval = (steps, index) => {
    if (index < 0) return UNIT;
    const
        { bits, pending, prefix, low, high } = coderState(steps)[index],
        base = (prefix << BigInt(pending + 65)) + (1n << BigInt(pending + 64)) - (1n << 64n);
    return { lo: base + 2n * low, hi: base + 2n * (high + 1n), shift: bits + pending + 65 };
};

// The part [from, to] (fractions) of an interval, for the camera between two layers.
export const zoomInterval = (base, from, to) => {
    const
        width = base.hi - base.lo,
        start = base.lo << 52n;
    return { lo: start + width * BigInt(Math.round(from * 2 ** 52)), hi: start + width * BigInt(Math.round(to * 2 ** 52)), shift: base.shift + 52 };
};

// Decimal tick marks inside an interval. The step is 1, 2 or 5 times a power of
// ten, chosen to give 6 to 15 ticks, so the labels gain digits as the interval
// narrows. Each tick is { at, whole, fraction, slot }: `at` is its place in the
// interval (0 to 1), the digits are exact, and `slot` counts steps modulo 60.
export const axisTicks = view => {
    const width = view.hi - view.lo;
    if (width <= 0n) return { digits: 0, ticks: [] };
    const
        hex = width.toString(16),
        log10Width = (Math.log2(parseInt(hex.slice(0, 13), 16)) + 4 * (hex.length - Math.min(13, hex.length)) - view.shift) * Math.log10(2);
    let digits = Math.max(0, Math.floor(-log10Width) - 1);
    let mantissa = 5;
    while (log10Width + digits - Math.log10(mantissa) < Math.log10(6))
        [mantissa, digits] = mantissa === 5 ? [2, digits] : mantissa === 2 ? [1, digits] : [5, digits + 1];
    const
        scale = tenPower(digits),
        step = BigInt(mantissa),
        unit = 1n << BigInt(view.shift),
        from = view.lo * scale,
        to = view.hi * scale,
        span = width * scale,
        first = (from + step * unit - 1n) / (step * unit) * step;
    // Turning a number of thousands of digits into text is slow, so only the
    // first tick is converted whole. The others differ from it in the last 18
    // digits and at most one carry into the rest.
    const
        head = first / TAIL,
        low = first % TAIL,
        heads = [head.toString(), (head + 1n).toString()],
        ticks = [];
    for (let m = first; m * unit < to && ticks.length < 40; m += step) {
        const
            tail = low + (m - first),
            text = ((tail >= TAIL ? heads[1] : heads[0]) + (tail % TAIL).toString().padStart(18, '0')).replace(/^0+/, '').padStart(digits + 1, '0');
        ticks.push({
            at: Number(((m * unit - from) << 40n) / span) / 2 ** 40,
            whole: text.slice(0, text.length - digits),
            fraction: text.slice(text.length - digits),
            slot: Number((m / step) % 60n)
        });
    }
    return { digits, ticks };
};

// ---- frame -----------------------------------------------------------------

const chosenOf = step => step.candidates.find(candidate => candidate.chosen);

// Integer hash to a number in [0, 1), so the slivers are the same on every frame.
const unitHash = (a, b, c) => {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 1, 0x27d4eb2f);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
};

const slivers = new WeakMap();

// Thin bars for the tokens that are not listed, as pairs [from, to] of fractions.
// The model gives only their total probability, so their places are a drawing:
// each gap between two listed bars gets bars at places taken from the token ids
// that border the gap.
const sliversOf = step => {
    let found = slivers.get(step);
    if (found) return found;
    found = [];
    const sorted = [...step.candidates].sort((a, b) => a.lo - b.lo);
    let edge = 0, leftId = 0;
    const fill = (to, rightId) => {
        const
            gap = to - edge,
            count = gap < 1e-5 ? 0 : clamp(Math.round(gap * 150), 1, 60);
        for (let i = 0; i < count && found.length < MAX_SLIVERS * 2; i++) {
            const
                cell = gap / count,
                from = edge + (i + 0.1 + 0.5 * unitHash(leftId, rightId, i)) * cell;
            found.push(from, from + cell * (0.12 + 0.3 * unitHash(rightId, leftId, i + 99)));
        }
    };
    for (const candidate of sorted) {
        fill(candidate.lo, candidate.tokenId);
        edge = Math.max(edge, candidate.hi);
        leftId = candidate.tokenId;
    }
    fill(1, 0);
    slivers.set(step, found);
    return found;
};

const barLabel = (candidate, x, w, y) => {
    const
        text = visible(candidate.piece, false),
        fit = Math.floor((w - 6) / 6.6);
    if (fit < 2 || !text) return '';
    const shown = text.length > fit ? `${text.slice(0, fit - 1)}…` : text;
    return `<text class="dg-label${candidate.chosen ? ' dg-label-chosen' : ''}" x="${(x + w / 2).toFixed(1)}" y="${(y + ROW_HEIGHT / 2 + 4).toFixed(1)}" text-anchor="middle">${esc(shown)}</text>`;
};

const visibleSpan = (a, b) => [Math.max(a, X0), Math.min(b, X0 + BAR_WIDTH)];

// One layer at its own scale: fraction u of the layer is at x0 + u * sx on screen.
// Bars and slivers outside the view are skipped. `dim` fades the bars that were
// not chosen, and `tips` adds a tooltip to each bar.
const layerSvg = (step, x0, sx, y, alpha, dim, tips) => {
    const [from, to] = visibleSpan(x0, x0 + sx);
    if (to <= from) return '';
    const y0 = y.toFixed(1);
    let path = '';
    const marks = sliversOf(step);
    for (let i = 0; i < marks.length; i += 2) {
        const [a, b] = visibleSpan(x0 + marks[i] * sx, x0 + marks[i + 1] * sx);
        if (b > a) path += `M${a.toFixed(2)} ${y0}h${Math.max(0.5, b - a).toFixed(2)}v${ROW_HEIGHT}h-${Math.max(0.5, b - a).toFixed(2)}z`;
    }
    let out = `<g opacity="${alpha.toFixed(3)}"><g class="dg-others" data-other="${OTHERS}"><rect class="dg-track" x="${from.toFixed(2)}" y="${y0}" width="${(to - from).toFixed(2)}" height="${ROW_HEIGHT}" rx="2"/>` +
        (path ? `<path class="dg-sliver" d="${path}"/>` : '') + '</g>';
    step.candidates.forEach((candidate, i) => {
        const [a, b] = [x0 + candidate.lo * sx, x0 + candidate.hi * sx];
        if (b < X0 || a > X0 + BAR_WIDTH) return;
        const
            [xa, xb] = visibleSpan(a, b),
            w = Math.max(candidate.chosen ? 1.5 : 0.8, xb - xa),
            opacity = candidate.chosen ? 1 : 1 - 0.65 * dim;
        out += `<rect class="dg-bar${i % 2 ? ' dg-alt' : ''}${candidate.chosen ? ' dg-chosen' : ''}" x="${xa.toFixed(2)}" y="${y0}" width="${w.toFixed(2)}" height="${ROW_HEIGHT}" opacity="${opacity.toFixed(3)}"${tips ? ` data-piece="${esc(visible(candidate.piece, step.isEos && candidate.chosen))}" data-p="${pct(candidate.p)}"` : ''}/>`;
        if (b - a < 8 && candidate.chosen)
            out += `<rect class="dg-pin" x="${(xa + w / 2 - 1).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="2" height="${ROW_HEIGHT + 10}"/>`;
        else
            out += barLabel(candidate, xa, xb - xa, y);
    });
    return `${out}</g>`;
};

// Each layer in the coordinates of the newest one (layer `pos`, which spans
// [0, 1]): layer pos - i starts at `o` and is `s` wide. A layer is the chosen
// bar of the one above, so the parent is wider by 1 / (hi - lo). Only relative
// fractions are used, so float64 is enough.
const layerFrames = (steps, pos, count) => {
    const frames = [{ o: 0, s: 1 }];
    for (let i = 1; i <= count && pos - i >= 0; i++) {
        const
            upper = steps[pos - i],
            s = frames[i - 1].s / (upper.hi - upper.lo);
        frames.push({ o: frames[i - 1].o - upper.lo * s, s });
    }
    return frames;
};

// The camera in the newest layer's coordinates, from the whole layer (z = 0) to
// its chosen bar (z = 1). The zoom is exponential, so the view narrows by the
// same factor in every frame. It scales about the point that the bar's edges
// map to, c = lo / (1 - f) for a bar of width f.
const cameraView = (step, z) => {
    const f = step.hi - step.lo;
    if (z <= 0 || step.isEos) return { from: 0, to: 1 };
    if (z >= 1) return { from: step.lo, to: step.hi };
    if (f > 0.999999) return { from: lerp(0, step.lo, z), to: lerp(1, step.hi, z) };
    const
        c = step.lo / (1 - f),
        g = f ** z;
    return { from: c * (1 - g), to: c + (1 - c) * g };
};

const fade = idx => clamp((idx + 1) / 2.2) ** 1.5;

const labelOf = (tick, shared) => {
    const full = tick.fraction ? `${tick.whole}.${tick.fraction}` : tick.whole;
    return full.length <= 12 ? full : `…${tick.fraction.slice(shared).slice(-10)}`;
};

// Number line of the exact interval in view. Its ends are the camera's ends, so
// the ticks move and gain digits with the zoom.
const axisSvg = (view, x1, x2, step, e) => {
    const
        { ticks } = axisTicks(view),
        shared = ticks.length > 1 ? [...ticks[0].fraction].findIndex((c, i) => ticks.some(tick => tick.fraction[i] !== c)) : 0,
        common = shared < 0 ? ticks[0].fraction.length : shared,
        spacing = ticks.length > 1 ? (ticks[1].at - ticks[0].at) * BAR_WIDTH : BAR_WIDTH,
        longest = Math.max(1, ...ticks.map(tick => labelOf(tick, common).length)),
        stride = [1, 2, 3, 4, 5, 6].find(n => n * spacing >= longest * 6.4 + 8) || 6;
    let out = `<text class="dg-caption" x="${X0}" y="12">Number line: the coder's interval. All tokens so far narrow [0, 1] to a width of 2^-${fmtBits(step.cumulativeBits)}.</text>`;
    if (common > 0)
        out += `<text class="dg-caption" x="${X0}" y="25">Every tick starts with 0.${common > 24 ? '…' : ''}${ticks[0].fraction.slice(Math.max(0, common - 24), common)}…</text>`;
    out += `<line class="dg-axis" x1="${X0}" y1="${AXIS_Y}" x2="${X0 + BAR_WIDTH}" y2="${AXIS_Y}"/>`;
    const [a, b] = visibleSpan(x1, x2);
    if (b > a)
        out += `<rect class="dg-range" opacity="${e.toFixed(3)}" x="${a.toFixed(1)}" y="${AXIS_Y - 3}" width="${Math.max(2, b - a).toFixed(1)}" height="6" rx="2"/>`;
    for (const tick of ticks) {
        const x = (X0 + tick.at * BAR_WIDTH).toFixed(1);
        out += `<line class="dg-axis" x1="${x}" y1="${AXIS_Y - 5}" x2="${x}" y2="${AXIS_Y}"/>`;
        const
            label = labelOf(tick, common),
            half = label.length * 3.3;
        if (tick.slot % stride === 0 && x - half > 2 && Number(x) + half < WIDTH - 2)
            out += `<text class="dg-tick" x="${x}" y="${AXIS_Y - 9}" text-anchor="middle">${label}</text>`;
    }
    return out;
};

const legendSvg = () => {
    const y = HEIGHT - 14;
    return `<rect class="dg-bar dg-chosen" x="${X0}" y="${y}" width="16" height="9"/><text class="dg-caption" x="${X0 + 22}" y="${y + 8}">chosen token</text>` +
        `<g class="dg-others" data-other="${OTHERS}"><rect class="dg-track" x="${X0 + 120}" y="${y}" width="16" height="9"/>` +
        `<path class="dg-sliver" d="M${X0 + 122} ${y}h1v9h-1zM${X0 + 126} ${y}h1.5v9h-1.5zM${X0 + 131} ${y}h1v9h-1z"/>` +
        `<text class="dg-caption" x="${X0 + 142}" y="${y + 8}">${OTHERS}</text></g>`;
};

const textHtml = (steps, pos, t) => {
    let used = 0;
    const parts = [];
    for (let i = pos; i >= 0 && used < TEXT_CHARS; i--) {
        used += steps[i].piece.length;
        parts.unshift(i);
    }
    const lead = parts[0] > 0 ? '…' : '';
    return lead + parts.map(i => {
        const piece = esc(steps[i].isEos ? '[end]' : steps[i].piece);
        return i === pos ? `<mark class="${t >= 0.35 ? 'on' : ''}">${piece}</mark>` : piece;
    }).join('');
};

const binaryHtml = (steps, pos, t) => {
    const settled = t >= 0.55;
    const source = settled ? steps[pos] : steps[pos - 1];
    const bits = source ? source.outputBits : '';
    const emitted = source ? source.emittedBits : 0;
    const fresh = settled ? steps[pos].newBits.length : 0;
    const shown = bits.slice(-BIN_CHARS);
    const old = shown.slice(0, shown.length - Math.min(fresh, shown.length));
    const added = shown.slice(old.length);
    const underflow = source && source.pendingUnderflow ? ` <span class="dg-pending">+${source.pendingUnderflow} held back</span>` : '';
    return `0.${emitted > shown.length ? '…' : ''}${old}<mark class="${added ? 'on' : ''}">${added}</mark>${underflow}`;
};

const statsText = (step, total, originalBytes) => {
    const parts = [`token ${step.index + 1}${total ? ` of ${total}` : ''}`, `<code>${esc(visible(step.piece, step.isEos))}</code>`, `p = ${pct(step.probability)}`, `${fmtBits(step.bits)} bits`];
    const sofar = `${fmtBits(step.cumulativeBits)} bits so far (${fmtBytes(Math.ceil(step.cumulativeBits / 8))})`;
    const original = originalBytes ? ` of ${originalBytes * 8} bits (${fmtBytes(originalBytes)}) in the original` : '';
    return { line: parts.join(' · '), total: sofar + original };
};

// Everything the page shows for step `pos` at progress `t` (0 to 1). Pure.
// One step plays as: the new layer fades in under the older ones (0 to 0.3),
// its chosen bar is highlighted (0.3 to 0.5), then the camera zooms into the
// chosen bar (0.6 to 1). Once the stack is full, every layer also slides up one
// row during the zoom and the oldest fades out. With reduced
// motion the frame is the settled one, with no zoom.
export const renderFrame = (steps, pos, t, { total = 0, originalBytes = 0, reducedMotion = false } = {}) => {
    if (!steps.length) return { svg: '', text: '', binary: '', line: '', total: '', ratio: 0, summary: '' };
    const
        frameT = reducedMotion ? 1 : t,
        e = ease(clamp(frameT / 0.3)),
        hold = clamp((frameT - 0.3) / 0.2),
        z = reducedMotion || steps[pos].isEos ? 0 : ease(clamp((frameT - 0.6) / 0.4)),
        step = steps[pos],
        view = cameraView(step, z),
        k = BAR_WIDTH / (view.to - view.from),
        frames = layerFrames(steps, pos, SLOTS + 1);
    // The newest layer spans the camera's [0, 1], so its chosen bar is at:
    const
        x0 = X0 - view.from * k,
        c = chosenOf(step),
        [a, b] = [x0 + c.lo * k, x0 + c.hi * k],
        exact = z >= 1 ? coderInterval(steps, pos) : zoomInterval(coderInterval(steps, pos - 1), view.from, view.to);
    let svg = axisSvg(exact, a, b, step, e);
    let stack = '';
    for (let i = frames.length - 1; i >= 0; i--) {
        const
            idx = Math.min(pos, SLOTS) - i - (pos >= SLOTS ? z : 0),
            y = ROW_TOP + idx * ROW_STEP + (i === 0 ? (1 - e) * 10 : 0),
            alpha = i === 0 ? e : fade(idx);
        if (alpha <= 0.005) continue;
        const { o, s } = frames[i];
        stack += layerSvg(steps[pos - i], X0 + (o - view.from) * k, s * k, y, alpha, i === 0 ? hold : 1, i === 0);
    }
    const bottom = ROW_TOP + SLOTS * ROW_STEP + ROW_HEIGHT;
    svg += `<defs><clipPath id="dg-clip"><rect x="${X0}" y="${ROW_TOP - 2}" width="${BAR_WIDTH}" height="${bottom - ROW_TOP + 4}"/></clipPath></defs><g clip-path="url(#dg-clip)">${stack}</g>`;
    // Dotted lines from the axis along the edges of the newest layer's chosen bar.
    for (const x of [a, b])
        if (x >= X0 && x <= X0 + BAR_WIDTH)
            svg += `<line class="dg-guide" opacity="${e.toFixed(3)}" x1="${x.toFixed(1)}" y1="${AXIS_Y}" x2="${x.toFixed(1)}" y2="${bottom}"/>`;
    svg += legendSvg();
    const
        stats = statsText(step, total, originalBytes),
        original = originalBytes ? originalBytes * 8 : 0;
    return {
        svg,
        text: textHtml(steps, pos, frameT),
        binary: binaryHtml(steps, pos, frameT),
        line: stats.line,
        total: stats.total,
        ratio: original ? clamp(step.cumulativeBits / original) : 0,
        summary: `token ${step.index + 1}${total ? ` of ${total}` : ''}, ${fmtBits(step.bits)} bits`
    };
};

// ---- the DOM ---------------------------------------------------------------

const TEMPLATE = `
<div class="dg-text" aria-hidden="true"></div>
<div class="dg-binary" aria-hidden="true"></div>
<svg class="dg-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true" focusable="false"></svg>
<div class="dg-stats" aria-hidden="true"><div class="dg-line"></div><div class="dg-total"></div><div class="dg-ratio"><i></i></div></div>
<div class="dg-controls">
  <button type="button" data-dg="restart" aria-label="Restart">Restart</button>
  <button type="button" data-dg="back" aria-label="Previous step">Back</button>
  <button type="button" data-dg="play" aria-label="Pause">Pause</button>
  <button type="button" data-dg="step" aria-label="Next step">Step</button>
  <label>Speed <select data-dg="speed" aria-label="Playback speed"></select></label>
  <button type="button" data-dg="live" aria-label="Skip to the newest step" hidden>Skip to latest</button>
  <span class="dg-buffer muted small"></span>
</div>
<div class="dg-tip" aria-hidden="true" hidden></div>
<div class="dg-live" role="status" aria-live="polite"></div>`;

// Builds the diagram inside `root`. Returns the controls of the diagram.
export const createDiagram = root => {
    const player = createPlayer();
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    let context = { total: 0, originalBytes: 0 };
    let raf = 0, last = 0, drawn = '', announced = 0, announcedText = '', pendingSummary = '';

    root.classList.add('dg');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Arithmetic coding diagram');
    root.innerHTML = TEMPLATE;
    const $ = sel => root.querySelector(sel);
    const el = {
        text: $('.dg-text'), binary: $('.dg-binary'), svg: $('.dg-svg'), line: $('.dg-line'), total: $('.dg-total'),
        ratio: $('.dg-ratio i'), live: $('.dg-live'), play: $('[data-dg=play]'), speed: $('[data-dg=speed]'),
        skip: $('[data-dg=live]'), buffer: $('.dg-buffer'), tip: $('.dg-tip')
    };
    el.speed.innerHTML = SPEEDS.map(s => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s === 'max' ? 'fastest' : `${s}x`}</option>`).join('');

    // The tooltip is HTML, so the token can sit in a code element. The SVG is
    // rebuilt on every frame, so the bar under the pointer is looked up again
    // after each draw as well as on every pointer move.
    let pointer = null;
    const showTip = () => {
        const target = pointer && document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-piece], [data-other]');
        if (!target || !el.svg.contains(target)) {
            el.tip.hidden = true;
            return;
        }
        el.tip.innerHTML = target.dataset.piece === undefined
            ? esc(target.dataset.other)
            : `<code>${esc(target.dataset.piece)}</code> ${esc(target.dataset.p)}`;
        el.tip.hidden = false;
        const box = root.getBoundingClientRect();
        const left = Math.min(pointer.x - box.left + 14, box.width - el.tip.offsetWidth - 4);
        el.tip.style.left = `${Math.max(4, left)}px`;
        el.tip.style.top = `${pointer.y - box.top + 18}px`;
    };
    el.svg.addEventListener('pointermove', event => {
        pointer = { x: event.clientX, y: event.clientY };
        showTip();
    });
    el.svg.addEventListener('pointerleave', () => {
        pointer = null;
        showTip();
    });

    const announce = (force = false) => {
        const now = Date.now();
        if (!pendingSummary || pendingSummary === announcedText) return;
        // A screen reader cannot follow a step every 100 ms at high speed.
        if (!force && now - announced < 1500) return;
        announced = now;
        announcedText = pendingSummary;
        el.live.textContent = pendingSummary;
    };

    const draw = () => {
        const label = player.playing ? 'Pause' : 'Play';
        el.play.textContent = label;
        el.play.setAttribute('aria-label', label);
        const buffered = player.buffered();
        el.skip.hidden = buffered < 3;
        el.buffer.textContent = player.steps.length
            ? `${player.pos + 1} of ${player.steps.length}${player.final ? '' : ' so far'}${buffered > 0 ? `, ${buffered} waiting` : ''}`
            : 'Waiting for the first token';
        if (!player.steps.length) return;
        const key = `${player.pos}:${Math.round(player.t * 90)}:${player.steps.length}`;
        if (key === drawn) return;
        drawn = key;
        const frame = renderFrame(player.steps, player.pos, player.t, { ...context, reducedMotion: !!reduce?.matches });
        el.svg.innerHTML = frame.svg;
        if (pointer) showTip();
        el.text.innerHTML = frame.text;
        el.binary.innerHTML = frame.binary;
        el.line.innerHTML = frame.line;
        el.total.textContent = frame.total;
        el.ratio.style.width = `${(frame.ratio * 100).toFixed(1)}%`;
        pendingSummary = frame.summary;
        announce(!player.playing);
    };

    const loop = now => {
        raf = 0;
        const dt = Math.min(100, now - (last || now));
        last = now;
        player.advance(dt);
        draw();
        if (player.playing) raf = requestAnimationFrame(loop);
        else last = 0;
    };
    // Starts the loop when playing, and redraws once otherwise.
    const kick = () => {
        draw();
        if (player.playing && !raf) raf = requestAnimationFrame(loop);
    };

    root.addEventListener('click', event => {
        const button = event.target.closest('button[data-dg]');
        if (!button) return;
        const act = button.dataset.dg;
        if (act === 'play') player.playing ? player.pause() : player.play();
        if (act === 'step') player.step();
        if (act === 'back') player.back();
        if (act === 'restart') player.restart();
        if (act === 'live') {
            player.live();
            player.playing = true;
        }
        drawn = '';
        kick();
    });
    el.speed.addEventListener('change', () => {
        player.speed = el.speed.value === 'max' ? 'max' : Number(el.speed.value);
    });

    return {
        player,
        // Starts a new run. `total` is the token count when known and `originalBytes` the input size.
        reset: (next = {}) => {
            player.reset();
            context = { total: next.total || 0, originalBytes: next.originalBytes || 0 };
            drawn = '';
            announcedText = '';
            el.live.textContent = '';
            el.svg.innerHTML = el.text.innerHTML = el.binary.innerHTML = el.line.innerHTML = el.total.textContent = '';
            el.ratio.style.width = '0';
            player.playing = true;
            kick();
        },
        push: steps => {
            player.push(steps);
            kick();
        },
        finish: () => {
            player.final = true;
            kick();
        },
        // Plays a recorded run from its first step.
        load: (steps, next = {}) => {
            player.reset();
            context = { total: next.total || steps.length, originalBytes: next.originalBytes || 0 };
            player.push(steps);
            player.final = true;
            player.playing = true;
            drawn = '';
            kick();
        },
        setTotal: total => {
            context.total = total;
        },
        destroy: () => {
            if (raf) cancelAnimationFrame(raf);
            root.innerHTML = '';
        }
    };
};
