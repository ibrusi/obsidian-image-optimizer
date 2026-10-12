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

const MAX_NAME_ATTEMPTS = 10_000;

// availableName returns stem.ext, or stem-1.ext, stem-2.ext… — the first name
// not taken in the folder. Names are compared case-insensitively: on macOS,
// Windows and Android storage "Pic.webp" and "pic.webp" are the same file.
export function availableName(taken: ReadonlySet<string>, stem: string, ext: string): string {
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const name = i === 0 ? `${stem}.${ext}` : `${stem}-${i}.${ext}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  throw new Error(`no free file name for ${stem}.${ext}`);
}

// Names browsers and apps give to clipboard images instead of a real one.
const GENERIC_NAMES = new Set(['image', 'blob', 'clipboard', 'screenshot', 'unknown', 'untitled']);

// pastedImageStem names a pasted or dropped file: its own name when it has
// a meaningful one, otherwise "Pasted image 20261011153000" like Obsidian.
export function pastedImageStem(fileName: string, now: Date): string {
  const dot = fileName.lastIndexOf('.');
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(FORBIDDEN, '_').trim();
  if (stem && !GENERIC_NAMES.has(stem.toLowerCase())) return Array.from(stem).slice(0, MAX_NAME_LENGTH).join('');
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}`;
}
