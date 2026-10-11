# Third-party notices

The files in `src/assets/fonts/` are bundled locally. No font or emoji requests are sent to an external service. All three font files are preloaded independently of conversation contents.

## PDF previews

PDF previews use [Mozilla PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist` 6.4.299), under the Apache License 2.0. The original license is in [licenses/PDFjs.txt](licenses/PDFjs.txt). Its renderer and worker are bundled locally; attachment bytes are processed in browser memory. Hush does not include the PDF.js viewer or execute document scripts.

## DM Sans

DM Sans by the DM Sans Project Authors / Colophon Foundry, distributed under the SIL Open Font License 1.1. The original license and copyright notice are in [licenses/DM-Sans.txt](licenses/DM-Sans.txt).

The unmodified Latin and Latin Extended variable-weight WOFF2 files come from [`@fontsource-variable/dm-sans` 5.3.0](https://fontsource.org/fonts/dm-sans). Its npm archive SHA-512 integrity is `BpUG5bqePiDFMBM4ZtLSlPdAIOM990uB1dlXzIf4aw21yQR7BmykedLXXXMqGWsR18aMLOsbWccwJNh3ztTQaA==`.

## Twemoji

Twemoji artwork by Twitter and other contributors, maintained by [jdecked/twemoji](https://github.com/jdecked/twemoji), is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

The unmodified color-font file comes from [`@sableclient/twemoji-font` 1.0.4](https://github.com/SableClient/twemoji-font), a COLR/CPAL conversion of Twemoji 17.0.2 based on Mozilla's font-generation work. This conversion changes the artwork's format; Hush does not alter its designs. Font-generation code is Apache-2.0; artwork remains CC BY 4.0. The package's original notice is in [licenses/Twemoji.txt](licenses/Twemoji.txt).

The npm archive SHA-512 integrity is `LzvQB/VZtv5KEq1VYq2azr7v7cYT8oklOVRGkAN2RNwa3sF0XcnqM3lBHSYRFXQleGLSUgs3gA0slbwkD2+sJw==`.

## Emojibase

Emoji labels, search keywords, categories, and shortcodes are generated from the English data in [`emojibase-data` 17.0.0](https://github.com/milesj/emojibase), by Miles Johnson, under the MIT license. The original notice is in [licenses/Emojibase.txt](licenses/Emojibase.txt) and the generated module. The catalog includes Unicode 17 emoji and skin-tone variants, with GitHub, iamcal, and Emojibase shortcode presets and a few compatibility aliases. No catalog requests go to an external service.

To regenerate `src/lib/emoji-data.ts`, unpack the pinned npm package and run `node --import=tsx scripts/generate-emoji-data.ts /path/to/unpacked/package`. The npm archive SHA-512 integrity is `Yvgb5AWoHViHV/gq1qr5ZAarcBip+B27/ZLRsUJkbgAEaLlZ/fof9g882LTpmEpyhBNEC0m2SEmItljHsTygjA==`.

## Enhanced noise reduction

The locally bundled WebAssembly model and audio worklet in `src/assets/audio/` come from [`@sapphi-red/web-noise-suppressor` 0.4.1](https://github.com/sapphi-red/web-noise-suppressor), under the MIT license. They implement [GTCRN](https://github.com/Xiaobin-Rong/gtcrn), by Xiaobin Rong, and include GTCRN's MIT-licensed model and PFFFT's BSD-style FFT implementation. All original notices are in [licenses/Noise-suppression.txt](licenses/Noise-suppression.txt) and the worklet. Audio processing runs on the user's device; no audio is sent to an inference service.

Hush adds worklet initialization/error notifications and starts its control message port so the processor can be shut down. The model is unmodified. To reproduce the bundled assets, unpack the pinned package and run `node --import=tsx scripts/vendor-audio.ts /path/to/unpacked/package`. The npm archive SHA-512 integrity is `hy2GnF079+zi4n9BZUf+GGIQ1IofApAk6rgGMyMQ3soHfz/GKu1pcCsmePyIHVvUuv1LrFudw9BmmBqoOKay5w==`.

## Markdown

Messages use the MIT-licensed `react-markdown` and `remark-gfm` packages. Markdown parsing and rendering happen locally; no message contents are sent to another service. Original package notices are in [licenses/Markdown.txt](licenses/Markdown.txt).

The live message editor uses [CodeMirror](https://codemirror.net/) and Lezer, by Marijn Haverbeke and contributors, under the MIT license. The editor and its dependencies are bundled locally. Their notices are in [licenses/CodeMirror.txt](licenses/CodeMirror.txt).
