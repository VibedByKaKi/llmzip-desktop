// The arithmetic coding diagram, after the one in the 3Blue1Brown video
// "This algorithm changed how I think about compression" (about 23:00 to 25:00).
//
// It draws the step stream of llama-zip.js (see "Observing the coder" in its
// README): the text so far with the current token highlighted, the binary
// number that grows as bits are settled, a number line with the coder's
// interval, and stacked layers of probability bars. Each layer splits the
// chosen bar of the layer above, and the view zooms into the chosen bar.
//
// Three parts, so the logic runs without a page:
//   createPlayer()  queue, position, speed and the clock of the animation
//   renderFrame()   a step list and a position to strings of SVG and HTML
//   createDiagram() the DOM, the controls and the requestAnimationFrame loop
// Colours come from the page's CSS variables through classes in style.css.
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 'max'];

const
    WIDTH = 720,
    HEIGHT = 282,
    X0 = 20,
    BAR_WIDTH = 680,
    ROW_TOP = 74,
    ROW_STEP = 64,
    ROW_HEIGHT = 34,
    STEP_MS = 1600,
    MAX_STEP_MS = 40,
    MAX_KEPT_STEPS = 2000,
    TEXT_CHARS = 300,
    BIN_CHARS = 64,
    TWO_POW_64 = 18446744073709551616;

const
    clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x)),
    lerp = (a, b, k) => a + (b - a) * k,
    ease = k => k * k * (3 - 2 * k),
    esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])),
    // Whitespace made visible, as the video does, and a name for the end token.
    visible = (piece, isEos) => isEos ? '[end]' : piece.replace(/ /g, '␣').replace(/\n/g, '↵').replace(/\t/g, '⇥'),
    fraction = hex => Number(BigInt(`0x${hex}`)) / TWO_POW_64,
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

// ---- frame -----------------------------------------------------------------

const barLabel = (candidate, x, w, y) => {
    const text = visible(candidate.piece, false);
    const fit = Math.floor((w - 6) / 6.6);
    if (fit < 2 || !text) return '';
    const shown = text.length > fit ? `${text.slice(0, fit - 1)}…` : text;
    return `<text class="dg-label${candidate.chosen ? ' dg-label-chosen' : ''}" x="${(x + w / 2).toFixed(1)}" y="${(y + ROW_HEIGHT / 2 + 4).toFixed(1)}" text-anchor="middle">${esc(shown)}</text>`;
};

// One layer: the candidate bars laid over the grey track that stands for all
// the other tokens. `dim` fades the bars that were not chosen.
const layerSvg = (step, y, alpha, dim) => {
    let out = `<g opacity="${alpha.toFixed(3)}"><rect class="dg-track" x="${X0}" y="${y.toFixed(1)}" width="${BAR_WIDTH}" height="${ROW_HEIGHT}" rx="3"/>`;
    step.candidates.forEach((candidate, i) => {
        const w = Math.max(1.5, (candidate.hi - candidate.lo) * BAR_WIDTH);
        const x = X0 + candidate.lo * BAR_WIDTH;
        const opacity = candidate.chosen ? 1 : 1 - 0.65 * dim;
        out += `<rect class="dg-bar${i % 2 ? ' dg-alt' : ''}${candidate.chosen ? ' dg-chosen' : ''}" x="${x.toFixed(2)}" y="${y.toFixed(1)}" width="${w.toFixed(2)}" height="${ROW_HEIGHT}" opacity="${opacity.toFixed(3)}"/>`;
        if (w < 8 && candidate.chosen)
            out += `<rect class="dg-pin" x="${(x + w / 2 - 1).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="2" height="${ROW_HEIGHT + 10}"/>`;
        else
            out += barLabel(candidate, x, w, y);
    });
    return `${out}</g>`;
};

const chosenOf = step => step.candidates.find(candidate => candidate.chosen);

// The sub-interval of the layer above, stretched to the full width of the layer below.
const linkSvg = (upper, yUpper, yLower, alpha) => {
    const c = chosenOf(upper);
    const a = X0 + c.lo * BAR_WIDTH, b = X0 + c.hi * BAR_WIDTH;
    return `<polygon class="dg-link" opacity="${alpha.toFixed(3)}" points="${a.toFixed(1)},${(yUpper + ROW_HEIGHT).toFixed(1)} ${b.toFixed(1)},${(yUpper + ROW_HEIGHT).toFixed(1)} ${X0 + BAR_WIDTH},${yLower.toFixed(1)} ${X0},${yLower.toFixed(1)}"/>`;
};

// Number line of the coder's 64-bit interval. The whole message narrows [0, 1]
// to 2^-bits, far below what a drawing can show, so the line shows the window
// the coder keeps and the caption gives the real width.
const lineSvg = (steps, pos, t) => {
    const step = steps[pos];
    const prev = pos > 0 ? steps[pos - 1] : null;
    const [lo1, hi1] = [fraction(step.coderLow), fraction(step.coderHigh)];
    const [lo0, hi0] = prev ? [fraction(prev.coderLow), fraction(prev.coderHigh)] : [0, 1];
    const k = ease(clamp((t - 0.4) / 0.5));
    const lo = lerp(lo0, lo1, k), hi = lerp(hi0, hi1, k);
    const x = X0 + lo * BAR_WIDTH, w = Math.max(2, (hi - lo) * BAR_WIDTH);
    return `<text class="dg-caption" x="${X0}" y="12">Number line: the coder's interval. All tokens so far narrow [0, 1] to a width of 2^-${fmtBits(step.cumulativeBits)}.</text>` +
        `<line class="dg-axis" x1="${X0}" y1="34" x2="${X0 + BAR_WIDTH}" y2="34"/>` +
        `<rect class="dg-range" x="${x.toFixed(1)}" y="26" width="${w.toFixed(1)}" height="16" rx="2"/>` +
        `<text class="dg-tick" x="${X0}" y="58" text-anchor="start">0</text><text class="dg-tick" x="${X0 + BAR_WIDTH}" y="58" text-anchor="end">1</text>`;
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
export const renderFrame = (steps, pos, t, { total = 0, originalBytes = 0, reducedMotion = false } = {}) => {
    if (!steps.length) return { svg: '', text: '', binary: '', line: '', total: '', ratio: 0, summary: '' };
    const frameT = reducedMotion ? 1 : t;
    const e = ease(clamp(frameT / 0.35));
    const hold = clamp((frameT - 0.35) / 0.25);
    const z = ease(clamp((frameT - 0.7) / 0.3));
    const step = steps[pos];
    const slotY = r => ROW_TOP + ((r - pos) + 2 + (1 - e)) * ROW_STEP;
    let svg = lineSvg(steps, pos, frameT);
    for (let r = Math.max(0, pos - 3); r <= pos; r++) {
        const alpha = r === pos ? e : r === pos - 3 ? 1 - e : 1;
        const dim = r === pos ? hold : 1;
        if (r < pos) svg += linkSvg(steps[r], slotY(r), slotY(r + 1), r === pos - 3 ? 1 - e : 1);
        svg += layerSvg(steps[r], slotY(r), alpha, dim);
    }
    // The zoom into the chosen bar, which the next layer then replaces.
    if (!step.isEos && z > 0) {
        const c = chosenOf(step);
        const yTop = slotY(pos) + ROW_HEIGHT;
        const yBottom = yTop + 6 + (ROW_STEP - ROW_HEIGHT - 6) * z;
        const a = X0 + c.lo * BAR_WIDTH, b = X0 + c.hi * BAR_WIDTH;
        svg += `<polygon class="dg-link" points="${a.toFixed(1)},${yTop.toFixed(1)} ${b.toFixed(1)},${yTop.toFixed(1)} ${lerp(b, X0 + BAR_WIDTH, z).toFixed(1)},${yBottom.toFixed(1)} ${lerp(a, X0, z).toFixed(1)},${yBottom.toFixed(1)}"/>`;
    }
    const stats = statsText(step, total, originalBytes);
    const original = originalBytes ? originalBytes * 8 : 0;
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
        skip: $('[data-dg=live]'), buffer: $('.dg-buffer')
    };
    el.speed.innerHTML = SPEEDS.map(s => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s === 'max' ? 'fastest' : `${s}x`}</option>`).join('');

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
