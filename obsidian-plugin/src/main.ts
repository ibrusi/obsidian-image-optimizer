import { Notice, Platform, Plugin, TFile } from 'obsidian';
import { download, type Downloaded } from './services/downloader.ts';
import {
  DEFAULT_METHOD,
  DEFAULT_QUALITY,
  decode,
  detectVariant,
  encodeWebp,
  encodeWithCanvas,
  loadEncoder,
  type EncoderVariant,
} from './codec/encoder.ts';
import { findRemoteImages, replaceImages, type RemoteImage } from './domain/links.ts';
import { formatBytes, formatMs, LOG_PATH, RunLog } from './log.ts';
import { baseNameFromUrl } from './domain/names.ts';
import { extensionOf, imageTypeOf, isConvertible } from './domain/sniff.ts';
import { resolveFolder } from './domain/folders.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type PluginSettings } from './settings.ts';
import { ObsidianLinks, ObsidianVault } from './services/obsidian-ports.ts';
import { saveNew } from './services/storage.ts';
import { ImageOptimizerSettingTab } from './ui/settings-tab.ts';

export default class ImageOptimizerPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private busy = false;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));
    this.addCommand({
      id: 'benchmark',
      name: 'Benchmark the first image of the current note',
      checkCallback: (checking) => this.withActiveNote(checking, (note) => this.benchmark(note)),
    });
    this.addCommand({
      id: 'convert-note',
      name: 'Download and convert remote images of the current note',
      checkCallback: (checking) => this.withActiveNote(checking, (note) => this.convertNote(note)),
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private withActiveNote(checking: boolean, run: (note: TFile) => Promise<void>): boolean {
    const note = this.app.workspace.getActiveFile();
    if (!note || note.extension !== 'md') return false;
    if (!checking) void this.exclusive(() => run(note));
    return true;
  }

  // exclusive runs one task at a time: encoding is memory-hungry on phones.
  private async exclusive(task: () => Promise<void>): Promise<void> {
    if (this.busy) {
      new Notice('Image optimization is already running.');
      return;
    }
    this.busy = true;
    try {
      await task();
    } catch (error) {
      new Notice(`Image optimization failed: ${errorText(error)}`);
      console.error('[image-optimizer]', error);
    } finally {
      this.busy = false;
    }
  }

  // benchmark measures every stage on the first image of the note without
  // changing any file, and writes the numbers to the log note.
  private async benchmark(note: TFile): Promise<void> {
    const log = new RunLog(this.app.vault);
    const notice = new Notice('WebP benchmark: running…', 0);
    try {
      log.add(`platform: ${platformName()}; ${navigator.userAgent}`);
      const source = await this.firstImage(note, log);
      if (!source) {
        log.add('no image found in the note');
        return;
      }
      const decoded = await decode(source.data);
      const { width, height } = decoded.pixels;
      log.add(`decode: ${width}×${height} (${((width * height) / 1e6).toFixed(1)} MP) in ${formatMs(decoded.ms)}`);

      const preferred = await detectVariant();
      log.add(`WebAssembly SIMD: ${preferred === 'simd' ? 'yes' : 'no'}`);
      const variants: EncoderVariant[] = preferred === 'simd' ? ['simd', 'scalar'] : ['scalar'];
      for (const variant of variants) {
        notice.setMessage(`WebP benchmark: encoding (${variant})…`);
        const { initMs } = await loadEncoder(variant);
        const encoded = await encodeWebp(decoded.pixels, { variant });
        log.add(`wasm ${variant} method ${DEFAULT_METHOD}: q${DEFAULT_QUALITY} → ${formatBytes(encoded.data.byteLength)} ` +
          `(${percentOf(encoded.data.byteLength, source.data.byteLength)} of original) ` +
          `in ${formatMs(encoded.ms)}, init ${formatMs(initMs)}`);
      }

      // method 6 matches the CLI; method 4 (libwebp's default) is the
      // candidate if phones turn out too slow.
      notice.setMessage('WebP benchmark: encoding (method 4)…');
      const faster = await encodeWebp(decoded.pixels, { variant: preferred, method: 4 });
      log.add(`wasm ${preferred} method 4: ${formatBytes(faster.data.byteLength)} in ${formatMs(faster.ms)}`);

      const canvas = await encodeWithCanvas(decoded.pixels);
      log.add(`canvas toBlob('image/webp'): got ${canvas.type}, ${formatBytes(canvas.size)} in ${formatMs(canvas.ms)}` +
        (canvas.type === 'image/webp' ? '' : ' — this platform cannot encode WebP with canvas'));
      log.add(`memory: ${memoryText()}`);
    } finally {
      notice.hide();
      await log.flush(`benchmark: ${note.path}`);
      new Notice(`WebP benchmark finished, see ${LOG_PATH}`);
    }
  }

  private async firstImage(note: TFile, log: RunLog): Promise<Downloaded | null> {
    for (const embed of this.app.metadataCache.getFileCache(note)?.embeds ?? []) {
      const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, note.path);
      if (!file) continue;
      const data = await this.app.vault.readBinary(file);
      const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
      if (!type) continue;
      log.add(`source: ${file.path} (${type}, ${formatBytes(data.byteLength)})`);
      return { data, type, ms: 0 };
    }
    const [remote] = findRemoteImages(await this.app.vault.cachedRead(note));
    if (!remote) return null;
    const downloaded = await download(remote.url);
    log.add(`source: ${remote.url} (${downloaded.type}, ${formatBytes(downloaded.data.byteLength)}, ` +
      `downloaded in ${formatMs(downloaded.ms)})`);
    return downloaded;
  }

  // convertNote downloads every remote image of the note, keeps the WebP
  // version when it is smaller, and points the embed at the local file.
  private async convertNote(note: TFile): Promise<void> {
    const log = new RunLog(this.app.vault);
    const unique = new Map<string, RemoteImage>();
    for (const image of findRemoteImages(await this.app.vault.read(note))) {
      if (!unique.has(image.url)) unique.set(image.url, image);
    }
    if (unique.size === 0) {
      new Notice('No remote images in this note.');
      return;
    }

    log.add(`platform: ${platformName()}; ${navigator.userAgent}`);
    const notice = new Notice('', 0);
    let index = 0;
    let saved = 0;
    try {
      for (const image of unique.values()) {
        index++;
        notice.setMessage(`WebP: ${index}/${unique.size}…`);
        try {
          log.add(await this.convertOne(note, image));
          saved++;
        } catch (error) {
          log.add(`failed ${image.url}: ${errorText(error)}`);
        }
      }
    } finally {
      notice.hide();
      await log.flush(`convert: ${note.path}`);
      new Notice(`WebP: ${saved}/${unique.size} image(s) saved locally, see ${LOG_PATH}`);
    }
  }

  private async convertOne(note: TFile, image: RemoteImage): Promise<string> {
    const original = await download(image.url);
    let data: ArrayBuffer = original.data;
    let extension = extensionOf(original.type);
    let detail = `${original.type} kept as is`;

    if (isConvertible(original.type)) {
      const decoded = await decode(original.data);
      const encoded = await encodeWebp(decoded.pixels, { quality: this.settings.quality, method: this.settings.method });
      if (encoded.data.byteLength < original.data.byteLength) {
        data = toArrayBuffer(encoded.data);
        extension = 'webp';
        detail = `${formatBytes(original.data.byteLength)} → ${formatBytes(data.byteLength)} ` +
          `(${percentOf(data.byteLength, original.data.byteLength)}), encoded in ${formatMs(encoded.ms)}`;
      } else {
        detail = `WebP not smaller (${formatBytes(encoded.data.byteLength)}), original kept`;
      }
    }

    const folder = resolveFolder(this.settings.folder, note.parent?.path ?? '/');
    const path = await saveNew(new ObsidianVault(this.app), folder, baseNameFromUrl(image.url), extension, data);
    const embed = new ObsidianLinks(this.app).embed(path, note.path, image.alt || undefined);
    // process() re-reads the note, so edits made during the download survive.
    await this.app.vault.process(note, (text) => replaceImages(text, new Map([[image.url, embed]])));
    return `${image.url} → ${path}: ${detail}`;
  }
}

function platformName(): string {
  if (Platform.isAndroidApp) return 'Android';
  if (Platform.isIosApp) return 'iOS';
  if (Platform.isDesktopApp) return Platform.isMacOS ? 'desktop (macOS)' : Platform.isWin ? 'desktop (Windows)' : 'desktop (Linux)';
  return 'unknown';
}

function memoryText(): string {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? `JS heap ${formatBytes(memory.usedJSHeapSize)}` : 'not reported by this platform';
}

function percentOf(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(0)}%`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
