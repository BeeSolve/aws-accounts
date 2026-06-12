# Code Review Findings

Date: 2026-06-10

## Recommendations (priority order)

- [ ] **Split `remote.ts` into subcommand files** — biggest maintainability win. Each command (bootstrap, init, plan, apply, upgrade, drift) is largely independent. The file is 76KB.
- [ ] **Extract `diff.ts` into domain-specific diff functions** — `diffOrganizationStructure`, `diffIdentityCenter`, `diffPolicies` — composed in the main `diffStates`. Currently 58KB / ~900-line single function.
- [ ] **Add a dedicated `applyLogic.test.ts`** — unit testing each operation executor independently rather than through integration paths. `applyLogic.ts` (63KB) currently has no direct test file.
- [ ] **Unify Lambda request/response schemas** in a single shared module imported by both `lambda/handler.ts` and `lambdaClient.ts`. Currently duplicated in both places.
- [ ] **Add Biome config and lint step to CI** to enforce code style conventions automatically. No `biome.json` or lint script exists today.
- [ ] **Explicitly configure S3 bucket encryption** in bootstrap (`CreateBucketCommand`) to make security posture auditable (AWS defaults to SSE-S3 but explicit is better).
- [ ] **Add exponential backoff** for transient AWS errors beyond `TooManyRequestsException`.

## Minor Issues

- 3 `as any` casts in production code (`remote.ts` ×2, `handler.ts` ×1) — replace with typed error narrowing helper.
- `(error as { name?: string }).name` pattern in handler — extract a reusable `isAwsError(error, name)` guard.
- `buildProfileEntries` in `profile.ts` uses `(a, b)` instead of project convention `(left, right)`.
- `awsConfig.ts` (72KB) mixes too many concerns: config loading, generation, mapping, codegen, version checking. Consider splitting by responsibility.

## Security Notes

- Dynamic import of user config executes arbitrary code — acceptable given threat model (user owns their config).
- Lambda top-level catch returns raw `error.message` — could leak internal paths. Consider sanitizing.
- Lambda role has `organizations:*` and `sso:*` — broad but necessary. Document as accepted risk.
- No rate limiting / backoff on CLI side for transient failures.

## What's Working Well

- Valibot schema → type inference eliminates duplication.
- Working state pattern (create → mutate → materialize) with optimistic S3 locking is robust.
- `assertUnreachable` exhaustiveness everywhere — compiler catches missing cases.
- Operation execution priority ordering ensures safe dependency order.
- Strong input validation at Lambda boundary (safeParse + response validation).
- Reserved concurrency + ETag locking prevents concurrent state corruption.
- All resources tagged for auditability (`ManagedBy: beesolve-aws-accounts`).
- Property-based tests with fast-check for state round-trips.
- No hardcoded secrets, no TODO/FIXME debt, clean CI pipeline.
