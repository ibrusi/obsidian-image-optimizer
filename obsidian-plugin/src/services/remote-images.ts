import { resolveFolder } from '../domain/folders.ts';
import { findRemoteImages, replaceImages, type RemoteImage } from '../domain/links.ts';
import { baseNameFromUrl } from '../domain/names.ts';
import { pageUrlOf, refererFor } from '../domain/request.ts';
import type { ImageType } from '../domain/sniff.ts';
import type { PluginSettings } from '../settings.ts';
import type { Converted } from './converter.ts';
import { download, DownloadError } from './downloader.ts';
import { IDENTICAL, type ImageLibrary, REUSED } from './library.ts';
import type { HttpPort, LinkPort, VaultPort } from './ports.ts';
import type { RunStats } from './stats.ts';

export interface RemoteContext {
  vault: VaultPort;
  links: LinkPort;
  http: HttpPort;
  library: ImageLibrary;
  convert(data: ArrayBuffer, type: ImageType, signal?: AbortSignal): Promise<Converted>;
  settings: Pick<PluginSettings, 'folder' | 'maxDownloadMB' | 'allowPrivateHosts' | 'downloadPdf'>;
  stats: RunStats;
  signal?: AbortSignal;
  /**
   * URLs that failed for good earlier in this run, with the reason: a link
   * shared by many notes is not requested again. Lives for one run only, so
   * a file that comes back is found by the next run.
   */
  failedUrls?: Map<string, string>;
}

// processRemoteImages saves the web images of a note locally (as WebP when
// that is smaller) and points their embeds at the local files. Each image is
// committed on its own: an interruption keeps the work already done. With
// only, just those URLs are processed (images pasted a moment ago).
export async function processRemoteImages(
  notePath: string,
  ctx: RemoteContext,
  only?: ReadonlySet<string>,
): Promise<void> {
  const text = await ctx.vault.read(notePath);
  const find = { pdf: ctx.settings.downloadPdf };
  const urls = new Set(findRemoteImages(text, find).map((i) => i.url));
  const pageUrl = pageUrlOf(text);
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '/';

  for (const url of urls) {
    if (only && !only.has(url)) continue;
    ctx.signal?.throwIfAborted();
    const failedBefore = ctx.failedUrls?.get(url);
    if (failedBefore !== undefined) {
      ctx.stats.error(url, new Error(`${failedBefore} (failed earlier in this run, not requested again)`));
      continue;
    }
    try {
      await processOne(notePath, noteDir, url, pageUrl, ctx);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (error instanceof DownloadError && error.permanent) ctx.failedUrls?.set(url, error.message);
      ctx.stats.error(url, error);
    }
  }
}

async function processOne(notePath: string, noteDir: string, url: string, pageUrl: string | null, ctx: RemoteContext): Promise<void> {
  const downloaded = await download(ctx.http, url, {
    maxBytes: ctx.settings.maxDownloadMB * 1024 * 1024,
    allowPrivateHosts: ctx.settings.allowPrivateHosts,
    signal: ctx.signal,
    referer: refererFor(url, pageUrl),
    allowPdf: ctx.settings.downloadPdf,
  });
  const saved = await saveImage(downloaded.data, downloaded.type, downloaded.url, noteDir, ctx);
  const { path, created, size } = saved;
  const detail = downloaded.url === url ? saved.detail : `from ${downloaded.url}, ${saved.detail}`;

  let rewritten = 0;
  // process() re-reads the note: edits made during the download are kept.
  await ctx.vault.process(notePath, (text) => replaceImages(text, (image) => {
    if (image.url !== url) return undefined;
    rewritten++;
    return image.link ? ctx.links.link(path, notePath, aliasOf(image)) : ctx.links.embed(path, notePath, aliasOf(image));
  }, { pdf: ctx.settings.downloadPdf }));

  if (rewritten === 0) {
    // The embed was removed while the image was being processed. A reused
    // file is not ours to remove: other notes may link to it.
    if (created) await ctx.vault.trash(path);
    ctx.stats.skipped(url, 'the embed is no longer in the note');
    return;
  }
  ctx.stats.saved(url, downloaded.data.byteLength, size, `→ ${path}: ${detail}`);
}

interface Saved {
  path: string;
  /** False for a file that was already in the vault. */
  created: boolean;
  size: number;
  detail: string;
}

// saveImage finds the image in the vault, or converts and saves it.
async function saveImage(data: ArrayBuffer, type: ImageType, url: string, noteDir: string, ctx: RemoteContext): Promise<Saved> {
  const found = await ctx.library.find(data, type);
  if (found.path) {
    return { path: found.path, created: false, size: ctx.vault.size(found.path) ?? data.byteLength, detail: REUSED };
  }
  const converted = await ctx.convert(data, type, ctx.signal);
  ctx.signal?.throwIfAborted();
  const folder = resolveFolder(ctx.settings.folder, noteDir);
  const stored = await ctx.library.save(found.tag, folder, baseNameFromUrl(url), converted.ext, converted.data);
  return { ...stored, size: converted.data.byteLength, detail: stored.created ? converted.detail : IDENTICAL };
}

// aliasOf keeps what the embed showed: the width of an <img>, or the alt
// text of a Markdown embed (which may already carry Obsidian's "|300" size).
function aliasOf(image: RemoteImage): string | undefined {
  if (image.width) return image.width;
  return image.alt.trim() || undefined;
}
