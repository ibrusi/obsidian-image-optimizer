import { resolveFolder } from '../domain/folders.ts';
import { findRemoteImages, replaceImages, type RemoteImage } from '../domain/links.ts';
import { baseNameFromUrl } from '../domain/names.ts';
import type { ImageType } from '../domain/sniff.ts';
import type { PluginSettings } from '../settings.ts';
import type { Converted } from './converter.ts';
import { download } from './downloader.ts';
import type { HttpPort, LinkPort, VaultPort } from './ports.ts';
import type { RunStats } from './stats.ts';
import { store } from './storage.ts';

export interface RemoteContext {
  vault: VaultPort;
  links: LinkPort;
  http: HttpPort;
  convert(data: ArrayBuffer, type: ImageType, signal?: AbortSignal): Promise<Converted>;
  settings: Pick<PluginSettings, 'folder' | 'maxDownloadMB' | 'allowPrivateHosts'>;
  stats: RunStats;
  signal?: AbortSignal;
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
  const urls = new Set(findRemoteImages(await ctx.vault.read(notePath)).map((i) => i.url));
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '/';

  for (const url of urls) {
    if (only && !only.has(url)) continue;
    ctx.signal?.throwIfAborted();
    try {
      await processOne(notePath, noteDir, url, ctx);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      ctx.stats.error(url, error);
    }
  }
}

async function processOne(notePath: string, noteDir: string, url: string, ctx: RemoteContext): Promise<void> {
  const downloaded = await download(ctx.http, url, {
    maxBytes: ctx.settings.maxDownloadMB * 1024 * 1024,
    allowPrivateHosts: ctx.settings.allowPrivateHosts,
    signal: ctx.signal,
  });
  const converted = await ctx.convert(downloaded.data, downloaded.type, ctx.signal);
  ctx.signal?.throwIfAborted();

  const folder = resolveFolder(ctx.settings.folder, noteDir);
  const { path, created } = await store(ctx.vault, folder, baseNameFromUrl(url), converted.ext, converted.data);

  let rewritten = 0;
  // process() re-reads the note: edits made during the download are kept.
  await ctx.vault.process(notePath, (text) => replaceImages(text, (image) => {
    if (image.url !== url) return undefined;
    rewritten++;
    return ctx.links.embed(path, notePath, aliasOf(image));
  }));

  if (rewritten === 0) {
    // The embed was removed while the image was being processed. A reused
    // file is not ours to remove: other notes may link to it.
    if (created) await ctx.vault.trash(path);
    ctx.stats.skipped(url, 'the embed is no longer in the note');
    return;
  }
  ctx.stats.saved(url, downloaded.data.byteLength, converted.data.byteLength,
    `→ ${path}${created ? '' : ' (identical file already in the vault, reused)'}: ${converted.detail}`);
}

// aliasOf keeps what the embed showed: the width of an <img>, or the alt
// text of a Markdown embed (which may already carry Obsidian's "|300" size).
function aliasOf(image: RemoteImage): string | undefined {
  if (image.width) return image.width;
  return image.alt.trim() || undefined;
}
