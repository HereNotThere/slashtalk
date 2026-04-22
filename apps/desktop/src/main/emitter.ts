import type { Unsubscribe } from "../shared/types";

export interface Emitter<T> {
  emit: (value: T) => void;
  on: (cb: (value: T) => void) => Unsubscribe;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value) => {
      for (const cb of listeners) cb(value);
    },
    on: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
