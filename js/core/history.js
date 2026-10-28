// Undo/redo. Projects are small JSON (media bytes live elsewhere), so whole-project snapshots are cheap
// and far less error-prone than inverse commands.

export class History {
  constructor({ limit = 200 } = {}) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Record the state *before* a change. */
  push(snapshotJson, label = '') {
    this.undoStack.push({ json: snapshotJson, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  /** Returns the JSON to restore, given the current state's JSON (which goes onto the redo stack). */
  undo(currentJson) {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ json: currentJson, label: entry.label });
    return entry;
  }

  redo(currentJson) {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ json: currentJson, label: entry.label });
    return entry;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  nextUndoLabel() {
    return this.undoStack.at(-1)?.label || '';
  }

  nextRedoLabel() {
    return this.redoStack.at(-1)?.label || '';
  }
}
