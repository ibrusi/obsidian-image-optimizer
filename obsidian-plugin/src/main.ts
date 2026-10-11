import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { WASM } from './codec/assets.ts';
import { type Codec, createCodec } from './codec/codec.ts';
import { decode } from './codec/decode.ts';
import { findRemoteImages } from './domain/links.ts';
import { LOG_PATH, RunLog } from './log.ts';
import { convert } from './services/converter.ts';
import { ObsidianHttp, ObsidianLinks, ObsidianVault } from './services/obsidian-ports.ts';
import { processRemoteImages, type RemoteContext } from './services/remote-images.ts';
import { RunStats } from './services/stats.ts';
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
  // version when it is smaller, and points the embeds at the local files.
  private async convertNote(note: TFile): Promise<void> {
    await this.flushEditors(note.path);
    const text = await this.app.vault.read(note);
    if (findRemoteImages(text).length === 0) {
      new Notice('No remote images in this note.');
      return;
    }
    const log = new RunLog(this.app.vault);
    const stats = new RunStats();
    const notice = new Notice('Optimizing images…', 0);
    try {
      const ctx = await this.context(stats, log);
      await processRemoteImages(note.path, ctx);
    } finally {
      notice.hide();
      for (const line of stats.lines) log.add(line);
      if (this.settings.writeLogNote) await log.flush(`note: ${note.path}`);
      new Notice(stats.summary() + (this.settings.writeLogNote ? `. Details: ${LOG_PATH}` : ''));
    }
  }

  // flushEditors saves editors showing the note: the plugin rewrites the
  // file on disk, and an unsaved editor buffer would later overwrite it.
  private async flushEditors(path: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
    }
  }

  private async context(stats: RunStats, log: RunLog, signal?: AbortSignal): Promise<RemoteContext> {
    const codec = await this.getCodec(log);
    log.add(`encoder: ${codec.mode}, ${codec.variant}`);
    const settings = this.settings;
    return {
      vault: new ObsidianVault(this.app),
      links: new ObsidianLinks(this.app),
      http: new ObsidianHttp(),
      convert: (data, type, s) => convert(data, type, settings, { decode, encodeStill: codec.encodeStill.bind(codec) }, s),
      settings,
      stats,
      signal,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
