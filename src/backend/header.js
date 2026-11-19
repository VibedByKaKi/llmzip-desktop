// The header of an .llmz file.
//
// A file is the magic "LLMZ", one version byte, the header length as a varint,
// the header, then the coder's output. Version 2 headers are JSON with a 4-byte
// length. Version 3 headers are binary, which makes them about a fifth of the
// size. Version 3 stores:
//
//   varint  original size
//   varint  token count
//   8 bytes SHA-256 of the original, truncated
//   string  original name
//   string  model name
//   varint  model size
//   8 bytes model fingerprint, truncated
//   varint  nCtx, nCtxUsed, overlapTokens
//   zigzag  gpuLayers (it can be -1)
//   varint  nThreads, nBatch
//   string  llama.cpp build
//   4 bytes digest of the CPU feature string
//
// A varint is 7 bits per byte, least significant first, with the high bit set
// on every byte but the last. A string is a varint length and UTF-8 bytes.

export const
    FORMAT_VERSION = 3,
    // Whether a hex hash from a header (any length) is a prefix of the full hex hash.
    hashMatches = (full, stored) => full.startsWith(stored),
    varint = number => {
        const out = [];
        for (; number >= 0x80; number = Math.floor(number / 0x80)) out.push(number % 0x80 | 0x80);
        out.push(number);
        return out;
    },
    // Reads the magic, the version and the header length. Returns null when the bytes are not an .llmz file.
    // `start` is where the header begins.
    readPreamble = bytes => {
        if (bytes.length < 6 || MAGIC.some((byte, i) => bytes[i] !== byte)) return null;
        const version = bytes[4];
        if (version <= 2) {
            if (bytes.length < 9) return null;
            return { version, length: new DataView(bytes.buffer, bytes.byteOffset).getUint32(5, true), start: 9 };
        }
        let length = 0, i = 5;
        for (let scale = 1; i < bytes.length; i++, scale *= 0x80) {
            length += (bytes[i] & 0x7f) * scale;
            if (!(bytes[i] & 0x80)) return { version, length, start: i + 1 };
        }
        return null;
    },
    // The bytes that come before the header of a new file.
    writePreamble = length => new Uint8Array([...MAGIC, FORMAT_VERSION, ...varint(length)]),
    // meta: { size, tokens, sha256, name, model: { name, size, sha256 }, params, llama: { build, systemDigest } }.
    // The hashes are hex strings, which are truncated.
    encodeHeader = meta => {
        const out = [];
        const string = text => {
            const bytes = enc.encode(text);
            out.push(...varint(bytes.length), ...bytes);
        };
        const { params, model, llama } = meta;
        out.push(...varint(meta.size), ...varint(meta.tokens), ...hexToBytes(meta.sha256, HASH_BYTES));
        string(meta.name);
        string(model.name);
        out.push(...varint(model.size), ...hexToBytes(model.sha256, HASH_BYTES));
        out.push(...varint(params.nCtx), ...varint(params.nCtxUsed), ...varint(params.overlapTokens));
        out.push(...varint(params.gpuLayers < 0 ? -params.gpuLayers * 2 - 1 : params.gpuLayers * 2));
        out.push(...varint(params.nThreads), ...varint(params.nBatch));
        string(llama.build);
        out.push(...hexToBytes(llama.systemDigest, DIGEST_BYTES));
        return new Uint8Array(out);
    },
    // Turns header bytes of any version into the meta object the rest of the app uses.
    decodeHeader = (version, bytes) => {
        if (version <= 2) return JSON.parse(dec.decode(bytes));
        let pos = 0;
        const number = () => {
            let value = 0;
            for (let scale = 1; ; scale *= 0x80) {
                if (pos >= bytes.length) throw new Error('Truncated header');
                const byte = bytes[pos++];
                value += (byte & 0x7f) * scale;
                if (!(byte & 0x80)) return value;
            }
        };
        const take = length => {
            if (pos + length > bytes.length) throw new Error('Truncated header');
            return bytes.subarray(pos, (pos += length));
        };
        const string = () => dec.decode(take(number()));
        const size = number(), tokens = number(), sha256 = bytesToHex(take(HASH_BYTES));
        const name = string();
        const model = { name: string(), size: number(), sha256: bytesToHex(take(HASH_BYTES)) };
        const nCtx = number(), nCtxUsed = number(), overlapTokens = number();
        const zigzag = number();
        const gpuLayers = zigzag % 2 ? -(zigzag + 1) / 2 : zigzag / 2;
        const nThreads = number(), nBatch = number();
        const llama = { build: string(), systemDigest: bytesToHex(take(DIGEST_BYTES)) };
        return {
            v: version, engine: ENGINE, name, size, sha256, tokens, model,
            params: { nCtx, nCtxUsed, overlapTokens, gpuLayers, nThreads, nBatch },
            llama
        };
    };

const
    enc = new TextEncoder(),
    dec = new TextDecoder('utf-8', { fatal: true }),
    HASH_BYTES = 8,
    DIGEST_BYTES = 4,
    ENGINE = 'llama-zip.js',
    MAGIC = new Uint8Array([0x4c, 0x4c, 0x4d, 0x5a]), // "LLMZ"
    hexToBytes = (hex, length) => {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return bytes;
    },
    bytesToHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
