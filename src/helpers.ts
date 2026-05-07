export function assertUnreachable(
  value: never,
  message: string = JSON.stringify(value),
): never {
  throw Error("An unreachable state reached!\n" + message);
}
