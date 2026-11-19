// Headless tests of the .llmz header. Run with `tjs run src/backend/header.test.js`.
import { decodeHeader, encodeHeader, FORMAT_VERSION, hashMatches, readPreamble, varint, writePreamble } from './header.js';

const
    fail = message => {
        console.log(`FAIL ${message}`);
        tjs.exit(1);
    },
    same = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
    },
    sample = {
        name: 'text.txt',
        size: 327,
        sha256: 'ff4fd323d3f78cb5f231a7d1cbb4adf8897496392095b81c7c9d1146af1ebb44',
        tokens: 68,
        model: { name: 'SmolLM2-135M.Q8_0.gguf', size: 144810464, sha256: 'eb44c24bac4506300d47fde8988addde' },
        params: { nCtx: 0, nCtxUsed: 8192, overlapTokens: 0, gpuLayers: 0, nThreads: 4, nBatch: 512 },
        llama: { build: '1.0.0 (build 12359)', systemDigest: 'a1b2c3d4' }
    };

// varints
same(varint(0), [0], 'varint 0');
same(varint(127), [127], 'varint 127');
same(varint(128), [0x80, 1], 'varint 128');
same(varint(300), [0xac, 2], 'varint 300');

// round trip
const bytes = encodeHeader(sample);
const meta = decodeHeader(FORMAT_VERSION, bytes);
same(meta.name, sample.name, 'name');
same(meta.size, sample.size, 'size');
same(meta.tokens, sample.tokens, 'tokens');
same(meta.sha256, sample.sha256.slice(0, 16), 'sha256 is truncated to 8 bytes');
same(meta.model, { ...sample.model, sha256: sample.model.sha256.slice(0, 16) }, 'model');
same(meta.params, sample.params, 'params');
same(meta.llama, sample.llama, 'llama');
same(meta.engine, 'llama-zip.js', 'engine');
if (!hashMatches(sample.sha256, meta.sha256)) fail('a truncated hash matches the full one');
if (hashMatches(sample.sha256.replace(/^ff/, '00'), meta.sha256)) fail('another hash does not match');

// edge values: negative GPU layers, a big size, a non-ASCII name
const edge = { ...sample, name: 'données-é日本.bin', size: 2 ** 40 + 5, params: { ...sample.params, gpuLayers: -1, nCtx: 1000000 } };
const edgeMeta = decodeHeader(FORMAT_VERSION, encodeHeader(edge));
same([edgeMeta.name, edgeMeta.size, edgeMeta.params.gpuLayers, edgeMeta.params.nCtx], [edge.name, edge.size, -1, 1000000], 'edge values');
same(decodeHeader(FORMAT_VERSION, encodeHeader({ ...sample, params: { ...sample.params, gpuLayers: 33 } })).params.gpuLayers, 33, 'positive gpuLayers');

// truncated headers throw
let threw = false;
try {
    decodeHeader(FORMAT_VERSION, bytes.subarray(0, bytes.length - 3));
}
catch {
    threw = true;
}
if (!threw) fail('a truncated header throws');

// preamble
const preamble = writePreamble(bytes.length);
same(readPreamble(new Uint8Array([...preamble, 1, 2, 3])), { version: FORMAT_VERSION, length: bytes.length, start: preamble.length }, 'preamble');
same(readPreamble(new Uint8Array([1, 2, 3, 4, 5, 6, 7])), null, 'not an llmz file');
const v2 = new Uint8Array([0x4c, 0x4c, 0x4d, 0x5a, 2, 0x10, 0, 0, 0]);
same(readPreamble(v2), { version: 2, length: 16, start: 9 }, 'version 2 preamble');
const json = new TextEncoder().encode(JSON.stringify({ name: 'a', size: 1 }));
same(decodeHeader(2, json), { name: 'a', size: 1 }, 'version 2 json header');

console.log(`header: ${bytes.length} bytes for the sample, preamble ${preamble.length} bytes`);
console.log('all passed');
