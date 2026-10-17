// Promise latches for deterministic race tests: park one transaction at a
// real boundary (after its lock, before its commit) while another runs.

export interface Latch<T = void> {
  readonly promise: Promise<T>;
  readonly isOpen: boolean;
  open(value: T): void;
}

/** A one-shot gate: `await latch.promise` blocks until `open()` is called. */
export function latch<T = void>(): Latch<T> {
  let release!: (value: T) => void;
  let isOpen = false;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    get isOpen() {
      return isOpen;
    },
    open(value: T) {
      if (isOpen) return;
      isOpen = true;
      release(value);
    },
  };
}

export interface Barrier {
  readonly arrived: number;
  /** Resolves once `parties` callers have arrived. */
  arrive(): Promise<void>;
}

/** A barrier for `parties` participants; arriving after it tripped resolves at once. */
export function barrier(parties: number): Barrier {
  if (!Number.isInteger(parties) || parties < 1)
    throw new RangeError('A barrier needs at least one party.');
  const gate = latch();
  let arrived = 0;
  return {
    get arrived() {
      return arrived;
    },
    arrive() {
      arrived += 1;
      if (arrived >= parties) gate.open();
      return gate.promise;
    },
  };
}

/** Rejects with `label` if `promise` does not settle within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
