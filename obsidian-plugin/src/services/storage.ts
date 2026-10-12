import { joinPath } from '../domain/folders.ts';
import { availableName } from '../domain/names.ts';
import type { VaultPort } from './ports.ts';

export interface Stored {
  path: string;
  /** False when an identical file already existed and is reused. */
  created: boolean;
}

// store saves data as stem.ext in folder. If a file anywhere in the vault
// already holds exactly these bytes with the same extension, that file is
// reused instead of writing a duplicate: the same picture pasted from the
// clipboard and downloaded from the web differs as PNG but encodes to the
// same WebP. Otherwise the data is written under a free name. Existing files
// are never overwritten or changed.
//
// Only a file with created=true belongs to the caller: a reused file may be
// linked from other notes and must never be removed by the caller. With
// reuseIdentical=false a new file is always written.
export async function store(
  vault: VaultPort,
  folder: string,
  stem: string,
  ext: string,
  data: ArrayBuffer,
  reuseIdentical: boolean,
): Promise<Stored> {
  const existing = reuseIdentical ? await findIdentical(vault, folder, ext, data) : null;
  if (existing) return { path: existing, created: false };
  return { path: await saveNew(vault, folder, stem, ext, data), created: true };
}

// findIdentical returns a file with exactly these bytes and extension, from
// the target folder first. Candidates are picked by the sizes Obsidian keeps
// in memory, so only files of exactly the same size are read; between
// different images that is rare.
async function findIdentical(vault: VaultPort, folder: string, ext: string, data: ArrayBuffer): Promise<string | null> {
  const suffix = `.${ext.toLowerCase()}`;
  const inFolder = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) === folder;
  const candidates = vault.allFiles()
    .filter((path) => path.toLowerCase().endsWith(suffix) && vault.size(path) === data.byteLength)
    .sort((a, b) => Number(!inFolder(a)) - Number(!inFolder(b)) || a.localeCompare(b));
  for (const path of candidates) {
    try {
      if (sameBytes(await vault.readBinary(path), data)) return path;
    } catch {
      // Unreadable: not a match, a new file is written instead.
    }
  }
  return null;
}

// saveNew writes data under a free name in folder and returns its path; it
// never overwrites a file. A name taken between the check and the write (a
// sync client, another plugin) is retried with the next free name.
export async function saveNew(vault: VaultPort, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<string> {
  await vault.ensureFolder(folder);
  const attempted = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = new Set([...vault.names(folder).map((n) => n.toLowerCase()), ...attempted]);
    const name = availableName(taken, stem, ext);
    const path = joinPath(folder, name);
    try {
      await vault.createBinary(path, data);
      return path;
    } catch (error) {
      if (!vault.exists(path)) throw error;
      attempted.add(name.toLowerCase());
    }
  }
  throw new Error(`could not find a free name for ${stem}.${ext} in "${folder || '/'}"`);
}

export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
