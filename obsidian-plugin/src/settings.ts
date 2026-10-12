import { normalizeFolder, validateFolder } from './domain/folders.ts';
import type { LanguageSetting } from './i18n.ts';

export type GifMode = 'animated-webp' | 'keep';

export interface PluginSettings {
  /** Interface language; "auto" follows Obsidian. */
  language: LanguageSetting;
  /** Folder for downloaded and pasted images, see domain/folders.ts. */
  folder: string;
  /** WebP quality, 1–100. */
  quality: number;
  /** libwebp effort, 0–6: 4 is the libwebp default, 6 matches the CLI and is several times slower. */
  method: number;
  /** Replace an image only if the WebP is at least this many percent smaller. */
  minSavingsPercent: number;
  gifMode: GifMode;
  /** Commands also convert images already stored in the vault. */
  convertLocal: boolean;
  /** Convert images pasted or dropped into a note, and remote images in pasted text. */
  autoOnPaste: boolean;
  /** Link a byte-identical file of the same name instead of saving a copy. */
  reuseIdentical: boolean;
  /** Also download PDF files that notes embed or link to, saved as they are. */
  downloadPdf: boolean;
  maxDownloadMB: number;
  /** Decoded size limit; for GIFs width × height × frames. */
  maxMegapixels: number;
  allowPrivateHosts: boolean;
  /** Append details of every run to a note, for troubleshooting. */
  writeLogNote: boolean;
}

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  language: 'auto',
  folder: 'Attachments',
  quality: 40,
  method: 4,
  minSavingsPercent: 5,
  gifMode: 'animated-webp',
  convertLocal: true,
  autoOnPaste: true,
  reuseIdentical: true,
  downloadPdf: false,
  maxDownloadMB: 30,
  maxMegapixels: 50,
  allowPrivateHosts: false,
  writeLogNote: false,
});

export const LIMITS = {
  quality: [1, 100],
  method: [0, 6],
  minSavingsPercent: [0, 90],
  maxDownloadMB: [1, 500],
  maxMegapixels: [1, 1000],
} as const satisfies Record<string, readonly [number, number]>;

// normalizeSettings turns whatever data.json holds (nothing, an older
// version, hand edits, the 1.x settings of the Go-backed plugin) into valid
// settings: unknown keys are dropped and numbers are clamped to their limits.
export function normalizeSettings(raw: unknown): PluginSettings {
  const data = isRecord(raw) ? raw : {};
  const legacyFolder = typeof data.attachedDir === 'string' ? data.attachedDir : undefined;
  const folderInput = typeof data.folder === 'string' ? data.folder : legacyFolder;
  const folder = folderInput !== undefined && validateFolder(folderInput) === null
    ? normalizeFolder(folderInput)
    : DEFAULT_SETTINGS.folder;

  return {
    language: data.language === 'en' || data.language === 'ru' ? data.language : 'auto',
    folder,
    quality: clampInt(data.quality, 'quality'),
    method: clampInt(data.method, 'method'),
    minSavingsPercent: clampInt(data.minSavingsPercent, 'minSavingsPercent'),
    gifMode: data.gifMode === 'keep' ? 'keep' : 'animated-webp',
    convertLocal: bool(data.convertLocal, DEFAULT_SETTINGS.convertLocal),
    autoOnPaste: bool(data.autoOnPaste, DEFAULT_SETTINGS.autoOnPaste),
    reuseIdentical: bool(data.reuseIdentical, DEFAULT_SETTINGS.reuseIdentical),
    downloadPdf: bool(data.downloadPdf, DEFAULT_SETTINGS.downloadPdf),
    maxDownloadMB: clampInt(data.maxDownloadMB, 'maxDownloadMB'),
    maxMegapixels: clampInt(data.maxMegapixels, 'maxMegapixels'),
    allowPrivateHosts: bool(data.allowPrivateHosts, DEFAULT_SETTINGS.allowPrivateHosts),
    writeLogNote: bool(data.writeLogNote, DEFAULT_SETTINGS.writeLogNote),
  };
}

function clampInt(value: unknown, key: keyof typeof LIMITS): number {
  const [min, max] = LIMITS[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(number)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
