import { formatBytes } from './converter.ts';

// RunStats collects the outcome of one run for the summary notice and the
// optional log note.
export class RunStats {
  converted = 0;
  kept = 0;
  failed = 0;
  bytesBefore = 0;
  bytesAfter = 0;
  readonly lines: string[] = [];

  saved(label: string, before: number, after: number, detail: string): void {
    if (after < before) this.converted++;
    else this.kept++;
    this.bytesBefore += before;
    this.bytesAfter += after;
    this.lines.push(`${label}: ${detail}`);
  }

  skipped(label: string, reason: string): void {
    this.kept++;
    this.lines.push(`${label}: ${reason}`);
  }

  error(label: string, error: unknown): void {
    this.failed++;
    this.lines.push(`failed ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  get total(): number {
    return this.converted + this.kept + this.failed;
  }

  summary(): string {
    const parts = [`${this.converted} image(s) converted`];
    if (this.bytesBefore > 0) parts.push(`${formatBytes(this.bytesBefore)} → ${formatBytes(this.bytesAfter)}`);
    if (this.kept) parts.push(`${this.kept} kept as is`);
    if (this.failed) parts.push(`${this.failed} failed`);
    return parts.join(', ');
  }
}
