export function assertUnreachable(
  value: never,
  message: string = JSON.stringify(value),
): never {
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
  input: T[],
  key: keyof PickStringProps<T> | ((value: T) => string),
  keyTransformer: (key: string) => string = (key) => key,
): Record<string, T> {
  return Object.fromEntries(
    input.map((item) => [
      keyTransformer(typeof key === "function" ? key(item) : item[key]),
      item,
    ]),
  );
}
