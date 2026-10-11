import { findLocalLinks } from '../src/domain/local-links.ts';
import type { HttpPort, HttpResponse, LinkPort, MetadataPort, VaultPort } from '../src/services/ports.ts';

// MemoryVault is an in-memory VaultPort with the same no-clobber and
// case-insensitive name semantics as a real vault on desktop and mobile.
export class MemoryVault implements VaultPort {
  readonly files = new Map<string, ArrayBuffer | string>();
  readonly folders = new Set<string>(['']);
  readonly trashed: string[] = [];

  constructor(initial: Record<string, ArrayBuffer | string> = {}) {
    for (const [path, data] of Object.entries(initial)) this.put(path, data);
  }

  put(path: string, data: ArrayBuffer | string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
    this.files.set(path, data);
  }

  text(path: string): string {
    const data = this.files.get(path);
    if (typeof data !== 'string') throw new Error(`not a text file: ${path}`);
    return data;
  }

  async read(path: string): Promise<string> {
    return this.text(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`file not found: ${path}`);
    return typeof data === 'string' ? new TextEncoder().encode(data).buffer as ArrayBuffer : data;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (this.exists(path)) throw new Error(`File already exists: ${path}`);
    this.put(path, data);
  }

  async process(path: string, fn: (text: string) => string): Promise<string> {
    const next = fn(this.text(path));
    this.files.set(path, next);
    return next;
  }

  exists(path: string): boolean {
    const lower = path.toLowerCase();
    return [...this.files.keys(), ...this.folders].some((p) => p.toLowerCase() === lower);
  }

  names(folder: string): ReadonlySet<string> {
    const prefix = folder ? `${folder}/` : '';
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.folders]) {
      if (p && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.add(p.slice(prefix.length).toLowerCase());
    }
    return names;
  }

  async ensureFolder(folder: string): Promise<void> {
    if (folder) this.put(`${folder}/.keep`, ''), this.files.delete(`${folder}/.keep`);
  }

  textFiles(): string[] {
    return [...this.files.keys()].filter((p) => p.endsWith('.md') || p.endsWith('.canvas'));
  }

  async trash(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`file not found: ${path}`);
    this.trashed.push(path);
  }
}

export class FakeLinks implements LinkPort {
  link(targetPath: string, _sourcePath: string, alias?: string): string {
    return `[[${targetPath}${alias ? `|${alias}` : ''}]]`;
  }

  embed(targetPath: string, sourcePath: string, alias?: string): string {
    return '!' + this.link(targetPath, sourcePath, alias);
  }
}

// FakeMetadata resolves links like Obsidian: relative to the note, from the
// vault root, then by unique file name; backlinks come from note contents.
export class FakeMetadata implements MetadataPort {
  private readonly vault: MemoryVault;

  constructor(vault: MemoryVault) {
    this.vault = vault;
  }

  resolve(linkpath: string, sourcePath: string): string | null {
    const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
    for (const candidate of [normalize(dir + linkpath), normalize(linkpath)]) {
      if (this.vault.files.has(candidate)) return candidate;
    }
    const byName = [...this.vault.files.keys()].filter((p) => p === linkpath || p.endsWith(`/${linkpath}`));
    return byName.length === 1 ? byName[0] : null;
  }

  backlinks(targetPath: string): string[] {
    return this.vault.textFiles().filter((source) => source.endsWith('.md') &&
      findLocalLinks(this.vault.text(source)).some((l) => this.resolve(l.target, source) === targetPath));
  }
}

export class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  private readonly routes: Record<string, HttpResponse | Error>;

  constructor(routes: Record<string, HttpResponse | Error>) {
    this.routes = routes;
  }

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    const route = this.routes[url];
    if (route === undefined) return { status: 404, body: new ArrayBuffer(0) };
    if (route instanceof Error) throw route;
    return route;
  }
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
