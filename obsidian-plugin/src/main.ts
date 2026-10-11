import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { WASM } from './codec/assets.ts';
import { type Codec, createCodec } from './codec/codec.ts';
import { decode } from './codec/decode.ts';
import { LOG_PATH, RunLog } from './log.ts';
import { convert, type ConvertDeps } from './services/converter.ts';
import { JobQueue } from './services/job-queue.ts';
import type { LocalContext } from './services/local-images.ts';
import { ObsidianHttp, ObsidianLinks, ObsidianMetadata, ObsidianVault } from './services/obsidian-ports.ts';
import { savePastedImage } from './services/pasted-images.ts';
import { processRemoteImages, type RemoteContext } from './services/remote-images.ts';
import { RunStats } from './services/stats.ts';
import { optimizeNotes } from './services/vault-run.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type PluginSettings } from './settings.ts';
import { handleDrop, handlePaste, replacePlaceholder, type PasteActions, type Placeholder } from './ui/paste-handler.ts';
import { ProgressModal } from './ui/progress-modal.ts';
import { ImageOptimizerSettingTab } from './ui/settings-tab.ts';

type RunContext = RemoteContext & LocalContext;

interface Run {
  stats: RunStats;
  log: RunLog;
}

export default class ImageOptimizerPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private codec: Promise<Codec> | null = null;
  private codecFallback: string | null = null;
  private readonly queue = new JobQueue();

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));

    this.addCommand({
      id: 'optimize-note',
      name: 'Optimize images in the current note',
      checkCallback: (checking) => {
        const note = this.app.workspace.getActiveFile();
        if (!note || note.extension !== 'md') return false;
        if (!checking) void this.enqueue((signal) => this.optimizeNote(note, signal));
        return true;
      },
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

    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor, info) => handlePaste(evt, editor, info, this.pasteActions)));
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor, info) => handleDrop(evt, editor, info, this.pasteActions)));
  }

  onunload(): void {
    this.queue.cancelAll();
    void this.codec?.then((codec) => codec.dispose());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // optimizeNote saves the web images of the note locally and converts its
  // local images, rewriting links everywhere in the vault.
  private async optimizeNote(note: TFile, signal: AbortSignal): Promise<void> {
    const run = this.newRun();
    const notice = new Notice('Optimizing images…', 0);
    try {
      const ctx = await this.context(run, signal);
      await optimizeNotes([note.path], ctx, { convertLocal: this.settings.convertLocal, onProgress: () => {} });
    } finally {
      notice.hide();
      await this.report(run, `note: ${note.path}`, run.stats.total === 0 ? 'No images to optimize in this note.' : undefined);
    }
  }

  // optimizeVault processes every note, with a progress window that can stop it.
  private async optimizeVault(signal: AbortSignal): Promise<void> {
    const notes = this.app.vault.getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => path !== LOG_PATH)
      .sort((a, b) => a.localeCompare(b));
    const run = this.newRun();
    // The window's Stop button and the "Stop" command both end the run.
    const stop = new AbortController();
    signal.addEventListener('abort', () => stop.abort(signal.reason), { once: true });
    const modal = new ProgressModal(this.app, () => stop.abort(new DOMException('Cancelled', 'AbortError')));
    modal.open();
    try {
      const ctx = await this.context(run, stop.signal);
      await optimizeNotes(notes, ctx, {
        convertLocal: this.settings.convertLocal,
        onProgress: (progress) => modal.update(progress, run.stats.summary()),
      });
    } finally {
      modal.finish();
      await this.report(run, 'vault', `${stop.signal.aborted ? 'Stopped. ' : ''}${run.stats.summary()}`);
    }
  }

  private readonly pasteActions: PasteActions = {
    enabled: () => this.settings.autoOnPaste,
    saveImages: (files, notePath, placeholder) => {
      // The clipboard is read right away, and the job is not cancellable:
      // a pasted image exists nowhere else, so it is always saved.
      const contents = Promise.all(files.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })));
      void this.enqueue(() => this.savePasted(contents, notePath, placeholder), false);
    },
    saveRemote: (notePath, urls) => {
      void this.enqueue(async (signal) => {
        await sleep(100); // let the paste land in the editor first
        await this.flushEditors(notePath);
        const run = this.newRun();
        try {
          await processRemoteImages(notePath, await this.context(run, signal), urls);
        } finally {
          await this.report(run, `paste: ${notePath}`, null);
        }
      });
    },
  };

  private async savePasted(contents: Promise<Array<{ name: string; data: ArrayBuffer }>>, notePath: string, placeholder: Placeholder): Promise<void> {
    const run = this.newRun();
    const ctx = await this.context(run);
    const embeds: string[] = [];
    for (const file of await contents) {
      try {
        const path = await savePastedImage(file.data, file.name, notePath, ctx);
        if (path) embeds.push(ctx.links.embed(path, notePath));
      } catch (error) {
        run.stats.error(file.name || 'pasted image', error);
      }
    }
    const placed = await replacePlaceholder(placeholder, embeds.join('\n'), (fn) => this.app.vault.process(this.noteFile(notePath), fn));
    if (!placed && embeds.length > 0) {
      new Notice(`The pasted image was saved, but its place in the note was deleted: ${embeds.join(', ')}`, 10_000);
    }
    await this.report(run, `paste: ${notePath}`, null);
  }

  // enqueue runs a job after the ones already queued. Jobs share one queue:
  // encoding is memory-hungry on phones. A cancelled job reports itself.
  private async enqueue(job: (signal: AbortSignal) => Promise<void>, cancellable = true): Promise<void> {
    if (this.queue.busy && cancellable) new Notice('Image optimization will start when the current one finishes.');
    try {
      await this.queue.run(job, cancellable);
    } catch (error) {
      if (isAbort(error)) return;
      new Notice(`Image optimization failed: ${errorText(error)}`);
      console.error('[image-optimizer]', error);
    }
  }

  private newRun(): Run {
    return { stats: new RunStats(), log: new RunLog(this.app.vault) };
  }

  // report shows the outcome of a run. message overrides the summary; null
  // keeps quiet unless something failed (pastes should not chatter).
  private async report(run: Run, title: string, message?: string | null): Promise<void> {
    for (const line of run.stats.lines) run.log.add(line);
    if (this.settings.writeLogNote) await run.log.flush(title);
    if (message === null && run.stats.failed === 0) return;
    const details = this.settings.writeLogNote ? `. Details: ${LOG_PATH}` : '';
    new Notice((message ?? run.stats.summary()) + details, 10_000);
  }

  private async context(run: Run, signal?: AbortSignal): Promise<RunContext> {
    const codec = await this.getCodec();
    run.log.add(`encoder: ${codec.mode}, ${codec.variant}${this.codecFallback ? ` (${this.codecFallback})` : ''}`);
    const deps: ConvertDeps = {
      decode,
      encodeStill: (pixels, options, s) => codec.encodeStill(pixels, options, s),
      encodeAnimation: (animation, options, s) => codec.encodeAnimation(animation, options, s),
    };
    const settings = this.settings;
    return {
      vault: new ObsidianVault(this.app),
      links: new ObsidianLinks(this.app),
      metadata: new ObsidianMetadata(this.app),
      http: new ObsidianHttp(),
      convert: (data, type, s) => convert(data, type, settings, deps, s),
      settings,
      stats: run.stats,
      flush: (path) => this.flushEditors(path),
      ignoredFiles: new Set([LOG_PATH]),
      signal,
    };
  }

  // getCodec starts the encoder on first use, so enabling the plugin costs
  // nothing until an image is converted.
  private getCodec(): Promise<Codec> {
    if (!this.codec) {
      this.codec = createCodec(WASM, (reason) => {
        this.codecFallback = `worker unavailable: ${reason}`;
      });
      this.codec.catch(() => {
        this.codec = null;
      });
    }
    return this.codec;
  }

  // flushEditors saves editors showing the note: the plugin rewrites the
  // file on disk, and an unsaved editor buffer would later overwrite it.
  private async flushEditors(path: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
    }
  }

  private noteFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`note not found: ${path}`);
    return file;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
