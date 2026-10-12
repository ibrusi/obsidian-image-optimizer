import { joinPath } from '../domain/folders.ts';
import { availableName } from '../domain/names.ts';
import type { VaultPort } from './ports.ts';

export interface Stored {
  path: string;
  /** False when an identical file already existed and is reused. */
  created: boolean;
}

// store saves data as stem.ext in folder. If a file of the same name family
// (stem.ext, stem-1.ext, …) already holds exactly these bytes, that file is
// reused instead of writing a duplicate. Otherwise the data is written under
// a free name. Existing files are never overwritten or changed.
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
  const existing = reuseIdentical ? await findIdentical(vault, folder, stem, ext, data) : null;
  if (existing) return { path: existing, created: false };
  return { path: await saveNew(vault, folder, stem, ext, data), created: true };
}

// findIdentical returns a file of the name family with exactly these bytes.
// Sizes are compared first, so only files of the same size are read.
async function findIdentical(vault: VaultPort, folder: string, stem: string, ext: string, data: ArrayBuffer): Promise<string | null> {
  const family = new RegExp(`^${escapeRegExp(stem)}(?:-\\d+)?\\.${escapeRegExp(ext)}$`, 'i');
  for (const name of vault.names(folder)) {
    if (!family.test(name)) continue;
    const path = joinPath(folder, name);
    if (vault.size(path) !== data.byteLength) continue;
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

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
