import { findLocalLinks } from '../domain/local-links.ts';
import { findRemoteImages } from '../domain/links.ts';
import { formatBytes, savingsPercent } from './converter.ts';
import { LocalImages, type LocalContext } from './local-images.ts';
import { processRemoteImages, type RemoteContext } from './remote-images.ts';

export interface Progress {
  done: number;
  total: number;
  note: string;
}

export interface RunOptions {
  convertLocal: boolean;
  onProgress(progress: Progress): void;
}

// optimizeNotes processes notes one after another. Notes without any image
// embed are skipped after a cheap text check. Originals of local images are
// retired once at the end, with a single scan of the vault, also after a
// cancellation: their links were already rewritten.
export async function optimizeNotes(notes: string[], ctx: RemoteContext & LocalContext, options: RunOptions): Promise<void> {
  const local = options.convertLocal ? new LocalImages(ctx) : null;
  try {
    for (let i = 0; i < notes.length; i++) {
      ctx.signal?.throwIfAborted();
      const note = notes[i];
      options.onProgress({ done: i, total: notes.length, note });
      const text = await ctx.vault.read(note);
      const hasRemote = findRemoteImages(text, { pdf: ctx.settings.downloadPdf }).length > 0;
      const hasLocal = local !== null && findLocalLinks(text).some((link) => link.embed);
      if (!hasRemote && !hasLocal) continue;
      await ctx.flush(note);
      // The note is named before its lines, once it has any: notes whose
      // images are all done already stay out of the log.
      const firstLine = ctx.stats.lines.length;
      const before = ctx.stats.bytesBefore;
      const after = ctx.stats.bytesAfter;
      try {
        if (hasRemote) await processRemoteImages(note, ctx);
        if (hasLocal) await local.processNote(note);
      } finally {
        if (ctx.stats.lines.length > firstLine) {
          ctx.stats.lines.splice(firstLine, 0, noteLine(note, ctx.stats.bytesBefore - before, ctx.stats.bytesAfter - after));
        }
      }
    }
    options.onProgress({ done: notes.length, total: notes.length, note: '' });
  } finally {
    await local?.retireOriginals();
  }
}

function noteLine(note: string, before: number, after: number): string {
  if (before <= 0) return `note: ${note}`;
  return `note: ${note} (${formatBytes(before)} → ${formatBytes(after)}, -${savingsPercent(before, after)}%)`;
}
