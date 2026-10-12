import { resolveFolder } from '../domain/folders.ts';
import { pastedImageStem } from '../domain/names.ts';
import { extensionOf, imageTypeOf, type ImageType } from '../domain/sniff.ts';
import type { PluginSettings } from '../settings.ts';
import type { Converted } from './converter.ts';
import { IDENTICAL, type ImageLibrary, REUSED } from './library.ts';
import type { VaultPort } from './ports.ts';
import type { RunStats } from './stats.ts';

export interface PasteContext {
  vault: VaultPort;
  library: ImageLibrary;
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
  const label = fileName || 'pasted image';

  const found = await ctx.library.find(data);
  if (found.path) {
    ctx.stats.saved(label, data.byteLength, ctx.vault.size(found.path) ?? data.byteLength, `→ ${found.path}: ${REUSED}`);
    return found.path;
  }

  let converted: Converted;
  try {
    converted = await ctx.convert(data, type, ctx.signal);
  } catch (error) {
    ctx.stats.lines.push(`${label}: saved unconverted (${error instanceof Error ? error.message : String(error)})`);
    converted = { data, ext: extensionOf(type), replaced: false, detail: 'saved unconverted' };
  }
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '/';
  const folder = resolveFolder(ctx.settings.folder, noteDir);
  const { path, created } = await ctx.library.save(found.key, folder, pastedImageStem(fileName, now), converted.ext, converted.data);
  ctx.stats.saved(label, data.byteLength, converted.data.byteLength, `→ ${path}: ${created ? converted.detail : IDENTICAL}`);
  return path;
}
