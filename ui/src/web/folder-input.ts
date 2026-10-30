// A folder chosen through `<input type="file" webkitdirectory>`: the way in for browsers without `showDirectoryPicker`
// (Firefox, Safari). The browser hands over a flat list of files, each with its path below the chosen folder
// (`webkitRelativePath`); there is no handle, so the folder cannot be written to, kept for the next visit or looked at
// again. This module turns the list into a read-only folder the reader (`vault-files.ts`) walks like any other.
//
// Everything that is the browser's comes in by argument (the document), so Node runs this without one.

import type { DirHandleLike, FileHandleLike } from './vault-files.ts';
import { oneLine } from './folder.ts';

/** The part of a `File` this module uses. */
export interface PickedFile {
  name: string;
  size: number;
  lastModified?: number;
  /** `<chosen folder>/<path below it>`, `/` separated. Empty when the browser does not tell. */
  webkitRelativePath: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A folder made of the files the browser listed: read only, its tree built from the relative paths. */
export interface PickedFolder extends DirHandleLike {
  /** How many files the browser listed (also those the reader will not take). */
  count: number;
}

class Dir implements DirHandleLike {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly dirs = new Map<string, Dir>();
  readonly files = new Map<string, FileHandleLike>();

  constructor(name: string) {
    this.name = name;
  }

  async *values(): AsyncIterable<FileHandleLike | DirHandleLike> {
    for (const dir of this.dirs.values()) yield dir;
    for (const file of this.files.values()) yield file;
  }
}

function fileHandle(file: PickedFile, name: string): FileHandleLike {
  return {
    kind: 'file',
    name,
    getFile: async () => ({ size: file.size, lastModified: file.lastModified, arrayBuffer: () => file.arrayBuffer() }),
  };
}

/**
 * The browser handed over files without their place in the folder (`webkitRelativePath` empty): Safari on an iPhone or
 * iPad takes the input but gives single files, not a folder. The page tells the person so, in their language.
 */
export class NoPathsError extends Error {
  constructor() {
    super('the browser did not tell where in the folder a file lies');
    this.name = 'NoPathsError';
  }
}

/**
 * The folder the files lie in. The first segment of each path is the name of the chosen folder; a list whose files do
 * not share one (it cannot happen with one chosen folder) is refused rather than guessed at.
 */
export function folderOfFiles(files: ArrayLike<PickedFile>): PickedFolder {
  let root: Dir | null = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as PickedFile;
    const segments = file.webkitRelativePath.split('/');
    // A file without a folder in its path: the browser did not give a folder.
    if (segments.length < 2) throw new NoPathsError();
    const top = segments[0] as string;
    root ??= new Dir(top);
    if (top !== root.name) throw new Error('the files do not come from one folder');
    let dir = root;
    for (const part of segments.slice(1, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = new Dir(part);
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    const name = segments[segments.length - 1] as string;
    dir.files.set(name, fileHandle(file, name));
  }
  // An empty folder lists no file at all: the name is lost with it.
  const out = root ?? new Dir('');
  return Object.assign(out, { count: files.length });
}

/** What the page needs of `document` to ask for a folder through an input. */
export interface InputDocument {
  createElement(tag: 'input'): InputLike;
  body?: { appendChild(node: unknown): unknown } | null;
}

export interface InputLike {
  type: string;
  webkitdirectory?: boolean;
  multiple?: boolean;
  hidden?: boolean;
  files: ArrayLike<PickedFile> | null;
  click(): void;
  remove?(): void;
  addEventListener(type: 'change' | 'cancel', listener: () => void, options?: { once?: boolean }): void;
}

/** Whether this browser can hand over a folder through an input (Firefox 50+, Safari 11.1+, Chrome and Edge as well). */
export function inputFolderSupport(doc: Pick<InputDocument, 'createElement'> | undefined): boolean {
  if (!doc || typeof doc.createElement !== 'function') return false;
  try {
    return 'webkitdirectory' in doc.createElement('input');
  } catch {
    return false;
  }
}

export type InputPick =
  | { kind: 'picked'; folder: PickedFolder }
  | { kind: 'cancelled' }
  /** The dialog was closed with a choice, but the browser listed no file (an empty folder). */
  | { kind: 'empty' }
  /** The browser gave files without their paths (Safari on iOS): no folder can be made of them. */
  | { kind: 'no_paths' }
  | { kind: 'failed'; message: string };

/**
 * Ask for a folder through an input. Must run inside a click: the browser opens the dialog only for one. Resolves when
 * the person chose (`change`) or closed the dialog (`cancel`; a browser that does not send it leaves the page where it
 * is, on the way in, to choose again).
 */
export function pickFolderByInput(doc: InputDocument): Promise<InputPick> {
  return new Promise((resolve) => {
    let input: InputLike;
    try {
      input = doc.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.multiple = true;
      input.hidden = true;
      doc.body?.appendChild(input);
    } catch (error) {
      resolve({ kind: 'failed', message: oneLine(error) });
      return;
    }
    const done = (result: InputPick) => {
      input.remove?.();
      resolve(result);
    };
    input.addEventListener('cancel', () => done({ kind: 'cancelled' }), { once: true });
    input.addEventListener(
      'change',
      () => {
        const files = input.files;
        if (!files || files.length === 0) return done({ kind: 'empty' });
        try {
          done({ kind: 'picked', folder: folderOfFiles(files) });
        } catch (error) {
          done(error instanceof NoPathsError ? { kind: 'no_paths' } : { kind: 'failed', message: oneLine(error) });
        }
      },
      { once: true },
    );
    try {
      input.click();
    } catch (error) {
      done({ kind: 'failed', message: oneLine(error) });
    }
  });
}
