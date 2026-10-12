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
  /** Names of the entries of a folder ("" is the root), as stored. */
  names(folder: string): string[];
  /** Size in bytes of a file, or null if there is no such file. */
  size(path: string): number | null;
  ensureFolder(folder: string): Promise<void>;
  /** Moves a file into the vault's .trash folder, where it can be restored. */
  trash(path: string): Promise<void>;
  /** Paths of every file in the vault, from the vault's in-memory list. */
  allFiles(): string[];
  /** Paths of every note and canvas: the files that can refer to an image. */
  textFiles(): string[];
}

export interface MetadataPort {
  /** The file a link path in sourcePath points to, the way Obsidian resolves it. */
  resolve(linkpath: string, sourcePath: string): string | null;
  /** Notes that link to targetPath, according to Obsidian's link index. */
  backlinks(targetPath: string): string[];
}

export interface LinkPort {
  /** A link to target written in the user's link format, relative to source. */
  link(targetPath: string, sourcePath: string, alias?: string): string;
  /** The same as link, as an embed. */
  embed(targetPath: string, sourcePath: string, alias?: string): string;
}

export interface HttpResponse {
  status: number;
  body: ArrayBuffer;
  /** Response headers, names in lower case, when the platform reports them. */
  headers?: Record<string, string>;
}

export interface HttpPort {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}
