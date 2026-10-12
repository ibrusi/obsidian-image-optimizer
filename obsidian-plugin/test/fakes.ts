import { findLocalLinks } from '../src/domain/local-links.ts';
import { tagOfFingerprint } from '../src/domain/source-tag.ts';
import { fingerprint, ImageLibrary } from '../src/services/library.ts';
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

  names(folder: string): string[] {
    const prefix = folder ? `${folder}/` : '';
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.folders]) {
      if (p && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.add(p.slice(prefix.length));
    }
    return [...names];
  }

  size(path: string): number | null {
    const data = this.files.get(path);
    if (data === undefined) return null;
    return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
  }

  async ensureFolder(folder: string): Promise<void> {
    if (folder) this.put(`${folder}/.keep`, ''), this.files.delete(`${folder}/.keep`);
  }

  allFiles(): string[] {
    return [...this.files.keys()];
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

export function memoryLibrary(vault: VaultPort, reuse = true): ImageLibrary {
  return new ImageLibrary(vault, reuse);
}

/** The source tag the library gives to an original. */
export async function tagFor(original: ArrayBuffer): Promise<string> {
  return tagOfFingerprint(await fingerprint(original));
}

/** A PNG header for width × height, padded with fill to size bytes. */
export function testPng(width: number, height: number, fill: number, size = 1000): ArrayBuffer {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}

/** An extended (VP8X) WebP header for width × height, padded to size bytes. */
export function testWebp(width: number, height: number, size = 100): ArrayBuffer {
  const bytes = new Uint8Array(Math.max(size, 30));
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  bytes.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(24, (width - 1) & 0xffffff, true);
  view.setUint32(26, (view.getUint32(26, true) & 0xff) | (((height - 1) & 0xffffff) << 8), true);
  return bytes.buffer;
}
