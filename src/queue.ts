import { ApiError } from "./errors.js";

export class Queue {
  private active = false;
  private waiting: {
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.active) {
      this.active = true;
      return () => this.release();
    }
    if (this.waiting.length >= 32)
      throw new ApiError(429, "Provider queue is full.", "queue_full");
    return new Promise((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiting = this.waiting.filter((other) => other !== item);
          reject(signal.reason);
        },
      };
      this.waiting.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }
  private release() {
    const next = this.waiting.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve(() => this.release());
    } else this.active = false;
  }
}
