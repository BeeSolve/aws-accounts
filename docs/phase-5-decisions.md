# Phase 5 Decisions

> **Note:** The local execution model described in this document was removed in favor of remote-only execution. See [docs/adr/001-remove-local-execution-model.md](adr/001-remove-local-execution-model.md).

This file records decisions agreed before implementing phase 5: introduce `plan` and `apply` to reconcile AWS Organizations state to `aws.config.ts`. Phase 3 shipped the `aws.config.ts` loader and the state→config transform that phase 5 reuses.

## Lifecycle (recap)

Phase 5 owns the third lifecycle phase introduced in `docs/phase-3-decisions.md`:

1. **Init** (one-time) — phase 3.
2. **Edit** (steady state) — user edits `aws.config.ts`; `regenerate` keeps `aws.config.types.ts` in sync.
3. **Apply** — `plan` and `apply` reconcile AWS to match `aws.config.ts`. **This phase.**

`scan` and `bootstrap` remain individually callable for recovery (see Partial-failure recovery below).

## Scope

- Two new commands: `plan` (read-only) and `apply` (mutation).
- One supported AWS mutation in increment 1: **moving accounts between OUs** (`MoveAccountCommand` from `@aws-sdk/client-organizations`).
- Reads `aws.config.ts`, `state.json`, `aws.context.json`. Writes `state.json` after successful (or partially successful) apply. Never modifies `aws.config.ts`.
- All other diffs (new OUs, OU renames, IdC mutations, account removals, new accounts) are detected but classified as **unsupported** — not executed in increment 1.

## CLI contract

### `plan`

- Read-only locally. No AWS API calls. No client construction.
- Loads `aws.config.ts` via the phase 3 loader, reads `state.json` and `aws.context.json`, computes a plan, prints it.
- Options:
  - `--json` — emit machine-readable plan instead of human format.
- Exit codes: 0 always (a diff is informational, not a gate); 1 only on internal error (load failure, schema validation failure).

### `apply`

- Recomputes the plan inline (no plan artifact in increment 1 — see Apply execution model).
- Options:
  - `--yes` — skip the confirmation prompt; same semantics as `bootstrap` / `init` / `regenerate`.
  - `--ignore-unsupported` — proceed past *non-destructive* unsupported diffs (executes only the supported ops). Has no effect on destructive unsupported diffs, which always refuse.
- Confirmation pattern reuses bootstrap's: CLI owns TTY / `--yes` handling, command receives a `planConfirmation(planLines)` callback.

## Operation model

`Operation` is a discriminated union. In this repo, operation models follow the same schema-first Valibot pattern as other internal contracts (schemas as source of truth, types inferred from schemas). Increment 1 ships exactly one variant:

```ts
type Operation = {
  kind: 'moveAccount';
  accountId: string;
  accountName: string;
  fromOuId: string;
  fromOuName: string;
  toOuId: string;
  toOuName: string;
};
```

Names are carried alongside ids so log / print output is human-readable without extra lookups.

`UnsupportedDiff` carries a category that drives the apply escape-hatch logic:

```ts
type UnsupportedDiff = {
  kind: UnsupportedDiffKind; // e.g. 'newOu', 'removedAccount', 'idcUserAdded'
  category: 'destructive' | 'unsupportedMutation';
  description: string;   // human-readable line for plan output
};
```

`Plan = { operations: Operation[]; unsupported: UnsupportedDiff[] }`.

Implementation notes:

- `operationSchema` uses `v.variant('kind', [...])`.
- `UnsupportedDiffKind` and `category` use `v.picklist([...])` to enforce literals at runtime.
- `diffStates` should return `v.parse(planSchema, computedPlan)` for defense-in-depth.

## Diff engine behavior

- Inputs: `current` (from `state.json`) and `next` (from `mapAwsConfigToState(config, current, context)`).
- Pure function. No I/O. Always returns a `Plan`. Never throws on unsupported diffs — let the command layer decide policy.
- Classification:

| Diff                                          | Classification                              |
| --------------------------------------------- | ------------------------------------------- |
| Account `parentId` change (both real ids)     | `Operation` (`moveAccount`)                 |
| Account in next has sentinel id (would-create)| `unsupportedMutation` (phase 4 owns create) |
| OU added in config                            | `unsupportedMutation`                       |
| OU renamed                                    | `unsupportedMutation`                       |
| OU removed in config                          | `destructive`                               |
| IdC entity added or changed                   | `unsupportedMutation`                       |
| Account removed from config                   | `destructive`                               |

- Determinism: `operations` sorted by `accountName`; `unsupported` sorted by `kind` then `description`.

## Apply execution model

### Recompute on apply (no saved artifact)

`apply` re-runs the plan logic from current `aws.config.ts` and `state.json`, prints the plan, confirms, executes. Increment 1 does not produce a saved plan file.

**Why not a saved artifact:**

- Increment 1 is local-only. The artifact's main value (review-across-sessions, separation of plan / apply operators in CI) does not pay off until the cloud-backed flow lands.
- A saved artifact requires a versioned format and state-fingerprint validation logic to refuse stale plans. Avoidable complexity for now.

**When the artifact lands:** alongside the cloud-backed flow in increment 2 (Lambda + S3). At that point `plan` writes a `plan.json` with a state fingerprint, and `apply` validates the fingerprint against current state before executing.

### Sequential, in-memory state mutation

Operations are executed sequentially via `OrganizationsClient`. After each successful op, an in-memory copy of `nextState` is updated to reflect the change so the partial-failure path knows what actually went through.

### State persistence

- All ops succeed → write the full `nextState` to `state.json`.
- One op fails → see Partial-failure recovery.
- No re-scan in the apply loop. The post-apply state comes from the planned-next-state, not from a fresh `scan`.

## Unsupported-diff handling

`apply` enforces a strict default in this order:

1. If `unsupported` contains any `category: 'destructive'` items → refuse, **no flag override**. Exit non-zero with a message naming the destructive diffs and noting that increment 1 does not support them.
2. Else, if `unsupported` contains any `category: 'unsupportedMutation'` items and `--ignore-unsupported` is **not** set → refuse. Exit non-zero with a list and tell the user to either remove the offending edits from `aws.config.ts` or pass the flag.
3. Else → proceed. If `--ignore-unsupported` was passed and only `unsupportedMutation` items are present, executes the supported ops; logs that the unsupported diffs were skipped.

**Why two tiers:**

- Destructive diffs (removing an account from config, deleting an OU) reflect catastrophic intent if executed; even with a flag, automation should not silently erase resources. Increment 1 does not implement removal at all, so the answer is always "go back and edit `aws.config.ts`".
- Non-destructive diffs (a half-finished new OU, an IdC change you're staging) are common during iteration. The flag preserves operator agency while keeping the safe default.

## Partial-failure recovery

When op N of M fails during apply:

1. Stop. Do not attempt remaining ops.
2. Log the failure with full SDK error context.
3. Write `state.json` from the in-memory next-state that reflects ops 1..N-1 (the ones that returned success from the SDK).
4. Exit non-zero.
5. Print explicit recovery guidance:

   ```
   Aborted after K of M operations.
   state.json updated to reflect the K successful moves.
   Run `npm run cli scan` to verify (op N may have actually succeeded
   server-side even though the SDK call threw), then re-run `apply` to
   continue.
   ```

**Why no rollback:** AWS Organizations has no transaction primitive. Rolling back a successful `MoveAccount` is itself a `MoveAccount`, which can fail, leading to even messier state. The simpler model — "we got partway, here's exactly where, scan to verify, retry" — matches what every operator-facing tool does and stays comprehensible under failure.

**Why `scan` is mandatory after failure:** the failure could be a network error after the server completed the work. The local view (`state.json`) cannot distinguish "server didn't do it" from "server did it but reply was lost". Only re-reading from AWS resolves the ambiguity.

## Why metadata reconciliation is deferred

`plan.md`'s original phase 5 list included "add account metadata entries". After surveying the AWS SDK v3 surface:

- `@aws-sdk/client-organizations` `CreateAccountCommand` accepts `Email`, `AccountName`, `IamUserAccessToBilling`, `RoleName`, `Tags`. The first two are reflected in `aws.config.ts` as `{ name, email }` and are set by phase 4 at create time. The latter two are immutable post-creation, so they belong with phase 4 args, not in `aws.config.ts`.
- `@aws-sdk/client-organizations` `TagResourceCommand` / `UntagResourceCommand` operate on accounts, OUs, roots, and policies. **Tags are the natural next-up** but require a `tags?: Record<string, string>` field on the account schema and corresponding diff logic.
- `@aws-sdk/client-account` provides `PutAccountNameCommand` (display name drift), `PutAlternateContactCommand` (BILLING / OPERATIONS / SECURITY contacts), `PutContactInformationCommand` (primary contact), `StartPrimaryEmailUpdateCommand` (root email — async with verification, **not safe to drive from `apply`**).

For increment 1, all of these stay out of scope. Move-account alone exercises the full plan / apply / state-persist loop. Adding metadata verbs each requires its own schema field, comparator, and SDK call — bundling them inflates the increment without adding to the architectural learning.

The schema is left open for additive growth: `account: { name, email, /* future: tags?, alternateContacts? */ }`.

## Tests

(Mirror existing patterns in `src/commands/bootstrap.test.ts` — Node `--test`, mocked AWS clients via lightweight handlers, `createTestWorkspace` from `src/helpers.test.ts`.)

- `src/awsConfig.test.ts` (extend) — `mapAwsConfigToState`:
  - Round-trip through `mapStateToAwsConfig` for unchanged inputs.
  - Sentinel ids emitted for entities only in config.
  - Synthetic root OU resolves to `context.organization.rootId`.
- `src/diff.test.ts`:
  - No-diff case.
  - Single move; multiple moves with deterministic order.
  - Each unsupported classification (new OU, OU rename, OU removed, IdC change, account removed, sentinel-id new account).
- `src/commands/plan.test.ts`:
  - Fixture workspace produces expected plan output.
  - `--json` shape.
- `src/commands/apply.test.ts`:
  - Mock `OrganizationsClient`; assert correct `MoveAccountCommand` calls and ordering.
  - Confirmation rejected → no SDK calls, exit cleanly.
  - Destructive unsupported diff → refuses regardless of `--ignore-unsupported`.
  - Non-destructive unsupported diff with `--ignore-unsupported` → proceeds with supported ops only.
  - Partial failure: 2 ops, 2nd fails → `state.json` reflects only 1st op; non-zero exit.
  - Successful apply rewrites `state.json`; does not touch `aws.config.ts`.

## Out of scope for phase 5 (increment 1)

- **Saved plan artifact.** Deferred to increment 2 (cloud flow).
- **Account metadata reconciliation.** Tags, alternate contacts, primary contact info, account-name drift correction. `aws.config.ts` keeps `account: { name, email }`.
- **New account creation in `apply`.** Now supported in later phases via `createAccount` operation.
- **OU creation / rename / deletion in `apply`.** OU create/rename and safe delete are now supported in later phases; only reserved `Graveyard` deletion remains blocked.
- **IdC mutations** (users, groups, permission sets, assignments).
- **Automatic rollback** on apply failure. Not feasible without transaction primitives in the AWS API.
- **Automatic re-scan** in the normal apply loop. State updates after apply come from the planned-next-state.
- **Email update** via `StartPrimaryEmailUpdateCommand` — async with manual verification, not safe to drive from `apply`.

## README documentation requirement

Once phase 5 ships, `README.md` must cover:

- The edit → `plan` → `apply` loop with example.
- The `--yes` and `--ignore-unsupported` flags and what each does.
- The destructive-diff-always-refuses rule with examples.
- The partial-failure recovery loop: `scan` then re-`apply`.
- That historical phase-5 constraints have been superseded by later shipped phases (see README for current capabilities).

Tracked under the existing cross-cutting "Add README usage notes" item in `plan.md`.
