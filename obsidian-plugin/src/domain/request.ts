// How an image is requested from the web, so that sites serve it to the
// plugin as they serve it to a browser showing the page.
//
// Sites commonly answer differently to a bare request:
// - hotlink protection refuses images (403) unless Referer names a page of
//   the site;
// - WebP plugins (WebP Express and the like) rewrite <img src="x.jpg"> to
//   x.webp for browsers that send "Accept: image/webp", and that URL may not
//   exist for anyone else or may be gone later (404) while x.jpg is still
//   there.

/** The Accept header of an <img> request in Chromium and Safari. */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/** Extensions tried, in order, in place of a .webp that the site does not serve. */
const ORIGINAL_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif'];

// pageUrlOf returns the web page a note was saved from: the "source" (Obsidian
// Web Clipper), "url" or "link" property of its front matter.
export function pageUrlOf(note: string): string | null {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note);
  if (!frontMatter) return null;
  const property = /^(?:source|url|link):[ \t]*["']?(https?:\/\/[^\s"']+)/im.exec(frontMatter[1]);
  return property ? property[1] : null;
}

// refererFor names the page the image is shown on: the note's source page
// when it is on the same site, otherwise the image's own site.
export function refererFor(imageUrl: string, pageUrl: string | null): string | undefined {
  let image: URL;
  try {
    image = new URL(imageUrl);
  } catch {
    return undefined;
  }
  if (pageUrl && sameSite(image.hostname, pageUrl)) return pageUrl;
  return `${image.origin}/`;
}

// originalUrlsFor lists the URLs where the original of a missing .webp may
// be: "x.webp" → x.jpg, x.jpeg, x.png, x.gif; "x.jpg.webp" → x.jpg. Query and
// fragment are kept. Other URLs have no alternatives.
export function originalUrlsFor(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const match = /^(.*?)(?:\.([a-z0-9]+))?\.webp$/i.exec(parsed.pathname);
  if (!match) return [];
  const [, stem, inner] = match;
  const withPath = (pathname: string) => {
    const candidate = new URL(parsed.href);
    candidate.pathname = pathname;
    return candidate.href;
  };
  if (inner && ORIGINAL_EXTENSIONS.includes(inner.toLowerCase())) return [withPath(`${stem}.${inner}`)];
  const base = inner ? `${stem}.${inner}` : stem;
  return ORIGINAL_EXTENSIONS.map((ext) => withPath(`${base}.${ext}`));
}

// sameSite compares registrable domains loosely: static.xakep.ru and
// xakep.ru are one site. The last two labels are enough here; a wrong guess
// only costs a less specific Referer.
function sameSite(host: string, pageUrl: string): boolean {
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl).hostname;
  } catch {
    return false;
  }
  const site = (h: string) => h.toLowerCase().split('.').slice(-2).join('.');
  return site(host) === site(pageHost);
}
