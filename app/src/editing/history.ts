import type { BufferGeometry } from "three";

export interface EditCommand<TState> {
  label: string;
  /** Return the next immutable/snapshot state from the current state. */
  apply: (current: TState) => TState;
  /** Release command-owned resources when its history entry is discarded. */
  dispose?: () => void;
}

export interface EditHistoryOptions<TState> {
  /** Maximum number of undoable commands retained. Defaults to 50. */
  maxEntries?: number;
  /** Release snapshots that are no longer reachable from history. */
  disposeSnapshot?: (snapshot: TState) => void;
}

interface HistoryEntry<TState> {
  snapshot: TState;
  command?: EditCommand<TState>;
}

/**
 * Snapshot-based bounded undo/redo. Commands produce a new state; undo and
 * redo simply move the cursor between retained snapshots. This avoids asking
 * geometry operations to mutate or reverse themselves and makes disposal
 * ownership explicit.
 */
export class EditHistory<TState> {
  private readonly maxEntries: number;
  private readonly disposeSnapshot?: (snapshot: TState) => void;
  private entries: HistoryEntry<TState>[];
  private position = 0;
  private cleanPosition: number | null = 0;

  constructor(initial: TState, options: EditHistoryOptions<TState> = {}) {
    const requestedMax = options.maxEntries ?? 50;
    this.maxEntries = Math.max(1, Math.floor(requestedMax));
    this.disposeSnapshot = options.disposeSnapshot;
    this.entries = [{ snapshot: initial }];
  }

  get current(): TState {
    return this.entries[this.position].snapshot;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.entries.length - 1;
  }

  get undoDepth(): number {
    return this.position;
  }

  get redoDepth(): number {
    return this.entries.length - this.position - 1;
  }

  get dirty(): boolean {
    return this.cleanPosition === null || this.cleanPosition !== this.position;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Apply a command and discard any redo branch after the current cursor. */
  execute(command: EditCommand<TState>): TState {
    const next = command.apply(this.current);
    this.discardRedo();
    this.entries.push({ snapshot: next, command });
    this.position += 1;
    this.enforceLimit();
    return next;
  }

  undo(): TState {
    if (this.canUndo) this.position -= 1;
    return this.current;
  }

  redo(): TState {
    if (this.canRedo) this.position += 1;
    return this.current;
  }

  /** Mark the current snapshot as persisted/clean. */
  markClean(): void {
    this.cleanPosition = this.position;
  }

  /** Remove undo/redo entries while retaining the current state. */
  clear(): void {
    const wasClean = this.cleanPosition === this.position;
    for (let index = 0; index < this.entries.length; index += 1) {
      if (index !== this.position) this.releaseEntry(this.entries[index]);
    }
    this.entries = [{ snapshot: this.current }];
    this.position = 0;
    this.cleanPosition = wasClean ? 0 : null;
  }

  /**
   * Dispose history-owned snapshots and command resources. By default the
   * active snapshot remains caller-owned; pass true when the history also
   * owns the active geometry and it is no longer needed.
   */
  dispose(includeCurrent = false): void {
    const current = this.current;
    for (let index = 0; index < this.entries.length; index += 1) {
      if (includeCurrent || index !== this.position) this.releaseEntry(this.entries[index]);
    }
    this.entries = includeCurrent ? [] : [{ snapshot: current }];
    this.position = 0;
    this.cleanPosition = includeCurrent ? null : 0;
  }

  private discardRedo(): void {
    if (!this.canRedo) return;
    if (this.cleanPosition !== null && this.cleanPosition > this.position) this.cleanPosition = null;
    for (let index = this.entries.length - 1; index > this.position; index -= 1) {
      this.releaseEntry(this.entries[index]);
    }
    this.entries.length = this.position + 1;
  }

  private enforceLimit(): void {
    const maxSnapshots = this.maxEntries + 1;
    while (this.entries.length > maxSnapshots) {
      if (this.cleanPosition !== null) {
        if (this.cleanPosition === 0) this.cleanPosition = null;
        else this.cleanPosition -= 1;
      }
      this.releaseEntry(this.entries.shift()!);
      this.position -= 1;
    }
  }

  private releaseEntry(entry: HistoryEntry<TState>): void {
    this.disposeSnapshot?.(entry.snapshot);
    entry.command?.dispose?.();
  }
}

/** Disposal hook suitable for geometry-only snapshots. */
export function disposeGeometrySnapshot(geometry: BufferGeometry): void {
  geometry.dispose();
}
