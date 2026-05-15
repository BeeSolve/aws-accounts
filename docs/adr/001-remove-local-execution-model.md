# ADR 001: Remove Local Execution Model

## Status

Accepted

## Date

2025-01-20

## Context

The @beesolve/aws-accounts CLI originally supported two execution models:

1. **Local execution** — the CLI directly invoked AWS SDK clients (Organizations, SSO Admin, Identity Store, Account, STS) to perform scan, bootstrap, init, plan, apply, and graveyard operations, reading and writing a local `state.json` file.
2. **Remote execution** — the CLI invoked a deployed AWS Lambda function to perform the same operations, with state persisted in S3.

Maintaining both paths created ongoing costs:

- Two sets of command implementations with overlapping logic
- Users needed broad IAM permissions (organizations:*, sso:*, identitystore:*, account:*) for local execution
- No built-in concurrency control for local execution — multiple users could corrupt shared state
- Every new feature required implementation and testing across both paths

## Decision

Remove the local execution model from the main codebase. The remote (Lambda-based) execution model becomes the sole path for AWS operations.

### Rationale

1. **Simpler permission model** — users only need `lambda:InvokeFunction` permission on the deployed Lambda function for routine operations (scan, plan, apply, init). Infrastructure commands (bootstrap, upgrade) require additional permissions but are run infrequently.
2. **Reduced maintenance** — eliminating the local execution path removes an entire set of command implementations, their tests, and the need to keep two paths in sync when shared logic changes.
3. **Built-in concurrency control** — Lambda's reserved concurrency (set to 1) prevents concurrent executions from corrupting state, which was not enforced in the local model.

## Recovery Point

The complete local execution code was extracted into the `local/` folder and committed as a discrete recovery point before removal:

- **Commit:** `3e7a30d`
- **Message:** "feat: extract local execution code to local/ — preserve local execution model"

The `local/` folder remains in the repository and contains a fully self-contained copy of the local-first CLI with its own `package.json`, `tsconfig.json`, and build scripts. To recover the local version:

```bash
cd local/
npm install
npm run build
node dist/cli.js --help
```

## Changes

### Files Removed from `src/`

| File | Purpose |
|------|---------|
| `src/commands/scan.ts` | Local scan command (direct AWS SDK calls) |
| `src/commands/scan.test.ts` | Tests for local scan |
| `src/commands/bootstrap.ts` | Local bootstrap command |
| `src/commands/bootstrap.test.ts` | Tests for local bootstrap |
| `src/commands/init.ts` | Local init command |
| `src/commands/init.test.ts` | Tests for local init |
| `src/commands/plan.ts` | Local plan command |
| `src/commands/plan.test.ts` | Tests for local plan |
| `src/commands/apply.ts` | Local apply command |
| `src/commands/apply.test.ts` | Tests for local apply |

### Commands Removed as Local Execution

- `scan` (local) — replaced by top-level `scan` routing to remote handler
- `bootstrap` (local) — replaced by top-level `bootstrap` routing to remote handler
- `init` (local) — replaced by top-level `init` routing to remote handler
- `plan` (local) — replaced by top-level `plan` routing to remote handler
- `apply` (local) — replaced by top-level `apply` routing to remote handler

### Commands Retained as Local Utilities

- `regenerate` — reads local config files and regenerates TypeScript types (no AWS SDK calls)
- `graveyard` — reads remote state cache and lists closed/suspended accounts (no AWS SDK calls)

### Commands Promoted from Remote Subcommands to Top-Level

Previously under the `remote` namespace, now top-level:

- `bootstrap` — deploys Lambda infrastructure
- `scan` — triggers remote scan of AWS Organizations and Identity Center
- `init` — triggers remote scan and generates local config files
- `plan` — computes diff between local config and remote state
- `apply` — sends operations to Lambda for execution
- `upgrade` — upgrades deployed Lambda infrastructure

### CLI Namespace Removed

The `remote` subcommand namespace was removed entirely. The remote execution model is now the default and only path — there is no need to distinguish it from a local path.

## Consequences

- The remote execution model is now the **sole path** for all AWS operations (scan, plan, apply, init, bootstrap, upgrade).
- Users must have a deployed Lambda function to use the CLI for AWS operations.
- Local utility commands (`regenerate`, `graveyard`) continue to work without Lambda.
- The `local/` folder in the repository serves as a historical reference and recovery point.
- Future features only need to be implemented once (in the Lambda handler and remote command path).
