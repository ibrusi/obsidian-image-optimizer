import { findLocalLinks, replaceLocalLinks, type LocalLink } from '../domain/local-links.ts';
import { imageTypeOf, type ImageType } from '../domain/sniff.ts';
import type { Converted } from './converter.ts';
import { IDENTICAL, type ImageLibrary, REUSED } from './library.ts';
import type { LinkPort, MetadataPort, VaultPort } from './ports.ts';
import type { RunStats } from './stats.ts';

const CONVERTIBLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif']);

export interface LocalContext {
  vault: VaultPort;
  links: LinkPort;
  metadata: MetadataPort;
  library: ImageLibrary;
  convert(data: ArrayBuffer, type: ImageType, signal?: AbortSignal): Promise<Converted>;
  stats: RunStats;
  /** Saves open editors of a note before the plugin rewrites it on disk. */
  flush(notePath: string): Promise<void>;
  /** Files never counted as mentioning an image, such as the plugin's log note. */
  ignoredFiles: ReadonlySet<string>;
  signal?: AbortSignal;
}

// LocalImages converts images stored in the vault. For each image embedded in
// a processed note it writes the WebP next to the original and rewrites the
// links in every note that refers to it. Originals are retired in a separate
// step, once for a whole run: retireOriginals moves an original to the
// vault's .trash only if every note was rewritten and its name is no longer
// mentioned in any note or canvas.
export class LocalImages {
  private readonly ctx: LocalContext;
  /** original path → WebP path, for originals whose links were all rewritten */
  private readonly replaced = new Map<string, string>();
  /** originals already tried in this run, whatever the outcome */
  private readonly handled = new Set<string>();

  constructor(ctx: LocalContext) {
    this.ctx = ctx;
  }

  async processNote(notePath: string): Promise<void> {
    const { vault, metadata, signal } = this.ctx;
    const originals = new Set<string>();
    for (const link of findLocalLinks(await vault.read(notePath))) {
      if (!link.embed) continue;
      const path = metadata.resolve(link.target, notePath);
      if (path && CONVERTIBLE_EXTENSIONS.has(extension(path)) && !this.handled.has(path)) originals.add(path);
    }
    for (const original of originals) {
      signal?.throwIfAborted();
      this.handled.add(original);
      try {
        await this.processImage(original, notePath);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.ctx.stats.error(original, error);
      }
    }
  }

  private async processImage(original: string, notePath: string): Promise<void> {
    const { vault, metadata, stats } = this.ctx;
    const data = await vault.readBinary(original);
    const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
    if (!type) {
      stats.skipped(original, 'not a readable image');
      return;
    }
    const name = original.slice(original.lastIndexOf('/') + 1);
    const result = await this.webpFor(original, data, type);
    if (!result) return;
    const { path: webp, created } = result;

    // Every note that links to the original, the processed one included:
    // after this, no note should point at the original any more.
    const sources = new Set([notePath, ...metadata.backlinks(original)]);
    let rewritten = 0;
    let complete = true;
    for (const source of sources) {
      try {
        await this.ctx.flush(source);
        await vault.process(source, (text) => {
          const result = replaceLocalLinks(text, (link) => this.retarget(link, source, original, webp, name));
          rewritten += result.count;
          return result.text;
        });
      } catch (error) {
        complete = false;
        stats.error(`${original} in ${source}`, error);
      }
    }

    if (rewritten === 0) {
      // Nothing points at the original any more (edited meanwhile).
      if (created) await vault.trash(webp); // a reused file may be linked elsewhere
      stats.skipped(original, 'no links left to rewrite');
      return;
    }
    stats.saved(original, data.byteLength, result.size, `→ ${webp}: ${result.detail}`);
    if (complete) this.replaced.set(original, webp);
    else stats.lines.push(`${original}: kept, not every note could be updated`);
  }

  // webpFor returns the WebP that replaces original: one already in the
  // vault for the same image, or a new one written next to the original.
  // Returns null, after logging why, when converting is not worth it.
  private async webpFor(original: string, data: ArrayBuffer, type: ImageType): Promise<WebpFile | null> {
    const { vault, library, stats, signal } = this.ctx;
    // Only a WebP replaces the original: the tag also matches the original
    // itself when it was pasted unconverted, or an unconverted copy of it.
    const found = await library.find(data, type, (path) => path !== original && extension(path) === 'webp');
    if (found.path) return { path: found.path, created: false, size: vault.size(found.path) ?? data.byteLength, detail: REUSED };

    const converted = await this.ctx.convert(data, type, signal);
    if (!converted.replaced) {
      stats.skipped(original, converted.detail);
      return null;
    }
    signal?.throwIfAborted();
    const slash = original.lastIndexOf('/');
    const folder = slash === -1 ? '' : original.slice(0, slash);
    const name = original.slice(slash + 1);
    const stem = name.slice(0, name.lastIndexOf('.')) || name;
    const stored = await library.save(found.tag, folder, stem, 'webp', converted.data);
    return { ...stored, size: converted.data.byteLength, detail: stored.created ? converted.detail : IDENTICAL };
  }

  // retarget returns the new text of a link to original, or undefined for
  // links to other files. Links are resolved by Obsidian's own rules, so
  // "photo.png", "img/photo.png" and "../img/photo.png" are all found.
  private retarget(link: LocalLink, source: string, original: string, webp: string, name: string): string | undefined {
    if (this.ctx.metadata.resolve(link.target, source) !== original) return undefined;
    // An alias that is only the old file name would keep mentioning it.
    const alias = link.alias && link.alias.trim().toLowerCase() !== name.toLowerCase() &&
      link.alias.trim() !== link.target ? link.alias : undefined;
    return link.embed ? this.ctx.links.embed(webp, source, alias) : this.ctx.links.link(webp, source, alias);
  }

  // retireOriginals moves the originals of this run to the vault's .trash
  // when no note or canvas mentions their file name any more. A mention in a
  // canvas, a plain-text path in a property or any other text keeps it.
  async retireOriginals(): Promise<void> {
    if (this.replaced.size === 0) return;
    const { vault, stats } = this.ctx;
    const mentioned = await this.findMentions([...this.replaced.keys()]);
    for (const original of this.replaced.keys()) {
      if (mentioned.has(original)) {
        stats.lines.push(`${original}: kept, its name is still mentioned in the vault`);
        continue;
      }
      try {
        await vault.trash(original);
        stats.lines.push(`${original}: moved to the vault trash`);
      } catch (error) {
        stats.error(`moving ${original} to the trash`, error);
      }
    }
    this.replaced.clear();
  }

  private async findMentions(originals: string[]): Promise<Set<string>> {
    const { vault, ignoredFiles } = this.ctx;
    const needles = originals.map((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      return { path, variants: [name, name.replace(/ /g, '%20')] };
    });
    const found = new Set<string>();
    for (const file of vault.textFiles()) {
      if (ignoredFiles.has(file)) continue;
      let text: string;
      try {
        text = (await vault.read(file)).toLowerCase();
      } catch {
        // An unreadable file may mention anything: keep every original.
        return new Set(originals);
      }
      for (const needle of needles) {
        if (!found.has(needle.path) && needle.variants.some((v) => text.includes(v))) found.add(needle.path);
      }
      if (found.size === needles.length) break;
    }
    return found;
  }
}

interface WebpFile {
  path: string;
  /** False for a file that was already in the vault. */
  created: boolean;
  size: number;
  detail: string;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}
