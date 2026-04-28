/**
 * Counting semaphore. `acquire()` resolves when a slot is free and returns a
 * `release` function — call it exactly once in a `finally` so a thrown error
 * doesn't leak the slot. Waiters are served FIFO.
 */
export function makeSemaphore(max: number): () => Promise<() => void> {
  if (max < 1) throw new Error(`semaphore max must be >= 1, got ${max}`);
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function acquire(): Promise<() => void> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const next = waiters.shift();
      if (next) next();
    };
  };
}
