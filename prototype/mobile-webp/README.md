# WebP prototype (desktop and mobile)

A throwaway prototype that checks whether images can be downloaded and
converted to WebP **inside Obsidian on every platform** — Windows, macOS,
Linux, Android and iOS — without installing anything into the OS.

It uses libwebp compiled to WebAssembly (`@jsquash/webp`), embedded into
`main.js`. This is the same library `cwebp` is built on, with the settings of
the desktop CLI (`-q 40 -m 6`), so the output matches the CLI byte for byte.

> Test on a copy of your vault. The prototype writes files and rewrites links.

## Commands

| Command | What it does |
|---|---|
| **WebP Prototype: Benchmark the first image of the current note** | Takes the first image embedded in the active note (local, or else the first remote one), encodes it with every available encoder and writes timings and sizes to `webp-prototype-log.md`. No file is changed. |
| **WebP Prototype: Download and convert remote images of the current note** | Downloads every `![](https://…)` image of the active note. JPG/PNG/BMP are converted to WebP; the WebP is kept only if it is smaller, otherwise the original is saved. The file goes to the attachment folder from Obsidian's settings and the embed is rewritten in the link format from the settings. GIF and WebP are saved as is. |

## Installing

**With BRAT** (desktop, Android, iOS): install the *BRAT* community plugin,
run *BRAT: Add a beta plugin for testing*, enter
`ibrusi/obsidian-local-image-small` and choose the version
`0.1.0-prototype.1`. Then enable *WebP Prototype* in *Settings → Community plugins*.

**Manually**: download `webp-prototype.zip` from the release
[`0.1.0-prototype.1`](https://github.com/ibrusi/obsidian-local-image-small/releases/tag/0.1.0-prototype.1),
unpack it into `<vault>/.obsidian/plugins/` (the folder `.obsidian` is
hidden; on Android enable hidden files in the file manager), restart
Obsidian and enable the plugin.

## Test protocol

1. Create a note with three images: a screenshot (PNG), a phone photo (JPG,
   12 MP or more) and a small picture from the web (`![](https://…)`).
2. Run **Benchmark** for each image (keep the image you test first in the note).
3. Create a note with 5–10 web images and run **Download and convert**.
   Check that the images show, the links point to local `.webp` files and the
   images look the same.
4. Send back `webp-prototype-log.md`.

Run it on the desktop and on Android; on iOS if a device is available.

## What is already verified

- The encoder runs in Chromium (the engine of desktop and Android Obsidian);
  the WebKit run (the engine of iOS) is part of CI.
- On test images the output size equals `ffmpeg -c:v libwebp -quality 40
  -compression_level 6` to within 0.01%, so the visual result is the same.

## Known limitations

- Encoding runs on the main thread: Obsidian does not respond while a large
  photo is being encoded. A real plugin would use a Web Worker.
- Animated GIFs are not converted (canvas decoding keeps one frame).
- Only remote images of the active note; no local images, no settings.

## Development

```sh
npm ci
npm run typecheck
npm test               # unit tests (Node 22.18+)
npm run test:browser   # encoder in Chromium and WebKit (needs Playwright browsers)
npm run build          # main.js
```

A release is published by pushing a tag equal to the manifest version, e.g.
`0.1.0-prototype.1`.
