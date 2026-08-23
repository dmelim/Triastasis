// Pure busy-state management for the manifest modal. Element-shaped stubs
// (plain objects) satisfy these functions, so node:test can verify snapshot
// capture/restore without a DOM.

export interface BusyControlLike {
  innerHTML: string;
  disabled: boolean;
  style: { minWidth: string };
}

export interface BusyControlState {
  html: string;
  disabled: boolean;
  minWidth: string;
}

/** Captures the exact state of every control before entering busy mode. */
export function captureControls(elements: BusyControlLike[]): BusyControlState[] {
  return elements.map((element) => ({
    html: element.innerHTML,
    disabled: element.disabled,
    minWidth: element.style.minWidth,
  }));
}

/**
 * Restores each control to its captured state — including originally
 * disabled buttons — rather than blanket-enabling everything.
 */
export function restoreControls(
  elements: BusyControlLike[],
  states: BusyControlState[],
): void {
  elements.forEach((element, index) => {
    const state = states[index];
    if (!state) return;
    element.innerHTML = state.html;
    element.disabled = state.disabled;
    element.style.minWidth = state.minWidth;
  });
}

/**
 * Builds the busy appearance for an action button: the caller assigns
 * `html`/`minWidth` back onto the element. Width is pinned from the button's
 * current measured width so swapping content causes no layout movement.
 * The label text is filled into `.spinner-label` by the caller.
 */
export function busyContentFor(rectWidth: number): { html: string; minWidth: string } {
  return {
    html:
      '<span class="spinner" aria-hidden="true"></span><span class="spinner-label"></span>',
    minWidth: `${Math.ceil(rectWidth)}px`,
  };
}

/** User close attempts are meaningless while an operation is in flight. */
export function canCloseModal(busy: boolean): boolean {
  return !busy;
}

/** Classifies an import failure by whether the record already persisted. */
export function classifyImportFailure(persisted: boolean): "retryable" | "post-persistence" {
  return persisted ? "post-persistence" : "retryable";
}

export type ManifestWriteFailureContext =
  | "asset-persisted"
  | "generation-failed"
  | "generation-cancelled";

/** Builds an outcome-accurate warning for a failed terminal manifest write. */
export function manifestWriteFailureMessage(
  context: ManifestWriteFailureContext,
  detail: string,
): string {
  switch (context) {
    case "asset-persisted":
      return `The model was saved to Assets, but its portable record could not be finalized: ${detail}. It may not be recoverable after restart.`;
    case "generation-cancelled":
      return `Generation was cancelled, but the cancellation could not be recorded in its portable record: ${detail}. The interrupted recovery entry may remain.`;
    case "generation-failed":
      return `Generation failed, and the failure could not be recorded in its portable record: ${detail}. The interrupted recovery entry may remain.`;
  }
}
