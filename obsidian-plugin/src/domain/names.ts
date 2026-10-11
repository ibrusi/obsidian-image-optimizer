const MAX_NAME_LENGTH = 60;

// Characters Obsidian refuses in file names or that break links.
const FORBIDDEN = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;

// baseNameFromUrl derives a readable file name stem from an image URL.
// Non-Latin names are kept: "фото.jpg" stays "фото", not a hash.
export function baseNameFromUrl(url: string): string {
  let segment = '';
  try {
    const path = new URL(url).pathname;
    segment = path.slice(path.lastIndexOf('/') + 1);
    segment = decodeURIComponent(segment);
  } catch {
    // Malformed URL or escape sequence: fall back to the raw segment.
  }
  const dot = segment.lastIndexOf('.');
  const stem = (dot > 0 ? segment.slice(0, dot) : segment)
    .replace(FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const limited = Array.from(stem).slice(0, MAX_NAME_LENGTH).join('').trim();
  return limited || 'image';
}
