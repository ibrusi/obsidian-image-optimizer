// SourceIndex remembers, for every image the plugin saved, which vault file
// holds it, keyed by a fingerprint of the original bytes (the download, the
// pasted file, the local original). The same image added again is then
// recognised before encoding, whatever encoding settings were used when it
// was first saved: encoded bytes change with them, the original does not.
//
// The index is a cache, never the source of truth: an entry is used only if
// its file still exists, and a missing or broken index only means images
// are encoded again.

export interface IndexStorage {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

const VERSION = 1;

export class SourceIndex {
  private readonly storage: IndexStorage;
  private readonly entries: Map<string, string>;
  private dirty = false;

  private constructor(storage: IndexStorage, entries: Map<string, string>) {
    this.storage = storage;
    this.entries = entries;
  }

  // empty starts an index without entries, saved to storage.
  static empty(storage: IndexStorage): SourceIndex {
    return new SourceIndex(storage, new Map());
  }

  // open loads the index; unreadable or foreign data starts an empty one.
  static async open(storage: IndexStorage): Promise<SourceIndex> {
    let raw: unknown;
    try {
      raw = await storage.load();
    } catch {
      raw = null;
    }
    return new SourceIndex(storage, parse(raw));
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, path: string): void {
    if (this.entries.get(key) === path) return;
    this.entries.set(key, path);
    this.dirty = true;
  }

  // renamed follows a file or folder moved in the vault.
  renamed(oldPath: string, newPath: string): void {
    for (const [key, path] of this.entries) {
      if (path === oldPath) this.set(key, newPath);
      else if (path.startsWith(`${oldPath}/`)) this.set(key, newPath + path.slice(oldPath.length));
    }
  }

  // removed forgets the files at path, or inside it for a folder.
  removed(path: string): void {
    for (const [key, entry] of this.entries) {
      if (entry === path || entry.startsWith(`${path}/`)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.storage.save({ version: VERSION, sources: Object.fromEntries(this.entries) });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

function parse(raw: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (typeof raw !== 'object' || raw === null) return entries;
  const { version, sources } = raw as { version?: unknown; sources?: unknown };
  if (version !== VERSION || typeof sources !== 'object' || sources === null) return entries;
  for (const [key, path] of Object.entries(sources)) {
    if (/^[0-9a-f]{64}$/.test(key) && typeof path === 'string' && path) entries.set(key, path);
  }
  return entries;
}

// fingerprint returns the SHA-256 of data as hex.
export async function fingerprint(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
