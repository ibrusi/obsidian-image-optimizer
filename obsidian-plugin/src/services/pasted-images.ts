import { resolveFolder } from '../domain/folders.ts';
import { pastedImageStem } from '../domain/names.ts';
import { extensionOf, imageTypeOf, type ImageType } from '../domain/sniff.ts';
import type { PluginSettings } from '../settings.ts';
import type { Converted } from './converter.ts';
import type { VaultPort } from './ports.ts';
import type { RunStats } from './stats.ts';
import { store } from './storage.ts';

export interface PasteContext {
  vault: VaultPort;
  convert(data: ArrayBuffer, type: ImageType, signal?: AbortSignal): Promise<Converted>;
  settings: Pick<PluginSettings, 'folder'>;
  stats: RunStats;
  signal?: AbortSignal;
}

// savePastedImage stores an image pasted or dropped into a note, as WebP when
// that is smaller. A pasted image exists nowhere else, so if converting fails
// for any reason the original bytes are saved: the image is never lost.
export async function savePastedImage(
  data: ArrayBuffer,
  fileName: string,
  notePath: string,
  ctx: PasteContext,
  now = new Date(),
): Promise<string | null> {
  const type = imageTypeOf(new Uint8Array(data, 0, Math.min(data.byteLength, 16)));
  if (!type) return null;

  let converted: Converted;
  try {
    converted = await ctx.convert(data, type, ctx.signal);
  } catch (error) {
    ctx.stats.lines.push(`${fileName || 'pasted image'}: saved unconverted (${error instanceof Error ? error.message : String(error)})`);
    converted = { data, ext: extensionOf(type), replaced: false, detail: 'saved unconverted' };
  }
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '/';
  const { path, created } = await store(ctx.vault, resolveFolder(ctx.settings.folder, noteDir), pastedImageStem(fileName, now), converted.ext, converted.data);
  ctx.stats.saved(fileName || 'pasted image', data.byteLength, converted.data.byteLength,
    `→ ${path}${created ? '' : ' (identical file already in the vault, reused)'}: ${converted.detail}`);
  return path;
}
