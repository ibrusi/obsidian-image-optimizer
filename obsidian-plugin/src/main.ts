import { type Command, getLanguage, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { WASM } from './codec/assets.ts';
import { type Codec, createCodec } from './codec/codec.ts';
import { decode } from './codec/decode.ts';
import { resolveLanguage, type Strings, stringsFor } from './i18n.ts';
import { LOG_PATH, RunLog } from './log.ts';
import { convert, type ConvertDeps } from './services/converter.ts';
import { JobQueue } from './services/job-queue.ts';
import { ImageLibrary } from './services/library.ts';
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
  strings: Strings = stringsFor('en');
  /** Registered commands with the key of their name, renamed when the language changes. */
  private readonly commands: Array<{ command: Command; prefix: string; key: keyof Strings['commands'] }> = [];
  private codec: Promise<Codec> | null = null;
  private codecFallback: string | null = null;
  private readonly queue = new JobQueue();

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.strings = stringsFor(resolveLanguage(this.settings.language, appLanguage()));
    this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));

    this.command('optimizeNote', {
      id: 'optimize-note',
      checkCallback: (checking) => {
        const note = this.app.workspace.getActiveFile();
        if (!note || note.extension !== 'md') return false;
        if (!checking) void this.enqueue((signal) => this.optimizeNote(note, signal));
        return true;
      },
    });
    this.command('optimizeVault', {
      id: 'optimize-vault',
      callback: () => void this.enqueue((signal) => this.optimizeVault(signal)),
    });
    this.command('stop', {
      id: 'stop',
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

  applyLanguage(): void {
    this.strings = stringsFor(resolveLanguage(this.settings.language, appLanguage()));
    for (const { command, prefix, key } of this.commands) command.name = prefix + this.strings.commands[key];
  }

  // command registers a command under its name in the current language.
  // Obsidian prefixes the name with the plugin's; the prefix is kept so the
  // command can be renamed in place when the language changes.
  private command(key: keyof Strings['commands'], command: Omit<Command, 'name'>): void {
    const name = this.strings.commands[key];
    const registered = this.addCommand({ ...command, name });
    const prefix = registered.name.endsWith(name) ? registered.name.slice(0, -name.length) : null;
    if (prefix !== null) this.commands.push({ command: registered, prefix, key });
  }

  // optimizeNote saves the web images of the note locally and converts its
  // local images, rewriting links everywhere in the vault.
  private async optimizeNote(note: TFile, signal: AbortSignal): Promise<void> {
    const run = this.newRun();
    const notice = new Notice(this.strings.notices.optimizing, 0);
    try {
      const ctx = await this.context(run, signal);
      await optimizeNotes([note.path], ctx, { convertLocal: this.settings.convertLocal, onProgress: () => {} });
    } finally {
      notice.hide();
      await this.report(run, `note: ${note.path}`, run.stats.total === 0 ? this.strings.notices.noImages : undefined);
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
    const modal = new ProgressModal(this.app, this.strings, () => stop.abort(new DOMException('Cancelled', 'AbortError')));
    modal.open();
    try {
      const ctx = await this.context(run, stop.signal);
      await optimizeNotes(notes, ctx, {
        convertLocal: this.settings.convertLocal,
        onProgress: (progress) => modal.update(progress, run.stats.summary(this.strings)),
      });
    } finally {
      modal.finish();
      await this.report(run, 'vault', `${stop.signal.aborted ? this.strings.notices.stopped : ''}${run.stats.summary(this.strings)}`);
    }
  }

  private readonly pasteActions: PasteActions = {
    enabled: () => this.settings.autoOnPaste,
    placeholder: () => this.strings.placeholder,
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
      new Notice(this.strings.notices.placeDeleted(embeds.join(', ')), 10_000);
    }
    await this.report(run, `paste: ${notePath}`, null);
  }

  // enqueue runs a job after the ones already queued. Jobs share one queue:
  // encoding is memory-hungry on phones. A cancelled job reports itself.
  private async enqueue(job: (signal: AbortSignal) => Promise<void>, cancellable = true): Promise<void> {
    if (this.queue.busy && cancellable) new Notice(this.strings.notices.queued);
    try {
      await this.queue.run(job, cancellable);
    } catch (error) {
      if (isAbort(error)) return;
      new Notice(this.strings.notices.failed(errorText(error)));
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
    const details = this.settings.writeLogNote ? this.strings.notices.details(LOG_PATH) : '';
    new Notice((message ?? run.stats.summary(this.strings)) + details, 10_000);
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
    const vault = new ObsidianVault(this.app);
    return {
      vault,
      library: new ImageLibrary(vault, settings.reuseIdentical),
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

// appLanguage returns the Obsidian interface language. getLanguage exists
// since Obsidian 1.8.7; older versions keep the language in local storage,
// where no value means English.
function appLanguage(): string {
  if (typeof getLanguage === 'function') return getLanguage();
  try {
    return window.localStorage.getItem('language') ?? 'en';
  } catch {
    return 'en';
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
