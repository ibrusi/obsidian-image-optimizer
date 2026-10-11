import { Notice, Plugin, TFile } from 'obsidian';
import { WASM } from './codec/assets.ts';
import { type Codec, createCodec } from './codec/codec.ts';
import { decode } from './codec/decode.ts';
import { resolveFolder } from './domain/folders.ts';
import { findRemoteImages, replaceImages, type RemoteImage } from './domain/links.ts';
import { baseNameFromUrl } from './domain/names.ts';
import { extensionOf, isConvertible } from './domain/sniff.ts';
import { formatBytes, formatMs, LOG_PATH, RunLog } from './log.ts';
import { download } from './services/downloader.ts';
import { ObsidianLinks, ObsidianVault } from './services/obsidian-ports.ts';
import { saveNew } from './services/storage.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type PluginSettings } from './settings.ts';
import { ImageOptimizerSettingTab } from './ui/settings-tab.ts';

export default class ImageOptimizerPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private codec: Promise<Codec> | null = null;
  private busy = false;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));
    this.addCommand({
      id: 'convert-note',
      name: 'Download and convert remote images of the current note',
      checkCallback: (checking) => this.withActiveNote(checking, (note) => this.convertNote(note)),
    });
  }

  onunload(): void {
    void this.codec?.then((codec) => codec.dispose());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // getCodec starts the encoder on first use, so enabling the plugin costs
  // nothing until an image is converted.
  private getCodec(log: RunLog): Promise<Codec> {
    if (!this.codec) {
      this.codec = createCodec(WASM, (reason) => log.add(`worker unavailable, encoding on the main thread: ${reason}`));
      this.codec.catch(() => { this.codec = null; });
    }
    return this.codec;
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

    const codec = await this.getCodec(log);
    log.add(`encoder: ${codec.mode}, ${codec.variant}`);
    const notice = new Notice('', 0);
    let index = 0;
    let saved = 0;
    try {
      for (const image of unique.values()) {
        index++;
        notice.setMessage(`WebP: ${index}/${unique.size}…`);
        try {
          log.add(await this.convertOne(note, image, codec));
          saved++;
        } catch (error) {
          log.add(`failed ${image.url}: ${errorText(error)}`);
        }
      }
    } finally {
      notice.hide();
      if (this.settings.writeLogNote) await log.flush(`convert: ${note.path}`);
      new Notice(`WebP: ${saved}/${unique.size} image(s) saved locally` +
        (this.settings.writeLogNote ? `, see ${LOG_PATH}` : ''));
    }
  }

  private async convertOne(note: TFile, image: RemoteImage, codec: Codec): Promise<string> {
    const original = await download(image.url);
    let data: ArrayBuffer = original.data;
    let extension = extensionOf(original.type);
    let detail = `${original.type} kept as is`;

    if (isConvertible(original.type)) {
      const pixels = await decode(original.data);
      const encoded = await codec.encodeStill(pixels, { quality: this.settings.quality, method: this.settings.method });
      if (encoded.data.byteLength < original.data.byteLength) {
        data = encoded.data;
        extension = 'webp';
        detail = `${formatBytes(original.data.byteLength)} → ${formatBytes(data.byteLength)}, encoded in ${formatMs(encoded.ms)}`;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
