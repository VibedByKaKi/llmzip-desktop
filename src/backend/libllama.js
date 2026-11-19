// Finding libllama and the package manager that installs it (txiki.js).
//
// The compressor binds libllama through FFI (vendor/llama-zip.js/js/llama.js),
// so the app only needs to know which file to hand it. The search order is the
// one of llama.js: the LLAMA_LIB variable, then the usual Homebrew and system
// directories. A file the user chose in the app comes before all of them.
// Windows gets one more place, where winget unpacks the package.
export const LLAMA_PACKAGE = 'llama.cpp';
export const WINGET_ID = 'ggml.llamacpp';

export const IS_WIN = /\.exe$/i.test(tjs.exePath) || tjs.exePath.includes('\\');
// txiki has no tjs.platform, and navigator.platform reads "Linux ..." on Linux.
export const IS_MAC = !IS_WIN && !/linux/i.test(globalThis.navigator?.platform ?? '');

const SEP = IS_WIN ? ';' : ':';

const exists = async path => {
    try {
        await tjs.stat(path);
        return true;
    }
    catch {
        return false;
    }
};

export const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}/${name}`;

// A .app started from Finder gets a bare PATH, so also look where Homebrew
// and winget put their commands.
export const searchDirs = () => {
    const home = tjs.homeDir;
    const dirs = (tjs.env.PATH || '').split(SEP).filter(Boolean);
    if (IS_WIN) {
        const local = tjs.env.LOCALAPPDATA;
        if (local) dirs.push(`${local}\\Microsoft\\WindowsApps`);
    }
    else
        dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', `${home}/.linuxbrew/bin`, '/usr/bin');
    return [...new Set(dirs)];
};

export const findTool = async name => {
    const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`] : [name];
    for (const dir of searchDirs())
        for (const candidate of names) {
            const path = joinPath(dir, candidate);
            if (await exists(path)) return path;
        }
    return null;
};

// Child processes get the widened PATH so brew can find git and curl even
// when the app was started from Finder.
export const toolEnv = () => {
    const env = Object.assign({}, tjs.env);
    for (const key of Object.keys(env))
        if (/^path$/i.test(key)) delete env[key];
    env.PATH = searchDirs().join(SEP);
    env.HOMEBREW_NO_ENV_HINTS = '1';
    return env;
};

// Mirrors libCandidates() in js/llama.js, without the bare names (those only
// resolve inside dlopen, so they cannot be checked here).
const defaultCandidates = () => {
    if (IS_WIN) return [];
    const home = tjs.homeDir;
    const macDirs = ['/opt/homebrew/lib', '/usr/local/lib', '/opt/local/lib', '/usr/lib'];
    const linuxDirs = [
        '/home/linuxbrew/.linuxbrew/lib', `${home}/.linuxbrew/lib`, '/usr/local/lib', '/usr/lib', '/usr/lib64',
        '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/lib/x86_64-linux-gnu'
    ];
    return IS_MAC ? macDirs.map(dir => `${dir}/libllama.dylib`)
                  : linuxDirs.flatMap(dir => [`${dir}/libllama.so`, `${dir}/libllama.so.0`]);
};

// winget unpacks the zip into %LOCALAPPDATA%\Microsoft\WinGet\Packages\ggml.llamacpp_*
// and links only the executables onto PATH, so the DLL has to be found there.
const wingetCandidates = async () => {
    const local = tjs.env.LOCALAPPDATA;
    if (!IS_WIN || !local) return [];
    const root = `${local}\\Microsoft\\WinGet\\Packages`;
    const found = [];
    try {
        for await (const entry of await tjs.readDir(root))
            if (entry.name.toLowerCase().startsWith(WINGET_ID.toLowerCase()))
                found.push(`${root}\\${entry.name}\\llama.dll`);
    }
    catch { /* no winget packages yet */ }
    return found;
};

// Returns { path, source } or null. `chosen` is the file the user picked.
export const findLibllama = async chosen => {
    if (chosen && await exists(chosen)) return { path: chosen, source: 'chosen' };
    if (tjs.env.LLAMA_LIB && await exists(tjs.env.LLAMA_LIB)) return { path: tjs.env.LLAMA_LIB, source: 'env' };
    for (const path of [...defaultCandidates(), ...await wingetCandidates()])
        if (await exists(path)) return { path, source: 'search' };
    return null;
};

// The llama.cpp build number, read from the file name of the real library
// (libllama.so.0.0.10180, libllama.0.0.10180.dylib). Null when the name has none.
export const libraryBuild = async path => {
    let real = path;
    try {
        real = await tjs.realPath(path);
    }
    catch { /* keep the given path */ }
    const match = real.split(/[\\/]/).pop().match(/\.(\d{3,})(?:\.dylib|\.so)?$/) || real.match(/llama\.cpp[\\/](\d{3,})[\\/]/);
    return match ? Number(match[1]) : null;
};

// What the install button runs, per package manager.
export const installCommand = (tool, exe) => tool === 'brew' ? [exe, 'install', LLAMA_PACKAGE]
    : [exe, 'install', '--id', WINGET_ID, '--exact', '--accept-package-agreements', '--accept-source-agreements'];

export const installTool = () => IS_WIN ? 'winget' : 'brew';
export const GUIDE = IS_WIN ? 'https://learn.microsoft.com/windows/package-manager/winget/' : 'https://brew.sh/';
