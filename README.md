# LLM Zip

A desktop app that compresses files with a language model. Drop a file on the window and it becomes a `.llmz` file. Drop an `.llmz` file and it decompresses and checks the result against a stored SHA-256.

The app is a small [tinyjs](https://github.com/tarwin/tinyjsapp) window (about 6 MB, no Electron). It does not contain a compressor. It drives [llama-zip](https://github.com/AlexBuz/llama-zip), which feeds the predictions of a llama.cpp model into an arithmetic coder. See the 3Blue1Brown video "Compression is Intelligence" for how that works.

## Requirements

- macOS 15 or later, Windows 10/11, or Linux with WebKitGTK 4.1
- One of [uv](https://docs.astral.sh/uv/) or [pipx](https://pipx.pypa.io/) to install `llama-zip`, plus `git` and a C/C++ compiler. llama-zip pins `llama-cpp-python`, which compiles llama.cpp on install. Expect 5 to 20 minutes.
- Disk space and RAM for a model (see below).

## Install llama-zip

On first launch the app offers to install `llama-zip` for you. The install box reads `Install… | using uv | using pipx`. Press the button for the installer you want:

- **uv** runs `uv tool install --force git+https://github.com/alexbuz/llama-zip.git`
- **pipx** runs `pipx install --force git+https://github.com/alexbuz/llama-zip.git`

The installer output streams into the window, and Cancel stops it. The app looks for `llama-zip` on your `PATH` and in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If you installed it somewhere else, choose "Use an existing llama-zip".

Set `LLMZIP_DRY_RUN_INSTALL=1` to try the install flow without installing anything. The app prints the command it would run, simulates a few lines of output over about two seconds, and changes nothing. Both installer buttons work in a dry run, even when uv or pipx is missing, and Cancel works. Any value except empty, `0` or `false` turns it on. For example: `LLMZIP_DRY_RUN_INSTALL=1 tinyjs dev`.

If neither installer is on your machine, the app says so and links to the uv install guide. It does not install uv or pipx itself.

## Get a model

Open "Download…" next to the model picker. There are three ways to get a model:

- **The list.** Five base models from SmolLM2 135M (138 MB) to Llama 3.1 8B (4.7 GB), downloaded from Hugging Face. The app checks each file against its published SHA-256 and deletes a file that does not match.
- **A URL.** Paste any https link to a `.gguf` file. Hugging Face "blob" page links are rewritten to the file link. The app checks the `GGUF` magic bytes, so a link that returns a web page fails instead of saving the page.
- **A file.** "Choose file…" picks a `.gguf` already on disk.

Downloads go to `models/` inside the app's data folder. Only one download or install runs at a time, and compression jobs wait for it. Speed depends on size: SmolLM2 135M (Q8_0) compressed about 115 bytes per second on an Intel i7 laptop CPU, and 6000 bytes of English text shrank to 888 bytes. A larger model compresses better and runs slower.

## Use

1. Choose or download a model.
2. On the File tab, drop one or more files on the window, or open the Text tab, type or paste text, and press "Compress text…" (Cmd or Ctrl+Enter also works). The app asks where to save the `.llmz` file. Text is encoded as UTF-8 and stored under the name `text.txt`. Jobs run one at a time.
3. Decompress with the same model file. The app compares a fingerprint of the model (size plus SHA-256 of its first and last megabyte) and refuses a different one unless you click "Try anyway".

## The .llmz format

| Bytes | Content |
| --- | --- |
| 4 | Magic `LLMZ` |
| 1 | Format version (1) |
| 4 | Length N of the header, unsigned little-endian |
| N | Header, UTF-8 JSON |
| rest | Raw `llama-zip` output |

The header holds the original file name and size, its SHA-256, the model fingerprint, and the context length, window overlap and GPU layer count used to compress. The header adds about 250 bytes, so tiny files come out larger than they went in.

## Limits

- **Speed.** Expect a few kilobytes per minute on a CPU, and less with a larger model. Compress files that are worth the wait.
- **Portability.** llama.cpp does not promise identical output across hardware, builds or GPU settings. A file may only decompress on the machine that made it. The checksum turns a silent failure into an error, and the app deletes the bad output.
- **GPU.** GPU layers default to 0. On the Intel Mac this was tested on, offloading all layers made llama-zip emit NaN probabilities and exit with status 0. The app detects the Python traceback and reports the job as failed.
- **Binary files.** llama-zip handles any bytes, but a language model predicts text well and other data poorly.

## Develop

```sh
git clone https://github.com/tarwin/tinyjsapp && cd tinyjsapp && ./setup.sh
cd /path/to/llmzip-desktop
/path/to/tinyjsapp/tinyjs dev      # run with hot reload
/path/to/tinyjsapp/tinyjs build    # dist/LLM Zip.app, dist/llmzip
```

The backend is `src/backend/main.js` and the page is in `src/frontend/`. The backend can run without a window under `tjs run` for testing, since it only needs an object with a `push` method as `app`.

## License

MIT. See `LICENSE`.
