# Logging Refactor Plan

This document defines the logging refactor before implementation. It is the source of truth for scope, design choices, sequencing, and test impact.

## Why this refactor

Current logging is done via direct `console.*` calls spread across command and helper modules. That creates two problems:

1. **Tests are noisy and harder to control** because many code paths print by default.
2. **Behavior is hard to substitute** (for example, no-op logging in tests) because logging is not injected as a dependency.

Goal: replace direct `console.*` usage with an injected `Logger` dependency everywhere.

## Design goals

- Keep implementation simple and explicit.
- Preserve current runtime logging behavior in CLI usage.
- Make logging fully injectable for tests.
- Allow no-op logging without stubbing global `console`.
- Avoid introducing global singletons or hidden state.

## Logger contract

Use a logger interface that mirrors console methods used in the repo:

```ts
export interface Logger {
  log: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  trace: (...args: any[]) => void;
}
```

Even if only `log` is heavily used today, supporting all common console methods prevents churn during migration and keeps callsites expressive.

## Implementations

`src/logger.ts` will provide:

1. **Console-backed logger** (production default):
   - each method delegates to `console.<method>`.
2. **No-op logger** (testing default):
   - every method is a no-op function.
3. **Optional test collector helper**:
   - captures messages in arrays for assertion-heavy tests.

## Dependency injection strategy

Inject `logger` into every command and drill it into helper functions that currently print.

### Composition root

- `src/cli.ts` creates one logger instance (`consoleLogger`) and passes it to commands.
- CLI remains responsible for interactive prompts and command-line semantics.

### Command layer

All command input types should require `logger: Logger` (not optional):

- `runScanCommand`
- `runBootstrapCommand`
- `runInitCommand`
- `runRegenerateCommand`
- `runPlanCommand`
- `runApplyCommand`
- future commands (e.g. create-account)

### Helper/module layer

Any helper function that currently prints should receive and use `logger` instead of direct `console.*`.

This includes non-command modules when they perform operational output (for example config regeneration/write summaries).

## Scope of replacement

Replace **all direct `console.*` calls** in `src/` modules with `logger.*`, except one intentional boundary:

- Top-level fatal handler in `cli.ts` may keep direct `console.error` initially, or be switched to injected logger if we decide to pass logger into bootstrap of `main()`.

Default recommendation for this increment:
- keep fatal `console.error` in CLI catch as boundary output.

## API and conventions

- Command function props remain explicit and required.
- No destructuring convention remains unchanged.
- Do not export internals only for testing.
- Tests should pass injected logger (noop or collecting), not mutate global console.

## Testing approach

### Unit tests

- Default to `noopLogger` to suppress output noise.
- Where output assertions are needed, pass a collecting logger and assert on collected lines.

### Integration-style command tests

- Use collecting logger when verifying message content.
- Continue asserting side effects (files, AWS mock calls, return statuses).

## Rollout plan

1. Add `src/logger.ts` with interface + console/noop implementations.
2. Add `logger` to command input types and pass from CLI.
3. Replace `console.*` in command modules with `logger.*`.
4. Drill `logger` into helper modules that currently print.
5. Update tests to pass logger explicitly.
6. Run `npm run typecheck` and `npm test`.
7. Update progress docs (`plan.md` and phase docs) after successful migration.

## Risk and mitigation

- **Risk:** missing one `console.*` call leads to mixed behavior.
  - **Mitigation:** run repository search for `console.` in `src/` before and after.
- **Risk:** signature churn causes broad compile failures.
  - **Mitigation:** migrate in order: logger module -> CLI injection -> command signatures -> helper drilling.
- **Risk:** tests become brittle if asserting raw console formatting.
  - **Mitigation:** prefer asserting behavior + structured collected logs.

## Acceptance criteria

- No direct `console.*` calls remain in command/helper runtime modules under `src/` (except approved CLI fatal boundary if retained).
- All command entrypoints require `logger` in props.
- CLI passes `consoleLogger` to every command.
- Tests can run with no-op logger without global console stubs.
- Typecheck and test suite pass.

