# Repository Structure

Agreed structure for the v1 codebase (historical phase-1 layout evolved with additional commands and tests).

```text
.
├── README.md
├── plan.md
├── project.md
├── package.json
├── tsconfig.json
├── docs/
│   ├── phase-1-decisions.md
│   ├── phase-2-decisions.md
│   ├── phase-3-decisions.md
│   ├── v1-backlog-priority.md
│   ├── account-tag-inheritance-research.md
│   └── repository-structure.md
├── src/
│   ├── cli.ts
│   ├── state.ts
│   ├── state.test.ts
│   ├── awsClientConfig.ts
│   ├── awsConfig.ts
│   ├── awsConfig.test.ts
│   └── commands/
│       ├── scan.ts
│       ├── scan.test.ts
│       ├── bootstrap.ts
│       ├── bootstrap.test.ts
│       ├── init.ts
│       ├── init.test.ts
│       ├── regenerate.ts
│       ├── regenerate.test.ts
│       ├── graveyard.ts
│       ├── graveyard.test.ts
│       ├── plan.ts
│       ├── plan.test.ts
│       ├── apply.ts
│       └── apply.test.ts
```

## Conventions

- Import Valibot as a namespace and call helpers on it: `import * as v from "valibot"` then `v.pipe()`, `v.strictObject()`, `v.parse()`, etc. Do not use named imports like `import { pipe } from "valibot"`.
- Infer persisted file types from Valibot schemas via `v.InferOutput<typeof schema>`. Do not hand-write duplicate persisted type declarations when a schema already exists.
- Tests use explicit `./foo.js` imports next to sources so TypeScript lines up with emitted ESM; run **`npm test`** to compile with esbuild then **`node --test`** on **`dist/*.test.js`** (no `--experimental-strip-types`).
- Build output is intentionally **unbundled ESM**. The build script compiles runtime modules via glob entrypoints (`src/*.ts` and `src/commands/*.ts`) so every file imported by `dist/cli.js` is present in `dist/`.
- Bootstrap planning helpers (`aws.context.json` schema, OU analysis, conflict checks) live in **`src/commands/bootstrap.ts`** next to `runBootstrapCommand`.
- Functions take a single `props` object argument. Do not use positional argument lists.
- Do not destructure `props` inside functions; access fields via `props.fieldName`.
- Prefer object-property shorthand when key and variable names are identical (for example, use `{ organizationsClient }` instead of `{ organizationsClient: organizationsClient }`).
- Define helper types (`FooProps`, `FooResult`) immediately above the function they belong to.
- Do not export types or functions that are only used inside the same module.
- Group related types together. Do not create a separate type for every small shape when an inline type keeps code clearer (for example, prefer an inline `{ planLines: string[] }` for one-off callback props instead of introducing a dedicated standalone type).
- Command entrypoints must receive required AWS SDK clients via `props`; do not instantiate command clients internally.
- Keep command dependencies explicit for production and tests; do not make client injection optional.
- Test module behavior through exported/public APIs; do not export internals only to make testing easier.
- Parallelize independent async operations with `Promise.all` where there is no data dependency, and keep dependent operations sequential.
- Keep user interaction concerns (TTY checks, prompts, `--yes` semantics) in `cli.ts`; command modules receive callback/flags via props.
- Prefer `value != null` checks over generic falsy checks when testing presence; avoid `Boolean(value)` for nullish checks.
- Colocate tests as `*.test.ts` next to the module under test (for example `src/state.test.ts`).
- Keep scan logic in one file: `src/commands/scan.ts`.
- Keep state model + validation + normalization + read/write in one file: `src/state.ts`. Repeated keyed state transformations should use a working-state abstraction there: convert persisted arrays to record maps once, apply lookups/updates against the working state, then materialize back to arrays once before persistence.
- Keep `aws.config.ts` schema, picklist generation, state→config transform, codegen, and the loader in one file: `src/awsConfig.ts`. Phase 5's `aws.config.ts` → `state.json` transform also lives here when added.
- Keep `init` orchestration in `src/commands/init.ts` — it calls existing `runBootstrapCommand` / `runScanCommand` rather than reimplementing them.
- Keep shared reusable helpers in `src/` root (not under `shared/`).
- Keep command files under `src/commands/`.
- Keep implementation explicit and simple.
- Do not use `if/else if` or `if/else` chains. Use guard `if` statements that return early, then let the remaining code handle the happy path. For exhaustive checks, use standalone `if` statements with early returns followed by `assertUnreachable` at the end.
- Do not keep task tracking in internal Cursor-only todo state. If a checklist, handoff, or work log is needed, keep it on disk in the repo and update that shared file so other agents can see the current status.
- For fixed command-name sets, define a `const` tuple and derive the union type from it (`type CommandName = (typeof commands)[number]`), then guard unknown input with a dedicated type guard (`isCommandName(value)`). When needed, add a small assert helper around the guard for fail-fast narrowing at module boundaries.
- Never commit or amend git commits unless the user explicitly asks. Only stage and commit when instructed.
