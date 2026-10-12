# Obsidian Image Optimizer

[English](README.md) | [Русский](README.ru.md)

Keeps the images of your [Obsidian](https://obsidian.md) notes small and local: web images are downloaded into the vault, and images are converted to WebP at a quality where the difference is not visible (**40** by default) — typically **5–8 times smaller** for screenshots and photos from the web. Links in your notes are updated automatically.

It is an **Obsidian plugin** (`obsidian-plugin/`) that works on **Windows, macOS, Linux, Android and iOS**, with nothing to install in the operating system: the WebP encoder (libwebp, the library behind `cwebp`) is compiled to WebAssembly and ships inside the plugin.

---

## 📱 Obsidian plugin

### What it does
- **Downloads web images** (`![](https://…)` and `<img src="https://…">`) into a folder of your choice and points the embeds at the local files. Only real images are accepted: an HTML "hotlinking denied" page never replaces your link.
- **Converts to WebP** — JPG, PNG and BMP to WebP, **animated GIFs to animated WebP**. For PNG, BMP and GIF the plugin picks lossless or lossy encoding from the content: few colours and little change between frames (screenshots, diagrams, screen recordings) are encoded lossless, pixel for pixel; many colours or frames that change all over (photos, renders, video clips) lossy. If the chosen mode gives no saving, the other is tried; unclear images are encoded both ways and the smaller file wins. JPG is encoded lossy only. A converted image is used only if it is at least 5% smaller (configurable); otherwise the original is kept.
- **Converts images already in the vault**: the WebP is written next to the original, every link to it in every note is rewritten (embeds, links, properties; sizes such as `|200` are kept), and the original is moved to the vault's `.trash` folder, where it can be restored. An original that is still mentioned anywhere — a canvas, a property, plain text — is kept.
- **Converts on paste and drop**: a pasted screenshot is saved as WebP right away; web images in pasted text are downloaded.
- **Stays responsive**: encoding runs in a background worker, one image at a time; long runs show progress and can be stopped.

### Installation
Until the plugin is in the community catalogue, install it with **BRAT**:
1. Install and enable the community plugin **BRAT**.
2. Run **BRAT: Add a beta plugin for testing**, enter `ibrusi/obsidian-local-image-small` and pick the latest version.
3. Enable **Image Optimizer** in *Settings → Community plugins*.

Manual installation: download `obsidian-image-optimizer.zip` from the [latest release](https://github.com/ibrusi/obsidian-local-image-small/releases), unpack it into `<vault>/.obsidian/plugins/` (the `.obsidian` folder is hidden) and enable the plugin.

### Usage
Open the command palette (`Ctrl/Cmd+P` on a computer; on a phone swipe down in a note or use the menu) and type **image**:

| Command | What it does |
| :--- | :--- |
| **Optimize images in the current note** | Downloads web images and converts the note's images. |
| **Optimize images in the whole vault** | The same for every note, with progress and a Stop button. |
| **Stop image optimization** | Stops what is running. Finished images stay done. |

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
| Reuse identical files | on | If a file of the same name in the target folder (`pic.webp`, `pic-1.webp`, …) holds exactly the same bytes, link to it instead of saving a copy. Off: every image is saved as a new file. |
| Maximum download, MB | `30` | Larger downloads are refused. |
| Maximum image size, megapixels | `50` | Larger images are kept as they are (for animations: width × height × frames), to protect memory on phones. |
| Allow private network addresses | off | By default links to `localhost`, `*.local` and private, loopback and link-local IP addresses are refused, so a note from an untrusted source cannot probe your network. |
| Write a log note | off | Appends details of every run to `image-optimizer-log.md` (in English, for troubleshooting). |

Plugin settings are stored in `.obsidian/plugins/obsidian-image-optimizer/data.json`; if your sync does not copy `.obsidian/plugins`, set them on every device.

### Good to know
- EXIF metadata (date, GPS) is not kept in converted images; the orientation of phone photos is applied to the pixels.
- Files are never overwritten: new files get a free name (`pic.webp`, `pic-1.webp`, …). If a file of that name already holds exactly the same bytes (the same image in two notes), it is reused instead of saving a copy (setting *Reuse identical files*).
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

## ⚠️ Disclaimer

> [!WARNING]
> This plugin reads and modifies Markdown notes and image attachments.
> While replaced originals are moved to the vault trash, **it is strongly recommended to make a full backup of your Obsidian vault** or track it with version control (such as Git) before performing batch optimizations.
> This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any data loss. Use at your own risk.
