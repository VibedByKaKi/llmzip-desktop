# LZMA-JS (compression only)

`lzma-c.js` is `src/lzma-c.js` from the [`lzma` npm package](https://github.com/LZMA-JS/LZMA-JS), version 2.3.2, MIT license (see `LICENSE`). It is only used to measure how well LZMA compresses the same input, for comparison with the language model.

One change from upstream: the last line, `this.LZMA = this.LZMA_WORKER = LZMA;`, is replaced by `export default LZMA;`, because the file is imported as an ES module and `this` is undefined there.
