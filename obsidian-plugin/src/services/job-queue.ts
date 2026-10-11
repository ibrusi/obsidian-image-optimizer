// JobQueue runs jobs one at a time, in order: commands, pasted images and
// vault runs share it, so a phone never holds two images in memory at once.
export class JobQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private running = 0;

  get busy(): boolean {
    return this.running > 0;
  }

  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.running++;
    const start = () => {
      controller.signal.throwIfAborted();
      return job(controller.signal);
    };
    const result = this.tail.then(start, start).finally(() => {
      this.controllers.delete(controller);
      this.running--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  // cancelAll aborts the running job and every queued one.
  cancelAll(): void {
    for (const controller of this.controllers) controller.abort();
  }
}
