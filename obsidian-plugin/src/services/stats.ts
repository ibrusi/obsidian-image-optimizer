import type { Strings } from '../i18n.ts';
import { formatBytes, savingsPercent } from './converter.ts';

/** Prefix of a line that details the line before it; the log nests it. */
export const DETAIL = '  ';

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
    for (const detail of detailsOf(error)) this.lines.push(`${DETAIL}${detail}`);
  }

  get total(): number {
    return this.converted + this.kept + this.failed;
  }

  summary(strings: Strings): string {
    const bytes = this.bytesBefore > 0;
    return strings.summary({
      converted: this.converted,
      kept: this.kept,
      failed: this.failed,
      before: bytes ? formatBytes(this.bytesBefore) : '',
      after: bytes ? formatBytes(this.bytesAfter) : '',
      savings: savingsPercent(this.bytesBefore, this.bytesAfter),
    });
  }
}

// detailsOf returns the extra lines an error carries for the log, such as the
// requests of a failed download.
function detailsOf(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null || !('details' in error)) return [];
  const details = (error as { details: unknown }).details;
  return Array.isArray(details) ? details.filter((d): d is string => typeof d === 'string') : [];
}
