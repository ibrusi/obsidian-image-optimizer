import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { WASM } from './codec/assets.ts';
import { type Codec, createCodec } from './codec/codec.ts';
import { decode } from './codec/decode.ts';
import { LOG_PATH, RunLog } from './log.ts';
import { convert } from './services/converter.ts';
import { JobQueue } from './services/job-queue.ts';
import type { LocalContext } from './services/local-images.ts';
import { ObsidianHttp, ObsidianLinks, ObsidianMetadata, ObsidianVault } from './services/obsidian-ports.ts';
import type { RemoteContext } from './services/remote-images.ts';
import { RunStats } from './services/stats.ts';
import { optimizeNotes } from './services/vault-run.ts';
import { ProgressModal } from './ui/progress-modal.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type PluginSettings } from './settings.ts';
import { ImageOptimizerSettingTab } from './ui/settings-tab.ts';

export default class ImageOptimizerPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private codec: Promise<Codec> | null = null;
  private readonly queue = new JobQueue();

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));
    this.addCommand({
      id: 'optimize-note',
      name: 'Optimize images in the current note',
      checkCallback: (checking) => this.withActiveNote(checking, (note, signal) => this.optimizeNote(note, signal)),
    });
    this.addCommand({
      id: 'optimize-vault',
      name: 'Optimize images in the whole vault',
      callback: () => void this.enqueue((signal) => this.optimizeVault(signal)),
    });
    this.addCommand({
      id: 'stop',
      name: 'Stop image optimization',
      checkCallback: (checking) => {
        if (!this.queue.busy) return false;
        if (!checking) this.queue.cancelAll();
        return true;
      },
    });
  }

  onunload(): void {
    this.queue.cancelAll();
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

  private withActiveNote(checking: boolean, run: (note: TFile, signal: AbortSignal) => Promise<void>): boolean {
    const note = this.app.workspace.getActiveFile();
    if (!note || note.extension !== 'md') return false;
    if (!checking) void this.enqueue((signal) => run(note, signal));
    return true;
  }

  // enqueue runs a job after the ones already queued. Jobs share one queue:
  // encoding is memory-hungry on phones.
  private async enqueue(job: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.queue.busy) new Notice('Image optimization will start when the current one finishes.');
    try {
      await this.queue.run(job);
    } catch (error) {
      if (isAbort(error)) {
        new Notice('Image optimization stopped.');
        return;
      }
      new Notice(`Image optimization failed: ${errorText(error)}`);
      console.error('[image-optimizer]', error);
    }
  }

  // optimizeNote saves the web images of the note locally and converts its
  // local images, rewriting links everywhere in the vault.
  private async optimizeNote(note: TFile, signal: AbortSignal): Promise<void> {
    await this.flushEditors(note.path);
    const log = new RunLog(this.app.vault);
    const stats = new RunStats();
    const notice = new Notice('Optimizing images…', 0);
    try {
      const ctx = await this.context(stats, log, signal);
      await optimizeNotes([note.path], ctx, { convertLocal: this.settings.convertLocal, onProgress: () => {} });
    } finally {
      notice.hide();
      for (const line of stats.lines) log.add(line);
      if (this.settings.writeLogNote) await log.flush(`note: ${note.path}`);
      new Notice(stats.total === 0 ? 'No images to optimize in this note.'
        : stats.summary() + (this.settings.writeLogNote ? `. Details: ${LOG_PATH}` : ''));
    }
  }

  // optimizeVault processes every note, with a progress window that can stop it.
  private async optimizeVault(signal: AbortSignal): Promise<void> {
    const notes = this.app.vault.getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => path !== LOG_PATH)
      .sort((a, b) => a.localeCompare(b));
    const log = new RunLog(this.app.vault);
    const stats = new RunStats();
    const stop = new AbortController();
    signal.addEventListener('abort', () => stop.abort(signal.reason), { once: true });
    const modal = new ProgressModal(this.app, () => stop.abort(new DOMException('Cancelled', 'AbortError')));
    modal.open();
    try {
      const ctx = await this.context(stats, log, stop.signal);
      await optimizeNotes(notes, ctx, {
        convertLocal: this.settings.convertLocal,
        onProgress: (progress) => modal.update(progress, stats.summary()),
      });
    } finally {
      modal.finish();
      for (const line of stats.lines) log.add(line);
      if (this.settings.writeLogNote) await log.flush('vault');
      new Notice(`${stop.signal.aborted ? 'Stopped. ' : ''}${stats.summary()}` +
        (this.settings.writeLogNote ? `. Details: ${LOG_PATH}` : ''), 10_000);
    }
  }

  // flushEditors saves editors showing the note: the plugin rewrites the
  // file on disk, and an unsaved editor buffer would later overwrite it.
  private async flushEditors(path: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
    }
  }

  private async context(stats: RunStats, log: RunLog, signal?: AbortSignal): Promise<RemoteContext & LocalContext> {
    const codec = await this.getCodec(log);
    log.add(`encoder: ${codec.mode}, ${codec.variant}`);
    const settings = this.settings;
    return {
      vault: new ObsidianVault(this.app),
      links: new ObsidianLinks(this.app),
      http: new ObsidianHttp(),
      convert: (data, type, s) => convert(data, type, settings, { decode, encodeStill: codec.encodeStill.bind(codec), encodeAnimation: codec.encodeAnimation.bind(codec) }, s),
      metadata: new ObsidianMetadata(this.app),
      settings,
      stats,
      flush: (path) => this.flushEditors(path),
      ignoredFiles: new Set([LOG_PATH]),
      signal,
    };
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
