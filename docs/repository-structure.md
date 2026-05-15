# Repository Structure

Current layout of the @beesolve/aws-accounts codebase.

```text
.
├── README.md
├── package.json
├── tsconfig.json
├── aws.config.ts              (user-editable desired state)
├── aws.config.types.ts        (generated valibot schema + picklists)
├── aws.context.json           (deployment metadata: Lambda ARN, S3 bucket, IdC instance)
├── .remote-state-cache.json   (cached remote state for offline plan)
├── docs/
│   ├── adr/
│   │   ├── 001-remove-local-execution-model.md
│   │   ├── 002-architecture-and-technology-choices.md
│   │   └── 003-v1-implementation-phases.md
│   ├── account-tag-inheritance-research.md
│   ├── repository-structure.md
│   └── v1-backlog-priority.md
├── scripts/
│   └── buildLambda.ts
├── src/
│   ├── cli.ts                 (CLI entry point — routes to commands)
│   ├── state.ts               (state model, validation, working-state abstraction)
│   ├── diff.ts                (state-vs-state diff engine)
│   ├── operations.ts          (operation model — discriminated union + schemas)
│   ├── applyLogic.ts          (operation execution logic, used by Lambda)
│   ├── scanLogic.ts           (AWS scanning logic, used by Lambda)
│   ├── awsConfig.ts           (config loader, codegen, state↔config transforms)
│   ├── awsClientConfig.ts     (AWS SDK client configuration + credential resolution)
│   ├── lambdaClient.ts        (Lambda invocation helper)
│   ├── remoteStateCache.ts    (local cache read/write with TTL freshness)
│   ├── helpers.ts             (shared utilities)
│   ├── error.ts               (CLI error classification + exit codes)
│   ├── logger.ts              (logger interface)
│   ├── tags.ts                (tag normalization + diff)
│   ├── accountCreation.ts     (account creation polling logic)
│   ├── reservedOuDeletion.ts  (OU deletion safety guards)
│   ├── commands/
│   │   ├── remote.ts          (remote command handlers: bootstrap, scan, init, plan, apply, upgrade)
│   │   ├── regenerate.ts      (local: refresh aws.config.types.ts from aws.config.ts)
│   │   └── graveyard.ts       (local: list accounts in Graveyard OU)
│   └── lambda/
│       └── handler.ts         (Lambda function handler — scan, apply, state management)
├── dist/                      (esbuild output — unbundled ESM)
└── dist-lambda/               (Lambda deployment artifact)
    ├── handler.mjs
    └── lambda.zip
```

## Conventions

- Import Valibot as a namespace: `import * as v from "valibot"` then `v.pipe()`, `v.strictObject()`, `v.parse()`, etc. Do not use named imports.
- Infer persisted file types from Valibot schemas via `v.InferOutput<typeof schema>`. Do not hand-write duplicate type declarations.
- Tests use explicit `./foo.js` imports next to sources so TypeScript lines up with emitted ESM; run `npm test` to compile with esbuild then `node --test` on `dist/*.test.js`.
- Build output is intentionally unbundled ESM. The build script compiles runtime modules via glob entrypoints so every file imported by `dist/cli.js` is present in `dist/`.
- Functions take a single `props` object argument. Do not use positional argument lists.
- Do not destructure `props` inside functions; access fields via `props.fieldName`.
- Prefer object-property shorthand when key and variable names are identical.
- Define helper types (`FooProps`, `FooResult`) immediately above the function they belong to.
- Do not export types or functions that are only used inside the same module.
- Group related types together. Prefer inline types for one-off shapes over dedicated standalone types.
- Command entrypoints receive required AWS SDK clients via `props`; do not instantiate clients internally.
- Keep command dependencies explicit for production and tests; do not make client injection optional.
- Test module behavior through exported/public APIs; do not export internals only to make testing easier.
- Parallelize independent async operations with `Promise.all` where there is no data dependency.
- Keep user interaction concerns (TTY checks, prompts, `--yes` semantics) in `cli.ts`; command modules receive callback/flags via props.
- Prefer `value != null` checks over generic falsy checks when testing presence.
- Colocate tests as `*.test.ts` next to the module under test.
- Keep shared reusable helpers in `src/` root (not under `shared/`).
- Keep command files under `src/commands/`.
- Do not use `if/else if` or `if/else` chains. Use guard `if` statements that return early. For exhaustive checks, use standalone `if` statements with early returns followed by `assertUnreachable`.
- For fixed command-name sets, define a `const` tuple and derive the union type from it (`type CommandName = (typeof commands)[number]`), then guard unknown input with a type guard.
- Never commit or amend git commits unless the user explicitly asks.
