// Finding libllama and the package manager that installs it (txiki.js).
//
// The compressor binds libllama through FFI (vendor/llama-zip.js/js/llama.js),
// so the app only needs to know which file to hand it. The search order is the
// one of llama.js: the LLAMA_LIB variable, then the usual Homebrew and system
// directories. A file the user chose in the app comes before all of them.
// Windows gets one more place, where winget unpacks the package.
//
// The library files are libllama.so.1.0.0 (Linux), libllama.1.dylib (macOS) and
// llama.dll (Windows). Only llama.cpp 1.0.0 is accepted, see src/shared/llama.js.
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
    return IS_MAC ? macDirs.flatMap(dir => [`${dir}/libllama.dylib`, `${dir}/libllama.1.dylib`])
                  : linuxDirs.flatMap(dir => [`${dir}/libllama.so`, `${dir}/libllama.so.1`]);
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
// LLMZIP_HIDE_LIBLLAMA=1 makes the lookup find nothing, so the install card can
// be tried on a machine that has libllama. Together with LLMZIP_DRY_RUN_INSTALL=1
// nothing gets installed. Any value except empty, `0` or `false` turns it on.
const libraryHidden = () => !['', '0', 'false'].includes(String(tjs.env.LLMZIP_HIDE_LIBLLAMA ?? '').trim().toLowerCase());

export const findLibllama = async chosen => {
    if (libraryHidden()) return null;
    if (chosen && await exists(chosen)) return { path: chosen, source: 'chosen' };
    if (tjs.env.LLAMA_LIB && await exists(tjs.env.LLAMA_LIB)) return { path: tjs.env.LLAMA_LIB, source: 'env' };
    for (const path of [...defaultCandidates(), ...await wingetCandidates()])
        if (await exists(path)) return { path, source: 'search' };
    return null;
};

// What the file name says about the version, for when the library cannot be asked. Returns
// '1.0.0' for libllama.so.1.0.0, libllama.1.0.0.dylib and a Homebrew Cellar path ending in
// llama.cpp/1.0.0/..., a build number such as 10180 for the old names (libllama.so.0.0.10180),
// or null. The library itself tells more through llama_version(), which the worker prefers.
export const libraryBuild = async path => {
    let real = path;
    try {
        real = await tjs.realPath(path);
    }
    catch { /* keep the given path */ }
    const name = real.split(/[\\/]/).pop();
    // Before 1.0.0 the version was 0.0.<build>.
    const old = name.match(/^libllama\.so\.0\.0\.(\d{3,})$/) || name.match(/^libllama\.0\.0\.(\d{3,})\.dylib$/) || real.match(/llama\.cpp[\\/](\d{3,})[\\/]/);
    if (old) return Number(old[1]);
    const match = name.match(/^libllama\.so\.(\d+\.\d+\.\d+)$/) || name.match(/^libllama\.(\d+\.\d+\.\d+)\.dylib$/)
        || real.match(/llama\.cpp[\\/](\d+\.\d+\.\d+)[\\/]/);
    return match ? match[1] : null;
};

// A build number as llama.cpp used before 1.0.0 (10180, or '10180' after a JSON round trip).
const isBuildNumber = build => typeof build === 'number' || /^\d+$/.test(String(build));

// A stored or detected llama.cpp version, for display. The header of a format v2 file made
// before llama.cpp 1.0.0 holds a number, newer ones hold '1.0.0 (build 12359)' or '1.0.0'.
export const describeBuild = build => isBuildNumber(build) ? `build ${build}` : String(build);

// Whether two stored builds name the same llama.cpp. A bare version equals the same version
// with a build number, because a file name has no build number.
export const sameBuild = (a, b) => {
    const key = build => isBuildNumber(build) ? `build ${build}` : String(build).split(' ')[0];
    return key(a) === key(b);
};

// What the install button runs, per package manager.
export const installCommand = (tool, exe) => tool === 'brew' ? [exe, 'install', LLAMA_PACKAGE]
    : [exe, 'install', '--id', WINGET_ID, '--exact', '--accept-package-agreements', '--accept-source-agreements'];

export const installTool = () => IS_WIN ? 'winget' : 'brew';
export const GUIDE = IS_WIN ? 'https://learn.microsoft.com/windows/package-manager/winget/' : 'https://brew.sh/';
