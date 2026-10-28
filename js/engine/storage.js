// On-disk storage in the browser's private file system (OPFS).
// Media files are streamed to disk, never held in memory; the project autosaves as JSON.

const ROOT = 'cutline';

let rootPromise = null;

function supported() {
  return !!(navigator.storage && navigator.storage.getDirectory);
}

async function root() {
  if (!supported()) throw new Error('This browser has no private file storage.');
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory().then((d) => d.getDirectoryHandle(ROOT, { create: true }));
  }
  return rootPromise;
}

async function mediaDir() {
  return (await root()).getDirectoryHandle('media', { create: true });
}

export const storage = {
  supported,

  async saveMedia(id, blob) {
    const dir = await mediaDir();
    const handle = await dir.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    try {
      await blob.stream().pipeTo(writable);
    } catch (e) {
      try {
        await writable.abort();
      } catch {
        /* already closed */
      }
      throw e;
    }
  },

  /** Returns a File (backed by disk) or null when missing. */
  async loadMedia(id) {
    try {
      const dir = await mediaDir();
      const handle = await dir.getFileHandle(id);
      return await handle.getFile();
    } catch {
      return null;
    }
  },

  async hasMedia(id) {
    return !!(await this.loadMedia(id));
  },

  async deleteMedia(id) {
    try {
      const dir = await mediaDir();
      await dir.removeEntry(id);
    } catch {
      /* not there */
    }
  },

  async listMedia() {
    const out = [];
    try {
      const dir = await mediaDir();
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') out.push(name);
      }
    } catch {
      /* none */
    }
    return out;
  },

  async saveProject(project) {
    const r = await root();
    const handle = await r.getFileHandle('project.json', { create: true });
    const w = await handle.createWritable();
    await w.write(JSON.stringify(project));
    await w.close();
  },

  async loadProject() {
    try {
      const r = await root();
      const handle = await r.getFileHandle('project.json');
      const file = await handle.getFile();
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  },

  async persist() {
    try {
      if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
      return (await navigator.storage?.persist?.()) || false;
    } catch {
      return false;
    }
  },

  async isPersisted() {
    try {
      return (await navigator.storage?.persisted?.()) || false;
    } catch {
      return false;
    }
  },

  async usage() {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch {
      return { usage: 0, quota: 0 };
    }
  },
};
