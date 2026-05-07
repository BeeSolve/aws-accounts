# Repository Structure

Agreed structure for implementation, with phase 1 emphasis.

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
│   └── repository-structure.md
├── src/
│   ├── cli.ts
│   ├── state.ts
│   ├── state.test.ts
│   ├── awsClientConfig.ts
│   ├── retry.ts
│   └── commands/
│       ├── scan.ts
│       ├── bootstrap.ts
│       ├── bootstrap.test.ts
│       ├── createAccount.ts
│       ├── plan.ts
│       └── apply.ts
```

## Conventions

- Import Valibot as a namespace and call helpers on it: `import * as v from "valibot"` then `v.pipe()`, `v.strictObject()`, `v.parse()`, etc. Do not use named imports like `import { pipe } from "valibot"`.
- Infer persisted file types from Valibot schemas via `v.InferOutput<typeof schema>`. Do not hand-write duplicate persisted type declarations when a schema already exists.
- Tests use explicit `./foo.js` imports next to sources so TypeScript lines up with emitted ESM; run **`npm test`** to compile with esbuild then **`node --test`** on **`dist/*.test.js`** (no `--experimental-strip-types`).
- Bootstrap planning helpers (`aws.context.json` schema, OU analysis, conflict checks) live in **`src/commands/bootstrap.ts`** next to `runBootstrapCommand`.
- Functions take a single `props` object argument. Do not use positional argument lists.
- Do not destructure `props` inside functions; access fields via `props.fieldName`.
- Define helper types (`FooProps`, `FooResult`) immediately above the function they belong to.
- Keep user interaction concerns (TTY checks, prompts, `--yes` semantics) in `cli.ts`; command modules receive callback/flags via props.
- Prefer `value != null` checks over generic falsy checks when testing presence; avoid `Boolean(value)` for nullish checks.
- Colocate tests as `*.test.ts` next to the module under test (for example `src/state.test.ts`).
- Keep scan logic in one file: `src/commands/scan.ts`.
- Keep state model + validation + normalization + read/write in one file: `src/state.ts`.
- Keep shared reusable helpers in `src/` root (not under `shared/`).
- Keep command files under `src/commands/`.
- Keep implementation explicit and simple.
