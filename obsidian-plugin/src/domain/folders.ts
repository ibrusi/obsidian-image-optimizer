import type { FolderError } from '../i18n.ts';

// Folder settings are vault paths written by the user:
//   "Attachments"        -> a folder next to the note ("notes/Attachments")
//   "/Attachments/webp"  -> a folder from the vault root
//   ""                   -> the note's own folder
//   "/"                  -> the vault root

// Characters Obsidian refuses in file and folder names or that break links.
const FORBIDDEN = /[\\:*?"<>|#^[\]]/;

// normalizeFolder trims the setting, unifies separators and drops repeated
// and trailing slashes, keeping a leading "/" that anchors it to the root.
export function normalizeFolder(setting: string): string {
  const trimmed = setting.trim().replace(/\\/g, '/');
  const rooted = trimmed.startsWith('/');
  const body = trimmed.split('/').map((s) => s.trim()).filter(Boolean).join('/');
  return rooted ? `/${body}` : body;
}

// validateFolder returns what is wrong with a setting, or null if it is valid.
// Hidden segments are rejected: Obsidian does not index hidden folders, so
// images saved there would not render in notes.
export function validateFolder(setting: string): FolderError | null {
  for (const segment of normalizeFolder(setting).split('/').filter(Boolean)) {
    if (segment === '.' || segment === '..') return { kind: 'dots' };
    if (segment.startsWith('.')) return { kind: 'hidden', segment };
    if (FORBIDDEN.test(segment)) return { kind: 'forbidden', segment };
  }
  return null;
}

// resolveFolder returns the vault path ("" for the root) where images of a
// note in noteDir are saved. noteDir is TFile.parent.path ("/" for the root).
export function resolveFolder(setting: string, noteDir: string): string {
  const folder = normalizeFolder(setting);
  if (folder.startsWith('/')) return folder.slice(1);
  const base = noteDir === '/' ? '' : noteDir.replace(/\/+$/, '');
  if (!folder) return base;
  return base ? `${base}/${folder}` : folder;
}

// joinPath joins a folder ("" for the root) and a file name.
export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

// isInFolder tells whether a vault path lies in folder or any folder below
// it. folder is TFolder.path: "/" (or "") for the root, which holds everything.
export function isInFolder(path: string, folder: string): boolean {
  const base = folder.replace(/^\/+|\/+$/g, '');
  return base === '' || path.startsWith(`${base}/`);
}
