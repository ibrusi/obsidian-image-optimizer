import { type App, normalizePath, requestUrl, TFile, TFolder } from 'obsidian';
import type { HttpPort, LinkPort, VaultPort } from './ports.ts';

export class ObsidianVault implements VaultPort {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.file(path));
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.app.vault.createBinary(normalizePath(path), data);
  }

  process(path: string, fn: (text: string) => string): Promise<string> {
    return this.app.vault.process(this.file(path), fn);
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  names(folder: string): ReadonlySet<string> {
    const entry = folder ? this.app.vault.getAbstractFileByPath(normalizePath(folder)) : this.app.vault.getRoot();
    if (!(entry instanceof TFolder)) return new Set();
    return new Set(entry.children.map((child) => child.name.toLowerCase()));
  }

  async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const path = normalizePath(folder);
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (entry instanceof TFolder) return;
    if (entry) throw new Error(`"${path}" is a file, not a folder`);
    await this.app.vault.createFolder(path);
  }

  async trash(path: string): Promise<void> {
    // system=false: the vault's .trash folder exists on every platform and
    // keeps the original restorable, whatever the "Deleted files" setting.
    await this.app.vault.trash(this.file(path), false);
  }

  private file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error(`file not found: ${path}`);
    return file;
  }
}

export class ObsidianLinks implements LinkPort {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  embed(targetPath: string, sourcePath: string, alias?: string): string {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(targetPath));
    if (!(file instanceof TFile)) throw new Error(`file not found: ${targetPath}`);
    // The link format (wikilink or Markdown, relative or shortest path)
    // follows the user's "Files and links" settings.
    return '!' + this.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, alias);
  }
}

// ObsidianHttp goes through Obsidian's native request layer: no CORS, and it
// works in the mobile apps.
export class ObsidianHttp implements HttpPort {
  async get(url: string) {
    const response = await requestUrl({ url, method: 'GET', throw: false });
    return { status: response.status, body: response.arrayBuffer };
  }
}
