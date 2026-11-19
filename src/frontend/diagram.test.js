// Headless tests for diagram.js. Run with: tjs run src/frontend/diagram.test.js
// The fixture is a real trace (SmolLM2-135M Q8_0, 20 tokens, candidates cut to
// 5 per step) and the compressed bytes the same run produced.
import { Encoder } from '../backend/vendor/llama-zip.js/js/arithmetic.js';

import { axisTicks, coderInterval, createPlayer, renderFrame, zoomInterval } from './diagram.js';

let failures = 0;
const check = (ok, message) => {
    if (!ok) {
        failures++;
        console.log(`FAIL ${message}`);
    }
};
const hexToBig = hex => hex ? BigInt(`0x${hex}`) : 0n;

// The compressed number as a fraction c / 2^(8 * length), followed by zeros.
// True when lo / 2^shift <= number < hi / 2^shift.
const contains = (interval, compressed) => {
    const
        bits = BigInt(compressed.length / 2 * 8),
        value = hexToBig(compressed) << BigInt(interval.shift);
    return (interval.lo << bits) <= value && value < (interval.hi << bits);
};

const fixture = JSON.parse(new TextDecoder().decode(await tjs.readFile(new URL('./diagram.fixture.json', import.meta.url).pathname)));

// ---- the real trace ---------------------------------------------------------
{
    const
        { steps, compressed } = fixture,
        bitsOf = hex => [...hex].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join(''),
        output = bitsOf(compressed);
    let before = coderInterval(steps, -1);
    steps.forEach((step, i) => {
        const interval = coderInterval(steps, i);
        check(contains(interval, compressed), `real trace: step ${i} interval contains the compressed number`);
        // Each interval lies inside the one before: lo and hi on a common scale.
        const shift = BigInt(interval.shift - before.shift);
        check(interval.lo >= before.lo << shift && interval.hi <= before.hi << shift, `real trace: step ${i} is inside step ${i - 1}`);
        before = interval;
        // The finalised bits are the leading binary digits of both ends.
        const
            n = BigInt(step.emittedBits),
            prefix = hexToBig(step.outputBits ? BigInt(`0b${step.outputBits}`).toString(16) : '');
        check(interval.lo >> (BigInt(interval.shift) - n) === prefix && (interval.hi - 1n) >> (BigInt(interval.shift) - n) === prefix, `real trace: step ${i} ends start with the emitted bits`);
    });
    const last = steps[steps.length - 1];
    check(last.outputBits === output.slice(0, last.emittedBits), 'real trace: the last step\'s bits are the start of the output');
    const interval = coderInterval(steps, steps.length - 1);
    // The interval at the end is narrower than the bits it has not settled: 2^-(n + 1) or so.
    check(interval.hi - interval.lo < 1n << BigInt(interval.shift - last.emittedBits + 1), 'real trace: the last interval is narrower than one emitted bit');
    // The bits line of the page shows the same digits.
    check(renderFrame(steps, steps.length - 1, 1).binary.replace(/<[^>]*>/g, '').includes(last.outputBits.slice(0, 40)), 'real trace: the binary line shows the emitted bits');
}

// ---- a long synthetic stream with held-back bits ------------------------------
const synthetic = count => {
    const
        encoder = new Encoder(),
        steps = [];
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    let emitted = 0, cumulative = 0, bits = '';
    const FREQ = 2 ** 32;
    for (let i = 0; i < count; i++) {
        // Chosen symbol with a probability that is often tiny, and splits near one half
        // so the window straddles the middle and holds bits back.
        const
            p = random() < 0.3 ? 1e-7 + random() * 1e-5 : random() < 0.5 ? 0.45 + random() * 0.1 : random(),
            lo = random() * (1 - p),
            cdf = [Math.round(lo * FREQ), Math.round((lo + p) * FREQ), FREQ];
        encoder.encodeSymbol(cdf, 1);
        const
            bytes = encoder.getEncoded(),
            all = [...bytes].map(b => b.toString(2).padStart(8, '0')).join('').slice(0, encoder.bitCount),
            newBits = all.slice(emitted);
        emitted = encoder.bitCount;
        const probability = (cdf[1] - cdf[0]) / FREQ;
        cumulative -= Math.log2(probability);
        bits = all;
        steps.push({
            index: i, tokenId: 100 + i, piece: `t${i}`, pieceBytes: null, isEos: false, probability, bits: -Math.log2(probability), cumulativeBits: cumulative,
            lo: cdf[0] / FREQ, hi: cdf[1] / FREQ,
            candidates: [
                { tokenId: 100 + i, piece: `t${i}`, p: probability, lo: cdf[0] / FREQ, hi: cdf[1] / FREQ, chosen: true },
                { tokenId: 7, piece: 'x', p: 0.01, lo: 0, hi: Math.min(0.01, cdf[0] / FREQ), chosen: false }
            ],
            otherProbability: 0.1, emittedBits: emitted, newBits, outputBits: all.slice(-256), pendingUnderflow: encoder.numUnderflow,
            coderLow: encoder.low.toString(16).padStart(16, '0'), coderHigh: encoder.high.toString(16).padStart(16, '0'),
            windowIndex: 0, windowReset: false, contextLength: i
        });
    }
    encoder.finish();
    const compressed = [...encoder.getEncoded()].map(b => b.toString(16).padStart(2, '0')).join('');
    return { steps, compressed, bits };
};

{
    const
        { steps, compressed } = synthetic(1500),
        held = Math.max(...steps.map(step => step.pendingUnderflow));
    check(held > 0, `synthetic: the stream holds bits back (most held ${held})`);
    check(steps.length === 1500 && steps[1499].emittedBits > 256, 'synthetic: more than 256 bits, so outputBits is capped');
    steps.forEach((step, i) => {
        if (!contains(coderInterval(steps, i), compressed)) check(false, `synthetic: step ${i} interval contains the compressed number`);
    });
    // The prefix kept across steps rebuilds the whole stream, beyond the 256 bit cap.
    const
        last = steps[1499],
        interval = coderInterval(steps, 1499),
        n = BigInt(last.emittedBits),
        top = interval.lo >> (BigInt(interval.shift) - n);
    check(top.toString(2).padStart(last.emittedBits, '0') === [...compressed].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('').slice(0, last.emittedBits), 'synthetic: the emitted bits of the whole stream are the start of the output');
    // Frames are finite and repeatable, also at the bottom of a very deep zoom.
    const bad = /NaN|undefined|Infinity/;
    for (const pos of [0, 1, 2, 10, 700, 1499])
        for (const t of [0, 0.1, 0.29, 0.31, 0.5, 0.59, 0.61, 0.8, 0.99, 1])
            for (const reducedMotion of [false, true]) {
                const
                    a = renderFrame(steps, pos, t, { total: 1500, originalBytes: 4000, reducedMotion }),
                    b = renderFrame(steps, pos, t, { total: 1500, originalBytes: 4000, reducedMotion });
                check(JSON.stringify(a) === JSON.stringify(b), `synthetic: frame ${pos} at ${t} is deterministic`);
                check(!bad.test(a.svg + a.text + a.binary + a.line + a.total), `synthetic: frame ${pos} at ${t} has no NaN`);
            }
    const started = Date.now();
    for (let i = 0; i < 100; i++) renderFrame(steps, 1499, i / 100);
    console.log(`info  renderFrame at step 1500 (${last.emittedBits} bits): ${((Date.now() - started) / 100).toFixed(2)} ms per frame`);
}

// ---- frames of the real trace --------------------------------------------------
{
    const
        { steps } = fixture,
        bad = /NaN|undefined|Infinity/;
    steps.forEach((step, pos) => {
        for (const t of [0, 0.2, 0.4, 0.7, 0.9, 1]) {
            const frame = renderFrame(steps, pos, t);
            check(!bad.test(frame.svg), `real trace: frame ${pos} at ${t} has no NaN`);
            check(frame.summary === `token ${pos + 1}, ${frame.summary.split(', ')[1]}`, 'real trace: the summary keeps its format');
        }
    });
    check(renderFrame(steps, 3, 0.5).svg.includes('other tokens (not individually listed)'), 'the others are labelled');
    check(renderFrame(steps, 3, 0.5).svg === renderFrame(steps, 3, 0.5).svg, 'frames repeat');
    // Reduced motion: the same frame at any t.
    check(renderFrame(steps, 3, 0.1, { reducedMotion: true }).svg === renderFrame(steps, 3, 0.9, { reducedMotion: true }).svg, 'reduced motion has no animation');
    // The player extends the exact state as steps arrive.
    const player = createPlayer();
    player.push(steps.slice(0, 5));
    player.push(steps.slice(5));
    check(coderInterval(player.steps, 19).lo === coderInterval(steps, 19).lo, 'the player keeps the interval across pushes');
}

// ---- tick labels ------------------------------------------------------------------
{
    const whole = axisTicks({ lo: 0n, hi: 1n << 65n, shift: 65 });
    check(whole.ticks.map(tick => `${tick.whole}.${tick.fraction}`).join(' ') === '0.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9', 'the whole line is ticked in tenths');
    // A narrow view: decimals from 0.698251914945 to 0.698251914965, built from exact fractions.
    const
        shift = 120,
        scaled = decimal => (BigInt(decimal) << BigInt(shift)) / 10n ** 12n,
        view = { lo: scaled('698251914945'), hi: scaled('698251914965'), shift },
        { digits, ticks } = axisTicks(view);
    check(digits >= 12 && ticks.length >= 6, `a narrow view has more digits (${digits}) and ${ticks.length} ticks`);
    ticks.forEach(tick => {
        const
            value = BigInt(tick.whole + tick.fraction),
            exact = ((value << BigInt(shift)) / 10n ** BigInt(digits) - view.lo) * 1000000n / (view.hi - view.lo);
        check(Math.abs(Number(exact) / 1e6 - tick.at) < 1e-5, `tick ${tick.whole}.${tick.fraction} is at ${tick.at}`);
        check(tick.fraction.startsWith('69825191494') || tick.fraction.startsWith('69825191495') || tick.fraction.startsWith('69825191496'), `tick ${tick.fraction} is inside the view`);
    });
    const half = zoomInterval({ lo: 0n, hi: 1n << 65n, shift: 65 }, 0.25, 0.5);
    check(half.hi === half.lo * 2n && half.lo * 4n === (1n << 117n), 'zoomInterval takes a quarter and a half');
}

console.log(failures ? `${failures} failed` : 'all passed');
tjs.exit(failures ? 1 : 0);
