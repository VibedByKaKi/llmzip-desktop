# LLM Zip

A desktop app that compresses files with a language model. Drop a file on the window and it becomes a `.llmz` file. Drop an `.llmz` file and it decompresses and checks the result against a stored SHA-256.

The app is a small [tinyjs](https://github.com/tarwin/tinyjsapp) window (about 6 MB, no Electron). It does not contain a compressor. It drives [llama-zip](https://github.com/AlexBuz/llama-zip), which feeds the predictions of a llama.cpp model into an arithmetic coder. See the 3Blue1Brown video "Compression is Intelligence" for how that works.

## Requirements

- macOS 15 or later, Windows 10/11, or Linux with WebKitGTK 4.1
- `llama-zip` on your machine:
  ```sh
  pipx install git+https://github.com/alexbuz/llama-zip.git
  ```
  The app looks on your `PATH` and in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If yours is elsewhere, use "I installed it somewhere else" in the setup box.
- A `.gguf` model. Any base model that llama.cpp supports works. SmolLM2-135M (Q8_0) compressed about 115 bytes per second on an Intel i7 laptop CPU, and 6000 bytes of English text shrank to 888 bytes. A 7B or 8B model compresses much better and runs far slower.

## Use

1. Choose a model.
2. Drop one or more files on the window. Files run one at a time.
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
