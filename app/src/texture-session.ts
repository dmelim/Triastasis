/** The chooser owns pending work; stopping never pretends native GPU work was
 * interrupted. An active result is discarded before cache disposal or bake. */
export interface CachedTexture { key: string; seed: number; values: Float32Array; missingSamples: number }
export class TextureSession {
  options: CachedTexture[] = [];
  selected = -1;
  phase: "ready" | "generating" | "stopping" | "baking" | "baked" | "closed" = "ready";
  error = "";
  baked: Blob | null = null;
  attempt = 0;
  private bakePending = false;
  private stopped = false;
  private closed = false;
  private generation: Promise<void> = Promise.resolve();
  private operation: Promise<unknown> = Promise.resolve();
  private readonly queuedOptions = new AbortController();
  private readonly queuedBake = new AbortController();
  constructor(private readonly dependencies: {
    option(seed: number, shouldStart: () => boolean, queuedCancellation: AbortSignal): Promise<CachedTexture>;
    bake(option: CachedTexture, shouldStart: () => boolean, queuedCancellation: AbortSignal): Promise<Blob>;
    discard(option: CachedTexture): Promise<void>;
    changed(): void;
  }) {}
  get busy(): boolean { return this.bakePending || this.phase === "generating" || this.phase === "stopping" || this.phase === "baking"; }
  get canSelect(): boolean { return !this.bakePending && this.phase !== "baked" && !this.closed; }
  start(seeds: number[]): Promise<void> {
    if (this.busy || this.closed || this.options.length) throw new Error("Texture session has already started");
    this.phase = "generating"; this.dependencies.changed();
    this.generation = (async () => {
      for (const [index, seed] of seeds.slice(0, 3).entries()) {
        if (this.stopped || this.closed) break;
        this.attempt = index + 1;
        try {
          const option = await this.dependencies.option(seed, () => !this.stopped && !this.closed, this.queuedOptions.signal);
          if (this.stopped || this.closed) await this.dependencies.discard(option);
          else { this.options.push(option); if (this.selected < 0) this.selected = 0; }
        } catch (error) {
          if (!this.stopped && !this.closed) this.error = error instanceof Error ? error.message : "Texture option failed";
        }
        this.dependencies.changed();
      }
      if (!this.closed) this.phase = "ready";
      this.dependencies.changed();
    })();
    this.operation = this.generation;
    return this.generation;
  }
  select(index: number): void {
    if (!this.canSelect || !this.options[index]) return;
    this.selected = index; this.dependencies.changed();
  }
  stop(): void {
    this.stopped = true;
    this.queuedOptions.abort();
    if (this.phase === "generating") this.phase = "stopping";
    this.dependencies.changed();
  }
  bakeSelected(): Promise<void> {
    if (!this.options[this.selected] || this.bakePending || this.phase === "baked" || this.closed) return Promise.resolve();
    this.bakePending = true;
    const option = this.options[this.selected]; this.stop();
    const bake = (async () => {
      await this.generation;
      if (this.closed) return;
      this.phase = "baking"; this.error = ""; this.dependencies.changed();
      try {
        const glb = await this.dependencies.bake(option, () => !this.closed, this.queuedBake.signal);
        if (!this.closed) { this.baked = glb; this.phase = "baked"; }
      } catch (error) {
        if (!this.closed) { this.error = error instanceof Error ? error.message : "Bake failed"; this.phase = "ready"; }
      }
      this.bakePending = false;
      this.dependencies.changed();
    })();
    this.operation = bake.finally(() => { this.bakePending = false; });
    return bake;
  }
  back(): void { if (this.phase === "baked") { this.baked = null; this.phase = "ready"; this.dependencies.changed(); } }
  async close(): Promise<void> {
    this.closed = true; this.queuedBake.abort(); this.stop(); await this.operation;
    this.phase = "closed"; this.options = []; this.baked = null; this.dependencies.changed();
  }
}
