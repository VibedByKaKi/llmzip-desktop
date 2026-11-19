// The llama.cpp release that llama-zip.js binds and was tested with. Its struct layouts are
// written by hand for that llama.h, so the binding refuses other versions.
export const TESTED_VERSION = '1.0.0';
export const TESTED_BUILD = 12359;
export const TESTED_TEXT = `${TESTED_VERSION} (build ${TESTED_BUILD})`;

// Prebuilt libllama from the llama.cpp GitHub release of the tested build. These are the CPU
// builds, because the app keeps every operation on the CPU. `sha256` is the digest GitHub shows
// for the asset. Keys are `${tiny.system.os()}-${await tiny.system.architecture()}`. The Unix
// archives hold one folder (`llama-b12359/`) that the install strips, the Windows ZIPs are flat.
export const PREBUILT_TAG = `b${TESTED_BUILD}`;
const asset = name => `https://github.com/ggml-org/llama.cpp/releases/download/${PREBUILT_TAG}/llama-${PREBUILT_TAG}-bin-${name}`;
export const PREBUILT = {
    'macos-arm64': { url: asset('macos-arm64.tar.gz'), sha256: '82b00abc740160e1b9980e6cc79c117345fa34af058c80e6c0a69aa8ddccde75', size: 16907811, strip: true },
    'macos-x86_64': { url: asset('macos-x64.tar.gz'), sha256: '25320d529077ef5a3d16e7b5da26438f221d88c8c0930a32b0c79457f5eede56', size: 12661621, strip: true },
    'linux-x86_64': { url: asset('ubuntu-x64.tar.gz'), sha256: '0bc1f091e8916102b6d8f2cf944233a620e90a0f856c72d0ce41150c65c2e72e', size: 23311084, strip: true },
    'linux-arm64': { url: asset('ubuntu-arm64.tar.gz'), sha256: 'dc7aa17a67884619b7223870aca9fd6addbc01717713b04a714add1c31137359', size: 18949862, strip: true },
    'windows-x86_64': { url: asset('win-cpu-x64.zip'), sha256: '837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69', size: 25097509, strip: false },
    'windows-arm64': { url: asset('win-cpu-arm64.zip'), sha256: 'd27564c754478d2832789dfcebfc5ace018e36a224c41d810b7cbc1ba8243ec0', size: 13455326, strip: false }
};
