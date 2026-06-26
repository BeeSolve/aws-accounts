# ADR 002: Architecture and Technology Choices

## Status

Accepted

## Date

2025-01-15

## Context

This project needed a CLI tool to manage AWS Organizations structure and IAM Identity Center configuration declaratively — similar to Terraform but purpose-built for the Organizations + Identity Center domain.

Key requirements:

- Declarative config file (`aws.config.ts`) as the source of truth for desired state
- Plan/apply workflow with safety gates for destructive operations
- Support for Organizations (OUs, accounts, tags) and IAM Identity Center (users, groups, permission sets, assignments)
- Remote execution via Lambda for simplified IAM permissions

## Decisions

### Runtime and Language

- **Node.js 24+** with TypeScript 6+ (native type stripping, no transpilation step for development)
- **esbuild** for production builds (unbundled ESM output, fast compilation)
- **No barrel files** — direct imports between modules

### Validation

- **Valibot** for all schema validation (state files, config files, operation models)
- Import as namespace: `import * as v from "valibot"`
- Types inferred from schemas via `v.InferOutput<typeof schema>` — no duplicate hand-written types

### Testing

- **Node test runner** (`node --test`) — no external test framework
- Tests colocated as `*.test.ts` next to source modules
- Build tests separately with esbuild, run compiled `.test.js` files
- Mocked AWS SDK clients via lightweight handlers (no mocking library)

### AWS SDK

- **AWS SDK v3** with individual client packages
- Default `StandardRetryStrategy` for retries — no custom retry helpers
- Inline pagination (`do { ... } while (NextToken != null)`)
- Client injection via props — commands never instantiate their own clients

### State Management

- **Remote state in S3** (managed by Lambda) — single source of truth for current AWS state
- **Local cache** (`.remote-state-cache.json`) for offline plan computation with TTL-based freshness
- **`aws.config.ts`** as the user-editable desired state (TypeScript file with valibot validation)
- **`aws.context.json`** for deployment metadata (Lambda ARN, S3 bucket, Identity Center instance)

### Execution Model

- **Lambda-based remote execution** — CLI invokes Lambda for all AWS operations
- Users need only `lambda:InvokeFunction` for routine operations
- Lambda has reserved concurrency of 1 for built-in state protection (best-effort on new accounts with low concurrency quotas)
- Local utility commands (`regenerate`, `graveyard`) operate on local files only

### Config-Driven Reconciliation

- `plan` computes diff between desired (`aws.config.ts`) and actual (remote state)
- `apply` recomputes plan inline and executes via Lambda (no saved plan artifact in v1)
- Destructive operations require explicit `--allow-destructive` flag
- Unsupported diffs block apply by default; `--ignore-unsupported` proceeds past non-destructive ones

### Code Organization

- Single `props` object argument for all functions (no positional args)
- No destructuring of props — access via `props.fieldName`
- Helper types defined immediately above their function
- Guard-style early returns (no if/else chains)
- Shared modules in `src/` root, commands in `src/commands/`

## Consequences

- TypeScript provides type safety and IDE autocomplete for the config file
- Valibot schemas serve as both runtime validation and type source
- esbuild keeps builds fast (sub-second for the full project)
- Lambda execution simplifies IAM requirements for end users
- No saved plan artifact means apply always recomputes (acceptable for single-operator use)
