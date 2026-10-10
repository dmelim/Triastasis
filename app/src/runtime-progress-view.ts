import { onRuntimeProgress, type RuntimeProgress } from "./runtime-manager";
import { runtimeProgressFraction, runtimeProgressLabel } from "./runtime-presentation";

function createProgressView(container: HTMLElement): ((progress: RuntimeProgress) => void) & { remove(): void } {
  const view = document.createElement("div");
  view.className = "runtime-progress";
  view.innerHTML = '<div class="bar" role="progressbar" aria-label="Runtime download progress"><span class="bar-fill indeterminate"></span></div><p aria-live="polite">Contacting the release server...</p>';
  container.append(view);
  const bar = view.querySelector<HTMLElement>(".bar")!;
  const fill = view.querySelector<HTMLElement>(".bar-fill")!;
  const label = view.querySelector<HTMLElement>("p")!;
  const render = (progress: RuntimeProgress) => {
    const fraction = runtimeProgressFraction(progress);
    fill.classList.toggle("indeterminate", fraction === null);
    fill.style.width = fraction === null ? "" : `${Math.max(2, fraction * 100)}%`;
    if (fraction === null) bar.removeAttribute("aria-valuenow");
    else bar.setAttribute("aria-valuenow", String(Math.floor(fraction * 100)));
    label.textContent = runtimeProgressLabel(progress);
  };
  return Object.assign(render, { remove: () => view.remove() });
}

/**
 * Show live runtime download progress in `container` while `task` runs. The
 * task starts immediately; the view is removed when it settles.
 */
export async function withRuntimeProgress<T>(container: HTMLElement, task: () => Promise<T>): Promise<T> {
  const pending = task();
  let view: ReturnType<typeof createProgressView> | null = null;
  try {
    view = createProgressView(container);
  } catch {
    // No renderable DOM (for example in unit tests): run without a progress view.
  }
  let settled = false;
  let unlisten = () => {};
  if (view) {
    const render = view;
    onRuntimeProgress(render)
      .then((stop) => { if (settled) stop(); else unlisten = stop; })
      .catch(() => {});
  }
  try {
    return await pending;
  } finally {
    settled = true;
    unlisten();
    view?.remove();
  }
}
