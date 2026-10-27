// The app owns request ordering; the native generation mutex also protects
// requests submitted by other clients. Cancellation before dispatch is cheap.
interface Pending { start(): Promise<void> }
const pending: Pending[] = [];
let active = false;
function pump(): void {
  if (active) return;
  const next = pending.shift(); if (!next) return;
  active = true;
  void next.start().finally(() => { active = false; pump(); });
}
export function nativeWork<T>(work: () => Promise<T>, shouldStart: () => boolean = () => true, queuedCancellation?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const aborted = () => new DOMException("Work cancelled before dispatch", "AbortError");
    const cleanup = () => queuedCancellation?.removeEventListener("abort", cancel);
    const entry: Pending = { start() {
      started = true; cleanup();
      return Promise.resolve().then(() => {
        if (!shouldStart()) throw aborted();
        return work();
      }).then(resolve, reject);
    } };
    const cancel = () => {
      if (started) return;
      const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1);
      cleanup(); reject(aborted());
    };
    pending.push(entry);
    queuedCancellation?.addEventListener("abort", cancel, { once: true });
    if (queuedCancellation?.aborted) cancel();
    queueMicrotask(pump);
  });
}
