# CLI Error Model and Exit Codes Plan

## Goal

Add a consistent CLI error model so failures are categorized predictably and mapped to explicit exit codes.

## Scope

In scope:

- Define a small error taxonomy for CLI-facing failures.
- Map categories to stable process exit codes.
- Route top-level CLI failures through one classifier.
- Keep command behavior unchanged; improve only error typing/reporting.
- Add focused tests for classification and code mapping.

Out of scope:

- Refactoring every command module to custom error types.
- Changing AWS command logic or output payload formats.
- New CLI commands.

## Proposed taxonomy

- `usage`: bad/unsupported command usage or missing required flags in non-interactive mode.
- `validation`: invalid user input values (for example malformed `--email`).
- `precondition`: missing setup or incompatible local state/context/config files.
- `runtime`: AWS/API/network failures and unknown internal errors.

## Exit code mapping

- `0`: success
- `2`: usage
- `3`: validation
- `4`: precondition
- `1`: runtime/internal fallback

## Implementation steps

1. Add `src/cliError.ts`:
   - `CliErrorKind` union type.
   - `CliError` class.
   - Constructors: `usageError`, `validationError`, `preconditionError`.
   - `classifyCliError(error)` for fallback classification of non-typed errors.
   - `exitCodeForCliErrorKind(kind)` mapping helper.

2. Update `src/cli.ts`:
   - Use typed constructors for direct CLI validation/usage failures.
   - In top-level `main().catch`, classify with `classifyCliError`.
   - Print standardized prefix (`CLI <kind> error: ...`).
   - Set `process.exitCode` via `exitCodeForCliErrorKind`.

3. Add tests `src/cliError.test.ts`:
   - direct `CliError` kind detection.
   - message-based fallback classification for usage/validation/precondition.
   - runtime fallback for unknown messages.
   - exit code mapping assertions.

4. Validate:
   - `npm run typecheck`
   - `npm test`

## Acceptance criteria

- CLI failures map to explicit, deterministic exit codes.
- Top-level CLI error output uses consistent category-prefixed format.
- Error classification and exit-code mapping are covered by tests.
- Existing command behavior remains functionally unchanged.
