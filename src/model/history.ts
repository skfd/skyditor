// Undo / redo of whole strokes (UNDO-001..UNDO-003), on land and on buildings alike (TYPE-011).
import type { Building } from "./buildings";
import type { Atom, BuildingSet, Piece } from "./world";

export interface Step {
  atoms: { atom: Atom; before: Piece[]; after: Piece[] }[];
  buildings?: { set: BuildingSet; before: Building[]; after: Building[] }[];
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
    for (const b of s.buildings ?? []) b.set.items = b.before;
    this.undone.push(s);
    return s;
  }

  /** UNDO-002 */
  redo(): Step | null {
    const s = this.undone.pop();
    if (!s) return null;
    for (const a of s.atoms) a.atom.pieces = a.after;
    for (const b of s.buildings ?? []) b.set.items = b.after;
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
