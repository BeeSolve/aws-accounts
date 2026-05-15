---
inclusion: auto
---

# Code style, conventions and rules

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
- Do not introduce new dependencies (like tsx, ts-node) for running TypeScript. Node's built-in type stripping is used in this codebase.
