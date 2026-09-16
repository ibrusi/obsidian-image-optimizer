# Obsidian Image Optimizer (Go)

[English](README.md) | [Русский](README_RU.md)

A high-performance Go CLI utility and [Obsidian](https://obsidian.md) plugin that automates the entire image processing workflow in your notes:

1. **Download remote images**: Fetches web images from URLs (`http(s)://`) and saves them locally into the `attachments/` folder relative to each note.
2. **Originals backup**: Automatically preserves original images in a `.originals_backup/` subfolder.
3. **WebP conversion**: Converts images to WebP with configurable compression quality (**default 40%** — balanced for minimal file size while preserving sharp text and details).
4. **Smart GIF compression**: Supports Animated WebP (`gif2webp`, `ffmpeg`), lossy LZW compression via `gifsicle --lossy=80`, and a built-in Go palette optimizer.
5. **Strict size verification**: The converted image is kept **only if its file size is strictly smaller than the original**. If the size increases or remains unchanged, the converted file is removed and the original is retained.
6. **Automatic link rewriting**: Rewrites Markdown links (`![alt](url)`, `<img src="url">`, `![[url]]`) to local attachment paths (`attachments/image.webp`).
7. **Optional local image optimization**: Recursively optimizes already existing local images inside your vault (`--optimize-local`).

---

## 💡 GIF Optimization Strategy

> **Key Fact**: GIFs **can** be converted to WebP!  
> WebP natively supports frame-by-frame animation (**Animated WebP**), and Chromium/Electron (on which Obsidian is built) supports Animated WebP out of the box!

### GIF Handling Options:

| Option | How It Works | Size Reduction | Pros & Cons |
| :--- | :--- | :--- | :--- |
| **1. Animated WebP (Recommended)** | Frame conversion via `gif2webp` or `ffmpeg` (`--gif-mode=webp` or `auto`) | **60% – 85%** | 🔥 Maximum compression, 24-bit color (GIF is limited to 256 colors), native rendering in Obsidian. |
| **2. Lossy GIF (`gifsicle`)** | LZW color table optimization: `gifsicle -O3 --lossy=80` (`--gif-mode=optimize`) | **30% – 55%** | Preserves `.gif` extension, compatible with legacy markdown readers, but larger file size than WebP. |
| **3. ffmpeg PaletteGen + 15fps** | 256-color palette recalculation and FPS throttling (`scale=480:-1`) | **40% – 60%** | Clean downscaling without compression artifacts. |
| **4. Convert to MP4 / WebM** | Video format h.264/AV1 (`![[animation.mp4]]`) | **90% – 95%** | Ideal for heavy screen recordings > 10 MB. Obsidian plays video directly in the note body. |

By default, the optimizer runs in **`auto`** mode:
- If `gif2webp` or `ffmpeg` is available on your system, animated GIFs are converted to lightweight **Animated WebP**.
- If no external tools are found or `--gif-mode=optimize` is set, `gifsicle -O3 --lossy=80` or the built-in Go palette optimizer is used.
- In all cases, strict size verification applies: if the resulting file is not smaller than the original, the original GIF is preserved.

---

## 🚀 Installation & Build

### 1. System Dependencies (Recommended)
The utility can run self-contained using pure Go, but for optimal performance and extended GIF/WebP conversion features, installing external CLI tools is recommended:

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y webp gifsicle ffmpeg

# macOS (Homebrew)
brew install webp gifsicle ffmpeg

# Windows (Scoop / Chocolatey)
scoop install webp gifsicle ffmpeg
# or
choco install webp gifsicle ffmpeg
```

### 2. Build Go Binary
```bash
cd obsidian-image-optimizer
go build -o bin/obsidian-img-opt cmd/obsidian-img-opt/main.go
```

*(Optional)* Copy binary to `/usr/local/bin` for system-wide access:
```bash
sudo cp bin/obsidian-img-opt /usr/local/bin/
```

---

## 🛠️ CLI Usage

### Process a single note:
```bash
obsidian-img-opt --file "/path/to/vault/My Article.md"
```

### Process an entire Obsidian vault recursively:
```bash
obsidian-img-opt --vault "/path/to/vault"
```

### Adjust WebP quality (default is 40%):
```bash
obsidian-img-opt --file "note.md" --quality 40
```

### Optimize both local and remote images:
```bash
obsidian-img-opt --file "note.md" --optimize-local
```

### Dry-run simulation (no files written):
```bash
obsidian-img-opt --vault "/path/to/vault" --dry-run
```

### Available CLI Flags:

| Flag | Default Value | Description |
| :--- | :--- | :--- |
| `--file` | `""` | Path to a specific Markdown file. |
| `--vault` | `""` (or current directory) | Path to Obsidian vault for recursive processing. |
| `--quality` | `40` | WebP compression quality (1–100). Default is 40%. |
| `--attached-dir`| `attachments` | Name of folder for attachments relative to note. |
| `--backup-dir` | `.originals_backup` | Subfolder for storing original image backups. |
| `--gif-mode` | `auto` | GIF handling modes: `auto`, `webp`, `optimize`, `keep`. |
| `--gif-lossy` | `80` | Compression level for gifsicle (typically 80–90). |
| `--optimize-local` | `false` | Also convert existing local JPG/PNG/GIF images. |
| `--link-format`| `markdown` | Link syntax: `markdown` (`![](...)`) or `wikilink` (`![[...]]`). |
| `--keep-backup`| `true` | Whether to store originals in `.originals_backup/`. |
| `--dry-run` | `false` | Simulation mode (does not modify disk). |

---

## 🔌 Obsidian Integration

You can easily trigger optimization directly within Obsidian using two methods:

### Method 1: Obsidian Plugin (`obsidian-plugin/`)
A ready-to-use Obsidian desktop plugin is included in this repository:
1. Copy the `obsidian-plugin` folder into your vault's plugins directory:
   ```bash
   cp -r obsidian-plugin "/path/to/vault/.obsidian/plugins/obsidian-image-optimizer"
   ```
2. Open Obsidian -> **Settings** -> **Community plugins** -> enable **Image Optimizer (Go)**.
3. A ribbon icon will appear on the left bar to optimize the current note in 1 click!
4. Commands are also registered in the Command Palette (`Ctrl+P` / `Cmd+P`):
   - `Image Optimizer: Optimize images in current note`
   - `Image Optimizer: Optimize images in entire vault`

### Method 2: Shell Commands Plugin
If you already use the popular **Shell Commands** community plugin:
1. Add a new command:
   ```bash
   obsidian-img-opt --file "{{file_path:absolute}}" --quality 40
   ```
2. Assign a hotkey (for example, `Ctrl+Alt+I`).
3. Pressing the hotkey will download all remote images in the active note, convert them to WebP, and replace links automatically.

---

## ⚠️ Disclaimer

> [!WARNING]
> This utility reads and modifies Markdown notes and image attachments.
> While automatic backups of original images are enabled by default (`.originals_backup/`), **it is strongly recommended to make a full backup of your Obsidian vault** or track it with version control (such as Git) before performing batch optimizations.
> This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any data loss. Use at your own risk.
