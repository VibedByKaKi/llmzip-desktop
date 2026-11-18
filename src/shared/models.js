// Models offered in the in-app downloader. All are base (non-instruct) GGUF
// files from QuantFactory's ungated mirrors on Hugging Face. Size and SHA-256
// come from the Hugging Face file listing, so the backend can verify each
// download. Shared by the page and the backend.
export const MODELS = [
  {
    id: 'smollm2-135m',
    name: 'SmolLM2 135M',
    quant: 'Q8_0',
    file: 'SmolLM2-135M.Q8_0.gguf',
    url: 'https://huggingface.co/QuantFactory/SmolLM2-135M-GGUF/resolve/main/SmolLM2-135M.Q8_0.gguf',
    size: 144810464,
    sha256: 'b761d9ccdfce67726e41ca2ef30e9dfbcf6a32ca2aaef47df5c049ec362d04cd',
    note: 'Fastest. Good for trying the app. Modest compression.',
  },
  {
    id: 'qwen2.5-0.5b',
    name: 'Qwen2.5 0.5B',
    quant: 'Q4_K_M',
    file: 'Qwen2.5-0.5B.Q4_K_M.gguf',
    url: 'https://huggingface.co/QuantFactory/Qwen2.5-0.5B-GGUF/resolve/main/Qwen2.5-0.5B.Q4_K_M.gguf',
    size: 397807488,
    sha256: 'b556a76bfad26a83bc59c1c981bc3c72b88978cc21bb6e6321f7168ff9f22f38',
    note: 'Small and quick. Handles code and several languages.',
  },
  {
    id: 'llama-3.2-1b',
    name: 'Llama 3.2 1B',
    quant: 'Q4_K_M',
    file: 'Llama-3.2-1B.Q4_K_M.gguf',
    url: 'https://huggingface.co/QuantFactory/Llama-3.2-1B-GGUF/resolve/main/Llama-3.2-1B.Q4_K_M.gguf',
    size: 807690208,
    sha256: 'ac81ee4bf5b82d94f380a87fd48560254b970107a94b6f228b2a36991853af60',
    note: 'Balanced choice for English text.',
  },
  {
    id: 'qwen2.5-3b',
    name: 'Qwen2.5 3B',
    quant: 'Q4_K_M',
    file: 'Qwen2.5-3B.Q4_K_M.gguf',
    url: 'https://huggingface.co/QuantFactory/Qwen2.5-3B-GGUF/resolve/main/Qwen2.5-3B.Q4_K_M.gguf',
    size: 1929902560,
    sha256: 'ed388ea2b4035d2251bbec830139facda743b87b03cf30c35d99c793729e34e5',
    note: 'Better compression, several times slower than the 0.5B model.',
  },
  {
    id: 'llama-3.1-8b',
    name: 'Llama 3.1 8B',
    quant: 'Q4_K_M',
    file: 'Meta-Llama-3.1-8B.Q4_K_M.gguf',
    url: 'https://huggingface.co/QuantFactory/Meta-Llama-3.1-8B-GGUF/resolve/main/Meta-Llama-3.1-8B.Q4_K_M.gguf',
    size: 4920733856,
    sha256: 'e7488c6e62b37e5763cf6f83e4324169c0f7569a03ef0b15c9ca0b0ceea1611b',
    note: 'Best ratio here. Needs about 6 GB of RAM and a lot of patience on a CPU.',
  },
];
