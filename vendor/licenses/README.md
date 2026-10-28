# Third-party components

These files are copied unmodified from npm so the app runs without a build step.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `vendor/mp4-muxer.mjs` | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 5.2.2 | MIT |
| `vendor/webm-muxer.mjs` | [webm-muxer](https://github.com/Vanilagy/webm-muxer) | 5.1.4 | MIT |
| `vendor/fflate.mjs` | [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT |
| `vendor/gifenc.mjs` | [gifenc](https://github.com/mattdesl/gifenc) | 1.0.3 | MIT |
| `vendor/heic2any.min.js` | [heic2any](https://github.com/alexcorvi/heic2any) | 0.0.4 | MIT (bundles libheif, LGPL-3.0) |
| `vendor/ffmpeg/*.js` (wrapper) | [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) | 0.12.15 | MIT |
| `vendor/ffmpeg/ffmpeg-core.*` | [@ffmpeg/core](https://github.com/ffmpegwasm/ffmpeg.wasm) | 0.12.10 | GPL-2.0-or-later |

## About the GPL converter

`ffmpeg-core.js` and `ffmpeg-core.wasm` are FFmpeg compiled to WebAssembly with x264, which makes
them GPL-2.0-or-later. They're only used to convert files the browser can't play, and they're
loaded on demand as separate files. If you distribute this app, the GPL applies to those two files:
keep this notice, and point people to the corresponding source at
https://github.com/ffmpegwasm/ffmpeg.wasm (tag `v0.12.10`) and https://ffmpeg.org/.

If you'd rather not ship GPL code, delete `vendor/ffmpeg/ffmpeg-core.js` and
`vendor/ffmpeg/ffmpeg-core.wasm` (and their entry in `ON_DEMAND` in `sw.js`). Everything else keeps
working; files the browser can't play natively will show a clear "couldn't import" message instead
of being converted.
