// Narrow interfaces over the Obsidian API. Services depend on these only, so
// they run unchanged against the real vault and against in-memory fakes in
// unit tests. All paths are vault paths with "/" separators.

export interface VaultPort {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Creates a new file; rejects if a file with that path already exists. */
  createBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** Atomically rewrites a text file; fn receives the current content. */
  process(path: string, fn: (text: string) => string): Promise<string>;
  exists(path: string): boolean;
  /** Lower-cased names of the entries of a folder ("" is the root). */
  names(folder: string): ReadonlySet<string>;
  ensureFolder(folder: string): Promise<void>;
  /** Moves a file into the vault's .trash folder, where it can be restored. */
  trash(path: string): Promise<void>;
}

export interface LinkPort {
  /** An embed of target written in the user's link format, relative to source. */
  embed(targetPath: string, sourcePath: string, alias?: string): string;
}

export interface HttpResponse {
  status: number;
  body: ArrayBuffer;
}

export interface HttpPort {
  get(url: string): Promise<HttpResponse>;
}
