import { normalizePath, TFile, type Vault } from 'obsidian';

export const LOG_PATH = 'image-optimizer-log.md';

// RunLog appends results to a note: mobile apps have no developer console,
// and a note is easy to read on the device and to send back.
export class RunLog {
  private readonly lines: string[] = [];

  private readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  add(line: string): void {
    this.lines.push(line);
    console.log('[image-optimizer]', line);
  }

  async flush(title: string): Promise<void> {
    if (this.lines.length === 0) return;
    const items = this.lines.map((l) => (l.startsWith('  ') ? `  - ${l.trimStart()}` : `- ${l}`));
    const block = `\n## ${new Date().toISOString()} — ${title}\n\n${items.join('\n')}\n`;
    this.lines.length = 0;
    const path = normalizePath(LOG_PATH);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.process(existing, (text) => text + block);
    } else {
      await this.vault.create(path, `# Image Optimizer log\n${block}`);
    }
  }
}
