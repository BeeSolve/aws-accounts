/**
 * Asserts that a code path is unreachable at compile time via the `never` type.
 * Throws at runtime if somehow reached, including the offending value in the message.
 *
 * @example Exhaustive if/return guard
 * ```ts
 *    if (action.kind === 'create') return handleCreate(action);
 *    if (action.kind === 'delete') return handleDelete(action);
 *    assertUnreachable(action.kind);
 * ```
 */
export function assertUnreachable(value: never, message: string = JSON.stringify(value)): never {
  throw Error("An unreachable state reached!\n" + message);
}

/**
 * Picks only `string` properties in a given T type.
 *
 * @example: Sample usage
 * ```ts
 *    type Result = PickStringProps<{ a: string, b: number }>
 *
 *    Result === { a: string }
 * ```
 */
export type PickStringProps<T> = Pick<
  T,
  { [P in keyof T]: T[P] extends string ? P : never }[keyof T]
>;

/**
 * Create new record from an array based on either a selected `string` property or a key selector function.
 *
 * @example Sample usage
 * ```ts
 *    const result = toRecordByProperty(
 *        [
 *            { id: '123', name: 'Jozko' },
 *            { id: '234', name: 'Ferko' }
 *        ],
 *        'id'
 *    );
 *
 *    result === {
 *        '123': { id: '123', name: 'Jozko' },
 *        '234': { id: '234', name: 'Ferko' }
 *    }
 * ```
 *
 * @example Use key selector function
 * ```ts
 *    const result = toRecordByProperty(
 *        [
 *            { groupId: 'g-123', userId: 'u-123', role: 'admin' },
 *            { groupId: 'g-123', userId: 'u-234', role: 'reader' }
 *        ],
 *        value => `${value.groupId}|${value.userId}`
 *    );
 *
 *    result === {
 *        'g-123|u-123': { groupId: 'g-123', userId: 'u-123', role: 'admin' },
 *        'g-123|u-234': { groupId: 'g-123', userId: 'u-234', role: 'reader' }
 *    }
 * ```
 *
 * @example Use string transformations on key
 * ```ts
 *    const result = toRecordByProperty(
 *        [
 *            { id: '123', name: 'Jozko Maly' },
 *            { id: '234', name: 'Ferko Velky' }
 *        ],
 *        'name',
 *        key => key.replaceAll(' ', '_').toLowerCase()
 *    );
 *
 *    result === {
 *        'jozko_maly': { id: '123', name: 'Jozko Maly' },
 *        'ferko_velky': { id: '234', name: 'Ferko Velky' }
 *    }
 * ```
 *
 * When needed the object can be converted back to an array by calling Object.values(object).
 */
export function toRecordByProperty<T extends { [key: string]: any }>(
  input: Array<T>,
  key: keyof PickStringProps<T> | ((value: T) => string),
  keyTransformer: (key: string) => string = (key) => key,
): Record<string, T> {
  return Object.fromEntries(
    input.map((item) => [keyTransformer(typeof key === "function" ? key(item) : item[key]), item]),
  );
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * @example Pause between retry attempts
 * ```ts
 *    await delay(2000);
 * ```
 */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Starts a repeating timer that calls `onTick` with the total elapsed seconds on each interval.
 * Returns a stop function — call it to cancel the timer once the operation completes.
 *
 * @example Show progress during a long-running async call
 * ```ts
 *    const stop = startProgressTimer((elapsed) => {
 *        logger.log(`Still working... (${elapsed}s)`);
 *    });
 *    await slowOperation();
 *    stop();
 * ```
 */
export function startProgressTimer(
  onTick: (elapsed: number) => void,
  intervalMs = 5000,
): () => void {
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += intervalMs / 1000;
    onTick(elapsed);
  }, intervalMs);
  return () => clearInterval(timer);
}

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
    );
  }
  return value;
}

export function getErrorName(error: unknown): string | undefined {
  if (error != null && typeof error === "object" && "name" in error) {
    return (error as { name: string }).name;
  }
  return undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  if (error != null && typeof error === "object" && "code" in error) {
    return (error as { code: string }).code;
  }
  return undefined;
}
