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

// validateFolder returns an error message, or null for a valid setting.
// Hidden segments are rejected: Obsidian does not index hidden folders, so
// images saved there would not render in notes.
export function validateFolder(setting: string): string | null {
  for (const segment of normalizeFolder(setting).split('/').filter(Boolean)) {
    if (segment === '.' || segment === '..') return 'The folder must not contain "." or ".." segments.';
    if (segment.startsWith('.')) return `Hidden folders are not shown by Obsidian: "${segment}".`;
    if (FORBIDDEN.test(segment)) return `The folder name contains a character Obsidian does not allow: "${segment}".`;
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
