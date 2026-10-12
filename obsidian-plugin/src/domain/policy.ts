// worthReplacing reports whether candidate is smaller than original by at
// least minPercent. Re-encoding for a marginal gain only loses quality.
export function worthReplacing(original: number, candidate: number, minPercent: number): boolean {
  return candidate < original && (original - candidate) * 100 >= original * minPercent;
}

// blockedHostReason explains why a URL must not be downloaded, or returns
// null. Without allowPrivate, hosts that name this device or a local network
// are refused, so a note from an untrusted source cannot make the app probe
// the network it runs in. The check covers names and IP literals; a public
// name resolving to a private address cannot be detected from a plugin.
export function blockedHostReason(rawUrl: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'invalid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `unsupported protocol ${url.protocol}`;
  if (allowPrivate) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return `private host ${host}`;
  if (host.startsWith('[')) {
    return isPrivateIPv6(host.slice(1, -1)) ? `private address ${host}` : null;
  }
  const v4 = parseIPv4(host);
  if (v4 && isPrivateIPv4(v4)) return `private address ${host}`;
  return null;
}

type IPv4 = [number, number, number, number];

// The URL parser already normalises 2130706433, 0x7f.1 and similar to the
// dotted form, so only dotted quads reach this point.
function parseIPv4(host: string): IPv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number) as IPv4;
  return octets.every((o) => o <= 255) ? octets : null;
}

// Special-purpose IPv4 ranges (IANA), all of which must not be fetched.
const PRIVATE_V4: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 0, 2, 0, 24],
  [192, 168, 0, 0, 16], [198, 18, 0, 0, 15], [198, 51, 100, 0, 24], [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4], [240, 0, 0, 0, 4],
];

function isPrivateIPv4(ip: IPv4): boolean {
  const value = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
  });
}

function isPrivateIPv6(host: string): boolean {
  const words = expandIPv6(host);
  if (!words) return true; // unparsable literal: refuse rather than guess
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4 embedded in mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16).
  const v4 = (hi: number, lo: number): IPv4 => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return isPrivateIPv4(v4(words[6], words[7]));
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return isPrivateIPv4(v4(words[6], words[7]));
  if (words[0] === 0x2002) return isPrivateIPv4(v4(words[1], words[2]));
  return false;
}

function expandIPv6(host: string): number[] | null {
  let text = host;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    text = text.slice(0, -dotted[1].length) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((w) => parseInt(w, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const words = [...head, ...new Array(missing).fill(0), ...tail];
  return words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}
