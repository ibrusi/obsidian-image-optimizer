# Obsidian Image Optimizer (Go)

[English](README.md) | [Русский](README.ru.md)

A Go CLI utility and [Obsidian](https://obsidian.md) plugin that automates the image workflow in your notes:

1. **Download remote images**: fetches images linked by URL (`http(s)://`) into an `attachments/` folder next to each note. Only real images are accepted — an HTML "hotlinking denied" page never replaces your link.
2. **WebP conversion**: converts images to WebP with configurable quality (**default 40** — minimal file size while keeping text sharp). Phone photos are rotated according to their EXIF orientation, and the colour profile (ICC) is preserved.
3. **Smart GIF compression**: animated WebP (`gif2webp`, `ffmpeg`), lossy GIF via `gifsicle`, and a built-in Go palette optimizer as a last resort.
4. **Strict size verification**: a converted image is used **only if it is strictly smaller than the original**; otherwise the original is kept.
5. **Safe link rewriting**: rewrites `![alt](url)`, `<img src="url">` and `![[url]]` to local paths. Links inside code blocks, inline code and comments are never touched, and edits you make in the note while images are downloading are preserved.
6. **Never overwrites your files**: new files always get a free name (`pic.webp`, `pic-1.webp`, …); existing files are never overwritten or deleted by mistake.
7. **Optional local image optimization** (`--optimize-local`): optimizes images already in the vault and updates **every** note that embeds them.

---

## 💡 GIF Optimization Strategy

> **Key fact**: GIFs **can** be converted to WebP!
> WebP supports frame-by-frame animation (**Animated WebP**), and Chromium/Electron (on which Obsidian is built) displays it natively.

| Mode (`--gif-mode`) | What happens |
| :--- | :--- |
| `auto` (default) | Converts to animated WebP (`gif2webp`, then `ffmpeg`). If that is unavailable or not smaller, optimizes the GIF as GIF (`gifsicle`, `ffmpeg` palette, built-in Go optimizer). |
| `webp` | Animated WebP only; if it is not possible or not smaller, the original GIF is kept. |
| `optimize` | Keeps the `.gif` format: `gifsicle -O3 --lossy=80`, `ffmpeg` palette generation, or the built-in Go optimizer. |
| `keep` | Leaves every GIF (static and animated) untouched. |

Typical savings: animated WebP **60–85%**, lossy GIF **30–55%**. Additional knobs: `--gif-colors` (palette size), `--gif-lossy`, `--gif-max-width` (downscale wide GIFs; supported by `gifsicle`/`ffmpeg`), `--gif-drop-frames` (built-in optimizer only).

In all cases the strict size check applies: if the result is not smaller, the original GIF is kept.

---

## 🚀 Installation & Build

### 1. System dependencies (required for WebP)
JPEG/PNG/TIFF/BMP → WebP conversion requires `cwebp` (package `webp`) or `ffmpeg`. Without them only GIFs can be optimized (with the built-in Go optimizer), and the tool prints a warning at startup.

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y webp gifsicle ffmpeg

# macOS (Homebrew)
brew install webp gifsicle ffmpeg

# Windows (Scoop / Chocolatey)
scoop install libwebp gifsicle ffmpeg
# or
choco install webp gifsicle ffmpeg
```

### 2. Build the Go binary (Go 1.23+)
```bash
git clone https://github.com/ibrusi/obsidian-local-image-small.git
cd obsidian-local-image-small
go build -o bin/obsidian-img-opt ./cmd/obsidian-img-opt
```

*(Optional)* Copy the binary to `/usr/local/bin` for system-wide access:
```bash
sudo cp bin/obsidian-img-opt /usr/local/bin/
```

---

## 🛠️ CLI Usage

### Process a single note:
```bash
obsidian-img-opt --vault "/path/to/vault" --file "/path/to/vault/My Article.md"
```
Passing `--vault` together with `--file` is recommended: it bounds which files may be touched and is required to replace local originals safely (see below). `--file` alone also works; local originals are then never replaced.

### Process an entire vault recursively:
```bash
obsidian-img-opt --vault "/path/to/vault"
```

### Adjust WebP quality (default is 40):
```bash
obsidian-img-opt --vault "/path/to/vault" --quality 60
```

### Optimize both local and remote images:
```bash
obsidian-img-opt --vault "/path/to/vault" --optimize-local
```

### Dry run (nothing is downloaded or written):
```bash
obsidian-img-opt --vault "/path/to/vault" --optimize-local --dry-run
```

### Machine-readable output:
```bash
obsidian-img-opt --vault "/path/to/vault" --output json
```

### Available CLI flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--vault` (alias `--dir`) | current directory | Obsidian vault: processed recursively, or used as the root for `--file`. |
| `--file` | `""` | A single Markdown file to process. |
| `--quality` | `40` | WebP lossy quality (1–100). |
| `--attached-dir` (alias `--attachments`) | `attachments` | Folder for downloaded images, relative to the note. Must stay inside the note folder. |
| `--backup-dir` (alias `--backup`) | `.originals_backup` | Folder (inside the image folder) where replaced originals are moved. |
| `--keep-backup` | `true` | Move replaced originals into `--backup-dir`; `--keep-backup=false` deletes them instead. |
| `--optimize-local` | `false` | Also optimize existing local JPG/PNG/GIF/BMP/TIFF images. |
| `--link-format` | `markdown` | Syntax of rewritten remote links: `markdown` (`![](...)`) or `wikilink` (`![[...]]`). |
| `--gif-mode` | `auto` | GIF handling: `auto`, `webp`, `optimize`, `keep`. |
| `--gif-lossy` | `80` | gifsicle lossy level (0–200). |
| `--gif-colors` | `128` | Maximum palette size when a GIF stays a GIF (2–256). |
| `--gif-max-width` | `0` | Downscale GIFs wider than this many pixels (`0` keeps the size). |
| `--gif-drop-frames` | `false` | Drop every 2nd frame of long animations (built-in Go optimizer). |
| `--dry-run` | `false` | Show planned changes without downloading or writing anything. |
| `--output` | `text` | `text` or `json` (a single JSON summary on stdout, progress on stderr). |
| `--verbose` | `false` | Detailed logs. |
| `--timeout` | `30` | HTTP timeout per download, seconds. |
| `--tool-timeout` | `300` | Timeout for a single external encoder run, seconds. |
| `--max-download-mb` | `50` | Maximum size of a downloaded image, MB. |
| `--max-pixels` | `100000000` | Maximum decoded size (width × height × frames) for in-process decoding. |
| `--allow-private-hosts` | `false` | Allow downloads from localhost, private and link-local networks. |
| `--concurrency` | `4` | Number of images processed in parallel (1–64). |

The tool is configured via CLI flags only; it reads no environment variables except the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.

### Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Success. |
| `1` | Fatal error (invalid flags, vault not found, …). |
| `2` | Finished, but some images or notes failed (see warnings). |
| `130` | Interrupted (Ctrl+C / SIGTERM). |

---

## 🛡️ Safety Guarantees

- **No clobbering.** Results are written to temp files and published under a free name; your existing files are never overwritten.
- **Local originals are replaced last.** With `--optimize-local`, the optimized copy is created first, then every note embedding the image is rewritten, and only then is the original moved to `--backup-dir`. The original is kept if any note failed to update, if `--vault` is unknown, or if its file name is **still mentioned anywhere** in the vault (properties, canvases, plain `[[links]]`, text).
- **Stays inside the vault.** Links pointing outside the vault and symlinks are ignored; `--attached-dir`/`--backup-dir` cannot escape the note folder.
- **Untrusted downloads.** Only responses that are actually images are saved; sizes are capped (`--max-download-mb`); GIFs are checked before decoding (`--max-pixels`); external tools have a timeout.
- **SSRF protection.** By default downloads from `localhost`, private (`10.x`, `192.168.x`, …), link-local (including cloud metadata `169.254.169.254`) and CGNAT addresses are refused, so a note from an untrusted source cannot probe your network. Use `--allow-private-hosts` for intranet images. When an HTTP proxy is configured, the target host is checked via DNS before the request (best effort, the proxy resolves it again).
- **Concurrent editing.** Each note is re-read right before it is written, so edits made during downloads are kept. The remaining window is milliseconds, not zero — avoid editing the very same note during a batch run.

Known limitations: indented (4-space) code blocks are not detected as code (in Obsidian this indentation is usually a nested list item); local images whose optimized version is not smaller are re-checked on every run.

---

## 🔌 Obsidian Integration

### Method 1: Obsidian plugin (`obsidian-plugin/`)
A desktop plugin is included in this repository:
1. Copy the `obsidian-plugin` folder into your vault's plugins directory:
   ```bash
   cp -r obsidian-plugin "/path/to/vault/.obsidian/plugins/obsidian-image-optimizer"
   ```
2. Open Obsidian → **Settings** → **Community plugins** → enable **Image Optimizer (Go)**.
3. Set the binary path in the plugin settings if `obsidian-img-opt` is not in `PATH`.
4. A ribbon icon optimizes the current note in one click. Commands in the Command Palette (`Ctrl+P` / `Cmd+P`):
   - `Image Optimizer: Optimize images in current note`
   - `Image Optimizer: Optimize images in entire vault`

The plugin passes the vault root together with the note, reads the JSON summary (`--output json`) and prevents starting a second run while one is in progress. Plugin version 1.1.0 requires a binary built from this version.

### Method 2: Shell Commands plugin
With the **Shell Commands** community plugin:
1. Add a new command:
   ```bash
   obsidian-img-opt --vault "{{vault_path}}" --file "{{file_path:absolute}}"
   ```
2. Assign a hotkey (for example, `Ctrl+Alt+I`).

---

## 🧪 Development

```bash
gofmt -l .                 # must print nothing
go vet ./...
go test -race -cover ./... # integration tests are skipped when cwebp/gif2webp are missing
```

CI (`.github/workflows/ci.yml`) additionally runs `staticcheck` and checks the plugin syntax.

---

## ⚠️ Disclaimer

> [!WARNING]
> This utility reads and modifies Markdown notes and image attachments.
> While replaced originals are kept in `.originals_backup/` by default, **it is strongly recommended to make a full backup of your Obsidian vault** or track it with version control (such as Git) before performing batch optimizations.
> This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any data loss. Use at your own risk.
