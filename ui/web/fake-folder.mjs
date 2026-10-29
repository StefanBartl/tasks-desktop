// A folder that behaves like a picked one (File System Access API) for the tests of the web variant, writable, with a
// clock for `lastModified` and hooks to make an operation fail. Not a test itself (the runner takes web/*.test.mjs).
//
//   const disk = fakeDisk({ 'a/b.md': 'text' });
//   disk.root                     the directory handle to give to the reader / the write-back
//   disk.read('a/b.md')           the text on the fake disk, or undefined
//   disk.write('a/b.md', 'x')     change a file as an editor would (new content, newer time)
//   disk.remove('a/b.md')         delete it
//   disk.files()                  { path: text } of every file
//   disk.failOn = (op, path) => …  make an operation throw: op is 'getFile', 'make' (a new file), 'create' (a writable), 'write', 'close', 'remove', 'move'

const enc = new TextEncoder();
const dec = new TextDecoder();

function domError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function fakeDisk(tree = {}, options = {}) {
  const state = { clock: 1_700_000_000_000, failOn: null, log: [] };
  const rootDir = { kind: 'directory', name: options.name ?? 'vault', children: new Map() };

  const tick = () => (state.clock += 1000);

  function check(op, path) {
    state.log.push(`${op} ${path}`);
    if (state.failOn?.(op, path)) throw domError('NoModificationAllowedError', `injected failure: ${op} ${path}`);
  }

  function walkTo(segments, create) {
    let at = rootDir;
    for (const segment of segments) {
      let next = at.children.get(segment);
      if (!next) {
        if (!create) return null;
        next = { kind: 'directory', name: segment, children: new Map() };
        at.children.set(segment, next);
      }
      if (next.kind !== 'directory') return null;
      at = next;
    }
    return at;
  }

  function put(path, bytes) {
    const segments = path.split('/');
    const dir = walkTo(segments.slice(0, -1), true);
    dir.children.set(segments.at(-1), { kind: 'file', name: segments.at(-1), bytes, time: tick() });
  }

  for (const [path, text] of Object.entries(tree)) put(path, typeof text === 'string' ? enc.encode(text) : text);

  function fileHandle(parent, node, path) {
    return {
      kind: 'file',
      name: node.name,
      async getFile() {
        check('getFile', path);
        const current = parent.children.get(node.name);
        if (!current || current.kind !== 'file') throw domError('NotFoundError', `${path} is gone`);
        const bytes = current.bytes;
        return { size: bytes.byteLength, lastModified: current.time, arrayBuffer: async () => bytes.slice().buffer };
      },
      async createWritable() {
        check('create', path);
        const chunks = [];
        let open = true;
        return {
          async write(data) {
            check('write', path);
            if (!open) throw domError('InvalidStateError', 'closed');
            chunks.push(Uint8Array.from(data));
          },
          async close() {
            check('close', path);
            open = false;
            const size = chunks.reduce((n, c) => n + c.byteLength, 0);
            const bytes = new Uint8Array(size);
            let at = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, at);
              at += chunk.byteLength;
            }
            // the swap file replaces the file in one step: the old bytes are there until now
            parent.children.set(node.name, { kind: 'file', name: node.name, bytes, time: tick() });
          },
          async abort() {
            open = false;
          },
        };
      },
      ...(options.noMove
        ? {}
        : {
            async move(destination, name) {
              check('move', path);
              const target = destination.__node;
              const mine = parent.children.get(node.name);
              if (!mine) throw domError('NotFoundError', `${path} is gone`);
              parent.children.delete(node.name);
              target.children.set(name, { ...mine, name });
            },
          }),
    };
  }

  function dirHandle(node, path) {
    return {
      kind: 'directory',
      name: node.name,
      __node: node,
      async *values() {
        for (const child of [...node.children.values()]) {
          const childPath = path ? `${path}/${child.name}` : child.name;
          yield child.kind === 'file' ? fileHandle(node, child, childPath) : dirHandle(child, childPath);
        }
      },
      async getFileHandle(name, opts) {
        const childPath = path ? `${path}/${name}` : name;
        let child = node.children.get(name);
        if (!child) {
          if (!opts?.create) throw domError('NotFoundError', `${childPath} is not there`);
          check('make', childPath);
          child = { kind: 'file', name, bytes: new Uint8Array(0), time: tick() };
          node.children.set(name, child);
        }
        if (child.kind !== 'file') throw domError('TypeMismatchError', `${childPath} is a folder`);
        return fileHandle(node, child, childPath);
      },
      async getDirectoryHandle(name, opts) {
        const childPath = path ? `${path}/${name}` : name;
        let child = node.children.get(name);
        if (!child) {
          if (!opts?.create) throw domError('NotFoundError', `${childPath} is not there`);
          child = { kind: 'directory', name, children: new Map() };
          node.children.set(name, child);
        }
        if (child.kind !== 'directory') throw domError('TypeMismatchError', `${childPath} is a file`);
        return dirHandle(child, childPath);
      },
      async removeEntry(name, opts) {
        const childPath = path ? `${path}/${name}` : name;
        check('remove', childPath);
        const child = node.children.get(name);
        if (!child) throw domError('NotFoundError', `${childPath} is not there`);
        if (child.kind === 'directory' && child.children.size > 0 && !opts?.recursive) {
          throw domError('InvalidModificationError', `${childPath} is not empty`);
        }
        node.children.delete(name);
      },
    };
  }

  return {
    root: dirHandle(rootDir, ''),
    state,
    set failOn(fn) {
      state.failOn = fn;
    },
    /** What the disk holds: path -> text. */
    files() {
      const out = {};
      const walk = (node, prefix) => {
        for (const child of node.children.values()) {
          if (child.kind === 'file') out[prefix + child.name] = dec.decode(child.bytes);
          else walk(child, `${prefix}${child.name}/`);
        }
      };
      walk(rootDir, '');
      return out;
    },
    /** Every folder path, also the empty ones. */
    folders() {
      const out = [];
      const walk = (node, prefix) => {
        for (const child of node.children.values()) {
          if (child.kind === 'directory') {
            out.push(prefix + child.name);
            walk(child, `${prefix}${child.name}/`);
          }
        }
      };
      walk(rootDir, '');
      return out.sort();
    },
    read(path) {
      return this.files()[path];
    },
    /** Someone else writes: the content changes and the time moves on. */
    write(path, text) {
      put(path, typeof text === 'string' ? enc.encode(text) : text);
    },
    /** Someone else touches a file: the time moves on, the content stays. */
    touch(path) {
      const segments = path.split('/');
      const dir = walkTo(segments.slice(0, -1), false);
      dir.children.get(segments.at(-1)).time = tick();
    },
    remove(path) {
      const segments = path.split('/');
      walkTo(segments.slice(0, -1), false).children.delete(segments.at(-1));
    },
    mkdir(path) {
      walkTo(path.split('/'), true);
    },
    /** A full copy of the content, to compare "nothing changed". */
    snapshot() {
      return JSON.stringify(this.files()) + '|' + JSON.stringify(this.folders());
    },
    log: state.log,
  };
}
