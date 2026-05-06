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
│       ├── createAccount.ts
│       ├── plan.ts
│       └── apply.ts
```

## Conventions

- Colocate tests as `*.test.ts` next to the module under test (for example `src/state.test.ts`).
- Keep scan logic in one file: `src/commands/scan.ts`.
- Keep state model + validation + normalization + read/write in one file: `src/state.ts`.
- Keep shared reusable helpers in `src/` root (not under `shared/`).
- Keep command files under `src/commands/`.
- Keep implementation explicit and simple.
