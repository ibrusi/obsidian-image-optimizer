// A source tag is the start of the SHA-256 of an image's original bytes (the
// download, the pasted file, the local image before conversion), written
// into the name of the file saved for it: "photo-3fa9c2e1b7d04a85.webp".
//
// The name itself then says which original a file holds, on every device
// and with any sync service: the same image added again is found by its
// tag among the vault's file names, whatever encoding settings produced the
// file. 16 hex digits (64 bits) make two different images in a vault of
// 100 000 share a tag about once in 3.7 billion vaults; a match is verified
// against the file anyway before it is used (see services/library.ts).

export const TAG_LENGTH = 16;

const TAG_AT_END = new RegExp(`-[0-9a-f]{${TAG_LENGTH}}(?:-\\d+)?$`);
const TAGGED_NAME = new RegExp(`-([0-9a-f]{${TAG_LENGTH}})(?:-\\d+)?\\.[^./]+$`);

export function tagOfFingerprint(sha256Hex: string): string {
  return sha256Hex.slice(0, TAG_LENGTH);
}

// withTag appends tag to a name stem, replacing a tag it already carries:
// converting "shot-3fa9c2e1b7d04a85.png" gives "shot-<new tag>.webp", not a
// name with two tags.
export function withTag(stem: string, tag: string): string {
  return `${stem.replace(TAG_AT_END, '')}-${tag}`;
}

// tagOf returns the tag in a file name, or null. "-1" and the like after the
// tag, added when the name was taken, are allowed.
export function tagOf(fileName: string): string | null {
  return TAGGED_NAME.exec(fileName)?.[1] ?? null;
}
