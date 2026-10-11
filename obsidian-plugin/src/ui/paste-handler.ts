import type { Editor, MarkdownFileInfo, MarkdownView } from 'obsidian';
import { findRemoteImages } from '../domain/links.ts';

export interface PasteActions {
  enabled(): boolean;
  /** Saves pasted image files and returns the embed for each, in order. */
  saveImages(files: File[], notePath: string, placeholder: Placeholder): void;
  /** Downloads web images that pasted text added to the note. */
  saveRemote(notePath: string, urls: Set<string>): void;
}

// Placeholder marks where a pasted image goes until it is saved, so the link
// lands at the paste position even if the user keeps typing meanwhile.
export interface Placeholder {
  text: string;
  editor: Editor;
}

let counter = 0;

// imageFiles returns the files of a clipboard or drop if all of them are
// images; mixed content is left to Obsidian.
function imageFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  return files.length > 0 && files.every((file) => file.type.startsWith('image/')) ? files : [];
}

export function handlePaste(evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo, actions: PasteActions): void {
  if (evt.defaultPrevented || !actions.enabled() || !info.file) return;
  const notePath = info.file.path;
  const files = imageFiles(evt.clipboardData);
  if (files.length > 0) {
    evt.preventDefault();
    actions.saveImages(files, notePath, insertPlaceholder(editor, editor.getCursor()));
    return;
  }
  // Text is pasted by Obsidian as usual; web images in it are fetched once
  // the paste has landed in the note.
  const urls = new Set<string>();
  for (const format of ['text/plain', 'text/html']) {
    for (const image of findRemoteImages(evt.clipboardData?.getData(format) ?? '')) urls.add(image.url);
  }
  if (urls.size > 0) actions.saveRemote(notePath, urls);
}

export function handleDrop(evt: DragEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo, actions: PasteActions): void {
  if (evt.defaultPrevented || !actions.enabled() || !info.file) return;
  const files = imageFiles(evt.dataTransfer);
  if (files.length === 0) return;
  evt.preventDefault();
  actions.saveImages(files, info.file.path, insertPlaceholder(editor, dropPosition(editor, evt)));
}

function insertPlaceholder(editor: Editor, at: ReturnType<Editor['getCursor']>): Placeholder {
  const text = `![[Optimizing image ${Date.now().toString(36)}-${++counter}…]]`;
  editor.replaceRange(text, at);
  editor.setCursor(editor.offsetToPos(editor.posToOffset(at) + text.length));
  return { text, editor };
}

// dropPosition maps the drop point to a document position through the
// CodeMirror view behind Obsidian's editor; the cursor is the fallback.
function dropPosition(editor: Editor, evt: DragEvent): ReturnType<Editor['getCursor']> {
  const view = (editor as unknown as { cm?: { posAtCoords(c: { x: number; y: number }): number | null } }).cm;
  const offset = view?.posAtCoords({ x: evt.clientX, y: evt.clientY });
  return offset === null || offset === undefined ? editor.getCursor() : editor.offsetToPos(offset);
}

// replacePlaceholder puts the final text where the placeholder is: in the
// editor if it still shows it, else in the note on disk. Returns false when
// the placeholder was deleted by the user.
export async function replacePlaceholder(
  placeholder: Placeholder,
  replacement: string,
  processFile: (fn: (text: string) => string) => Promise<unknown>,
): Promise<boolean> {
  const { editor, text } = placeholder;
  const offset = editor.getValue().indexOf(text);
  if (offset !== -1) {
    editor.replaceRange(replacement, editor.offsetToPos(offset), editor.offsetToPos(offset + text.length));
    return true;
  }
  let found = false;
  await processFile((content) => {
    found = content.includes(text);
    return found ? content.replace(text, replacement) : content;
  });
  return found;
}
