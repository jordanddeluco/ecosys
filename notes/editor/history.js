// notes editor: undo / redo. Our own stack (never the browser's): entries are {doc, sel} snapshots, which
// are cheap because blocks are immutable. Typing in one block coalesces while gaps stay under 1 s; the
// group ends after whitespace that follows a word, when the selection jumps, and on blur. Everything
// structural (Enter, paste, format, autoformat, check-and-move, external/AI edits) is its own entry.
// Stacks live in a module-level Map keyed by note id, so undo survives switching notes and back.

const LIMIT = 300;
const NOTES_KEPT = 40;
const stacks = new Map();

export class History {
  constructor(limit = LIMIT) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.group = null; // {block, t, closed}
  }

  /** Record that `before` is about to be replaced. kind 'type' coalesces per block. */
  record(before, { kind = 'structure', block = null, ws = false, now = Date.now() } = {}) {
    const g = this.group;
    if (kind === 'type' && g && !g.closed && g.block === block && now - g.t < 1000) {
      g.t = now;
      if (ws) g.closed = true;
      this.redoStack.length = 0;
      return false;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.group = kind === 'type' ? { block, t: now, closed: ws } : null;
    return true;
  }

  /** Fold a follow-up change (e.g. the auto-sort move after a check) into the latest entry. */
  amendable(token) {
    return this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === token;
  }
  top() {
    return this.undoStack[this.undoStack.length - 1] || null;
  }

  endGroup() {
    this.group = null;
  }

  undo(current) {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(current);
    this.group = null;
    return prev;
  }

  redo(current) {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current);
    this.group = null;
    return next;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.group = null;
  }
}

/** The history for a note id (created on first use); without an id, a private one. */
export function historyFor(noteId) {
  if (!noteId) return new History();
  let h = stacks.get(noteId);
  if (h) {
    stacks.delete(noteId); // refresh LRU position
    stacks.set(noteId, h);
    return h;
  }
  h = new History();
  stacks.set(noteId, h);
  while (stacks.size > NOTES_KEPT) stacks.delete(stacks.keys().next().value);
  return h;
}

export function forgetHistory(noteId) {
  stacks.delete(noteId);
}
