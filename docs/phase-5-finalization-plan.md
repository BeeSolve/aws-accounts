# Phase 5 Finalization Plan

## Scope to Finish

- Add missing `mapAwsConfigToState` test coverage in `src/awsConfig.test.ts`.
- Update Phase 5 progress checklists in `docs/phase-5-plan.md` and `plan.md` to match implemented reality.
- Update command usage/safety docs in `README.md` for `plan`/`apply` behavior and recovery flow.

## Implementation Order

1. Add targeted tests for `mapAwsConfigToState`
- Extend `src/awsConfig.test.ts` with 3 focused cases:
  - Sentinel IDs: entities only in config get `"__pending_creation__"` IDs.
  - Root resolution: synthetic root OU in config resolves to `context.organization.rootId`.
  - Round-trip stability: unchanged config/current/context yields stable mapping expectations (only expected normalized differences).
- Reuse existing fixture helpers in the same test file to avoid test setup drift.

2. Reconcile plan checkboxes
- In `docs/phase-5-plan.md`:
  - Mark completed items now satisfied by implementation.
  - Keep genuinely incomplete items open only if not implemented.
- In `plan.md`:
  - Mark Phase 5 bullets as complete where implemented.
  - Keep cross-cutting items open only if still truly pending.

3. README sync for shipped behavior
- Update `README.md` workflow text to remove stale “out of scope” wording for sync.
- Add a concise `plan` + `apply` usage section covering:
  - `apply --yes`
  - `apply --ignore-unsupported` semantics (non-destructive only)
  - destructive unsupported diffs always refuse
  - partial-failure recovery: `scan` then re-`apply`

4. Validation and handoff
- Run `npm run typecheck` and `npm test`.
- Review `git status` for only intended files.
- Prepare a single commit including tests + docs alignment.

## Acceptance Criteria

- `mapAwsConfigToState` tests exist for sentinel ID emission, root resolution, and round-trip behavior.
- Phase 5 checklist docs reflect actual state (no stale unchecked boxes for completed work).
- README accurately documents current `plan`/`apply` behavior and safety constraints.
- Typecheck and test suite pass cleanly.
