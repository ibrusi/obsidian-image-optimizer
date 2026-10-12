# Obsidian Image Optimizer

[English](README.md) | [Русский](README.ru.md)

Keeps the images of your [Obsidian](https://obsidian.md) notes small and local: web images are downloaded into the vault, and images are converted to WebP at a quality where the difference is not visible (**40** by default) — typically **5–8 times smaller** for screenshots and photos from the web. Links in your notes are updated automatically.

It is an **Obsidian plugin** (`obsidian-plugin/`) that works on **Windows, macOS, Linux, Android and iOS**, with nothing to install in the operating system: the WebP encoder (libwebp, the library behind `cwebp`) is compiled to WebAssembly and ships inside the plugin.

---

## 📱 Obsidian plugin

### What it does
- **Downloads web images** (`![](https://…)` and `<img src="https://…">`) into a folder of your choice and points the embeds at the local files. Only real images are accepted: an HTML "hotlinking denied" page never replaces your link. YouTube videos and tweets embedded with `![](…)` are left as they are. SVG images (formulas, diagrams) are saved as they are: a vector image stays sharp and is usually smaller than any WebP of it. A link that failed for good (404, 403, not an image) is not requested again by other notes in the same run; network errors and timeouts are, and every new run checks all links again. Images are requested the way a browser showing the page requests them (the page from the note's `source` property is sent as the referrer), and a `.webp` the site no longer serves (404, or 403 from file storage such as S3) is downloaded in its original format (`.jpg`, `.jpeg`, `.png`, `.gif` at the same address): web clippers save the WebP copy some sites hand to browsers.
- **Converts to WebP** — JPG, PNG and BMP to WebP, **animated GIFs to animated WebP**. For PNG, BMP and GIF the plugin picks lossless or lossy encoding from the content: few colours and little change between frames (screenshots, diagrams, screen recordings) are encoded lossless, pixel for pixel; many colours or frames that change all over (photos, renders, video clips) lossy. If the chosen mode gives no saving, the other is tried; unclear images are encoded both ways and the smaller file wins. JPG is encoded lossy only. A converted image is used only if it is at least 5% smaller (configurable); otherwise the original is kept.
- **Converts images already in the vault**: the WebP is written next to the original, every link to it in every note is rewritten (embeds, links, properties; sizes such as `|200` are kept), and the original is moved to the vault's `.trash` folder, where it can be restored. An original that is still mentioned anywhere — a canvas, a property, plain text — is kept.
- **Converts on paste and drop**: a pasted screenshot is saved as WebP right away; web images in pasted text are downloaded.
- **Stays responsive**: encoding runs in a background worker, one image at a time; long runs show progress and can be stopped.

### Installation
Until the plugin is in the community catalogue, install it with **BRAT**:
1. Install and enable the community plugin **BRAT**.
2. Run **BRAT: Add a beta plugin for testing**, enter `ibrusi/obsidian-image-optimizer` and pick the latest version.
3. Enable **Image Optimizer** in *Settings → Community plugins*.

Manual installation: download `obsidian-image-optimizer.zip` from the [latest release](https://github.com/ibrusi/obsidian-image-optimizer/releases), unpack it into `<vault>/.obsidian/plugins/` (the `.obsidian` folder is hidden) and enable the plugin.

### Usage
Open the command palette (`Ctrl/Cmd+P` on a computer; on a phone swipe down in a note or use the menu) and type **image**:

| Command | What it does |
| :--- | :--- |
| **Optimize images in the current note** | Downloads web images and converts the note's images. |
| **Optimize images in the current note's folder** | The same for every note in the note's folder and its subfolders, with progress and a Stop button. |
| **Optimize images in the whole vault** | The same for every note, with progress and a Stop button. |
| **Stop image optimization** | Stops what is running. Finished images stay done. |

To pick any folder, right-click it in the file explorer (long-press on a phone) and choose **Optimize images in this folder**. Images are found through the folder's notes, so an image stored elsewhere but embedded in them is converted too.

With **Convert on paste and drop** enabled (default), pasted and dropped images are handled without any command.

### Settings
| Setting | Default | Description |
| :--- | :--- | :--- |
| Language | As in Obsidian | English or Russian. By default the plugin follows the Obsidian interface language, and uses English when that language is not available. |
| Image folder | `Attachments` | Where downloaded and pasted images go: `Attachments` — a folder next to the note; `/Attachments` — one folder at the vault root; empty — the note's own folder. Converted local images stay next to their originals. |
| Quality | `40` | Lossy WebP quality, 1–100. Lossless encoding does not depend on it. |
| Compression effort | `4` | libwebp method, 0–6. `6` gives files about 5% smaller but is several times slower — noticeable on phones. |
| Minimum saving, % | `5` | Keep the original unless the WebP is at least this much smaller. |
| GIF | Convert to WebP | Or keep GIFs as they are. |
| Convert images already in the vault | on | Commands also convert local JPG/PNG/BMP/GIF and move the originals to `.trash`. |
| Convert on paste and drop | on | See above. |
| Reuse identical files | on | Saved files get a fingerprint of the original in their name; an image added again (another note, pasted twice, a copy of a local image, another device) is linked to the existing file instead of being saved and encoded again, even after the settings changed. Off: names without fingerprint, every image is saved as a new file. |
| Maximum download, MB | `30` | Larger downloads are refused. |
| Maximum image size, megapixels | `50` | Larger images are kept as they are (for animations: width × height × frames), to protect memory on phones. |
| Allow private network addresses | off | By default links to `localhost`, `*.local` and private, loopback and link-local IP addresses are refused, so a note from an untrusted source cannot probe your network. |
| Write a log note | off | Appends details of every run to `image-optimizer-log.md` (in English, for troubleshooting): plugin and Obsidian version, platform, each note with its images, and for a failed download every request with what was sent and what the site answered (status, server headers, the start of an error page). |

Plugin settings are stored in `.obsidian/plugins/obsidian-image-optimizer/data.json`; if your sync does not copy `.obsidian/plugins`, set them on every device.

### Good to know
- EXIF metadata (date, GPS) is not kept in converted images; the orientation of phone photos is applied to the pixels.
- Files are never overwritten: a taken name gets a number (`pic-…-1.webp`).
- Saved files carry a short fingerprint of their original in the name: `photo-3fa9c2e1b7d04a85.webp` (the first 16 hex digits of the SHA-256 of the downloaded, pasted or local original). The same image added again — in another note, pasted twice, or on another device after sync — is found by that name and linked instead of being saved and encoded again (before it is used, the found file is checked: a WebP must have the image's width and height, an unconverted original must match byte for byte, so a chance match of names never puts another picture into a note), whatever the settings were (setting *Reuse identical files*). Nothing beyond the vault itself has to be synced. A file renamed by hand loses its fingerprint; then the image may be saved once more, never lost. After encoding, a file anywhere in the vault with exactly the same bytes is reused as well: this catches the same picture arriving as a different original (an image copied from the browser is re-saved by the clipboard as another PNG) and files saved by earlier versions. Only files of exactly the same size are read for this.
- Links inside code blocks, inline code and comments are left alone. Notes open in an editor are saved before they are rewritten.
- WebP files are never re-encoded, so running the plugin again does not lower quality.

---

## 🧪 Development

### Plugin
```bash
cd obsidian-plugin
npm ci
npm run typecheck
npm test               # unit tests (Node 22.18+)
npm run test:browser   # encoders in Chromium and WebKit (needs Playwright browsers)
npm run build          # main.js
```
A release is published by CI for every new version in `manifest.json` (keep `package.json` in sync); versions with a suffix such as `2.0.0-beta.3` are pre-releases.

CI (`.github/workflows/ci.yml`) runs the same checks, including the encoders in Chromium and WebKit.

---

## 📄 License

[MIT](LICENSE) © 2026 Andrey Brusi (ibrusi).

The plugin bundles libwebp (BSD-3-Clause), [@jsquash/webp](https://github.com/jamsinclair/jSquash) and [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) (Apache-2.0), and [wasm-webp](https://github.com/nieyuyao/webp-wasm) (MIT); their licenses are in [THIRD_PARTY_NOTICES.md](obsidian-plugin/THIRD_PARTY_NOTICES.md) and in every release.

---

## ⚠️ Disclaimer

> [!WARNING]
> This plugin reads and modifies Markdown notes and image attachments.
> While replaced originals are moved to the vault trash, **it is strongly recommended to make a full backup of your Obsidian vault** or track it with version control (such as Git) before performing batch optimizations.
> This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any data loss. Use at your own risk.
