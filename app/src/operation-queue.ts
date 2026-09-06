/** Serialize model mutations, saves and replacement; rejection never stalls later work. */
export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly changed: () => void = () => { }) { }
  get busy(): boolean { return this.pending > 0; }
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.pending++;
    this.changed();
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result.finally(() => { this.pending--; this.changed(); });
  }
}
