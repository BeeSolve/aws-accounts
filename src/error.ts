export type CliErrorKind = "usage" | "validation" | "precondition" | "runtime";

export class CliError extends Error {
  kind: CliErrorKind;

  constructor(kind: CliErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "CliError";
  }
}

export function toUsageError(message: string): CliError {
  return new CliError("usage", message);
}

export function toValidationError(message: string): CliError {
  return new CliError("validation", message);
}

export function toPreconditionError(message: string): CliError {
  return new CliError("precondition", message);
}

export function classifyCliError(error: unknown): {
  kind: CliErrorKind;
  message: string;
} {
  if (error instanceof CliError) {
    return { kind: error.kind, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isUsageErrorMessage(message)) {
    return { kind: "usage", message };
  }
  if (isValidationErrorMessage(message)) {
    return { kind: "validation", message };
  }
  if (isPreconditionErrorMessage(message)) {
    return { kind: "precondition", message };
  }
  return { kind: "runtime", message };
}

export function exitCodeForCliErrorKind(kind: CliErrorKind): number {
  if (kind === "usage") {
    return 2;
  }
  if (kind === "validation") {
    return 3;
  }
  if (kind === "precondition") {
    return 4;
  }
  return 1;
}

function isUsageErrorMessage(message: string): boolean {
  return (
    message.includes("Missing required --") ||
    message.includes(
      "Refusing to create organizational units in non-interactive mode without --yes.",
    ) ||
    message.includes("Refusing to overwrite config files in non-interactive mode without --yes.")
  );
}

function isValidationErrorMessage(message: string): boolean {
  return message.includes("Invalid --");
}

function isPreconditionErrorMessage(message: string): boolean {
  return (
    message.includes("Could not find") ||
    message.includes("must exist") ||
    message.includes("Re-run bootstrap") ||
    message.includes("state/context mismatch") ||
    message.includes("aws.context.json conflicts")
  );
}
