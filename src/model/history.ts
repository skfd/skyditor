// Undo / redo of whole strokes (UNDO-001..UNDO-003).
import type { Atom, Piece } from "./world";

export interface Step {
  atoms: { atom: Atom; before: Piece[]; after: Piece[] }[];
}

export class History {
  private done: Step[] = [];
  private undone: Step[] = [];

  push(step: Step) {
    this.done.push(step);
    this.undone = []; // UNDO-003
  }

  /** UNDO-001: returns the reverted step, or null. */
  undo(): Step | null {
    const s = this.done.pop();
    if (!s) return null;
    for (const a of s.atoms) a.atom.pieces = a.before;
    this.undone.push(s);
    return s;
  }

  /** UNDO-002 */
  redo(): Step | null {
    const s = this.undone.pop();
    if (!s) return null;
    for (const a of s.atoms) a.atom.pieces = a.after;
    this.done.push(s);
    return s;
  }

  get canUndo() {
    return this.done.length > 0;
  }
  get canRedo() {
    return this.undone.length > 0;
  }
}
