/** Each retained snapshot owns one reference; unchanged immutable buffers are shared. */
export class SharedResources<T extends { dispose(): void }> {
  private counts = new Map<T, number>();
  retain(value: T): T { this.counts.set(value, (this.counts.get(value) ?? 0) + 1); return value; }
  has(value: T): boolean { return this.counts.has(value); }
  release(value: T): void {
    const count = this.counts.get(value);
    if (count === undefined) return;
    if (count === 1) { this.counts.delete(value); value.dispose(); }
    else this.counts.set(value, count - 1);
  }
}
