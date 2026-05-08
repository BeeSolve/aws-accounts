# Phase 4 Plan: `create-account` (local AWS SDK flow)

This is the working implementation plan for Phase 4 account creation.  
No reconciliation behavior is changed here; this command is a dedicated create flow.

## Goal

Implement `create-account` so an operator can create a new AWS account and have local config updated safely and deterministically.

Command shape (increment 1, local-only):

- `npm run cli -- create-account --name <accountName> --email <email> [--yes] [--profile] [--region]`
- If `--name` / `--email` are missing and session is interactive (TTY), prompt in order:
  1. email
  2. account name

## Scope

In scope:

- Validate inputs for account name/email.
- Resolve `Pending` OU id from `aws.context.json`.
- Create account via AWS Organizations.
- Poll account-creation status until terminal.
- On success, update `aws.config.ts` by adding the account under `Pending`.
- Refresh `aws.config.types.ts` to keep picklists in sync.
- Add tests and clear CLI output.

Out of scope:

- Moving account to non-`Pending` OU during creation.
- Any destructive operations.
- Cloud/Lambda/S3 execution model (still local CLI AWS SDK).
- Applying metadata drift beyond name/email creation inputs.

## Design constraints from existing codebase

- Keep command behavior explicit and predictable.
- Keep CLI orchestration in `src/cli.ts`; command logic in `src/commands/createAccount.ts`.
- Use valibot for runtime validation.
- Reuse existing helpers and patterns:
  - `readAwsContextFromFile` / `loadAwsConfigModelFromTsFile` from `src/awsConfig.ts`
  - overwrite confirmation pattern used by init/regenerate
  - logger injection (`Logger`)
- No source-of-truth change: `aws.config.ts` remains user-facing truth for desired state.
- Prefer deterministic model-based regeneration over ad-hoc text patching when mutating `aws.config.ts`.

## Proposed command flow

1. Parse and validate CLI args (`--name`, `--email` required).
   - If missing in TTY mode, prompt for missing values (email first, then name).
   - Prompt UX: empty/invalid values re-prompt until valid input is provided (no immediate hard-fail).
   - If missing in non-interactive mode, fail with actionable message.
   - After interactive resolution, print a replayable command line including explicit flags so users can copy/paste on retry.
2. Read `aws.context.json` and resolve `pendingOuId`.
3. Read `aws.config.ts` (and schema/types) to check local duplicates by account name/email.
4. Optional preflight in AWS (best-effort) for idempotent retry safety:
   - list accounts and detect existing account by same email/name.
5. If account already exists:
   - if already represented in `aws.config.ts`, return no-op success.
   - if missing in local config, do not modify files; warn user and suggest running `scan` (or `init`) to reconcile local state.
6. If account does not exist:
   - call `CreateAccountCommand` with name/email.
   - poll settings are explicit command inputs and required: `timeoutInMs`, `pollIntervalInMs`
   - poll `DescribeCreateAccountStatusCommand` until terminal:
     - `SUCCEEDED` -> capture account id
     - `FAILED` -> return actionable failure with AWS reason
     - timeout at 15 minutes -> fail with timeout guidance
   - use a local non-exported `delay(ms)` helper in command module (no shared/global helper export)
7. Update `aws.config.ts` (created outcome only):
   - load current config model, append account `{ name, email }` into `organizationalUnits[name="Pending"].accounts`, then re-render deterministically
   - keep deterministic ordering by account name in `Pending.accounts`
   - do not perform text-level/surgical patching
8. Regenerate `aws.config.types.ts` from updated config.
9. Print summary lines (started, waiting/polling, created/reused, config updated, types updated).

## Files to add/modify (planned)

New:

- `src/commands/createAccount.ts`
- `src/commands/createAccount.test.ts`

Modified:

- `src/cli.ts` (wire command + args + help)
- `src/awsConfig.ts` (small helper(s) for safe config update by account insertion, if needed)
- `plan.md` (tick Phase 4 checkboxes as completed)

## Validation model

Input schema (valibot):

- `name`: non-empty string, reasonable length, trimmed (and reject leading/trailing-only values)
- `email`: non-empty + email format

Operational validations:

- `Pending` OU must exist in `aws.context.json` and in loaded config model.
- Reject duplicate account name/email already present in config unless handling idempotent-retry flow.
- New account creation target is always `Pending` OU in increment 1.
- Polling configuration is required at command boundary:
  - `timeoutInMs` (required)
  - `pollIntervalInMs` (required)

## Idempotency/retry strategy

Primary intent:

- Safe to re-run command if network/process interruption happens after AWS account was created.

Behavior:

- Best-effort lookup in AWS accounts list by email/name.
- If existing account found and missing locally, do not patch local config automatically; instruct user to run `scan`/`init`.
- If not found, proceed with `CreateAccount`.

Notes:

- AWS account creation is asynchronous; terminal status polling is required.
- Duplicate checks are advisory; final AWS APIs remain source of truth.

## Test plan

`src/commands/createAccount.test.ts`:

1. Reject missing/invalid `name` or `email`.
2. Fail with actionable error when `Pending` missing in context/config.
3. Happy path:
   - create call issued
   - polling transitions to success
   - account added to `Pending` in `aws.config.ts`
   - `aws.config.types.ts` refreshed
4. Polling failure path:
   - terminal `FAILED` returns reason and does not update config.
5. Timeout path:
   - exceeds 15 minutes -> timeout error and no config write.
   - implemented in tests via short required `timeoutInMs` and deterministic mocked `IN_PROGRESS` statuses.
6. Idempotent retry path:
   - existing account found by preflight -> no duplicate create call; no local config mutation; clear rescan guidance shown.
7. Non-interactive behavior with `--yes` equivalent callback paths.

## Rollout order

1. Define command input/result contract and validation schema.
2. Implement AWS create + polling core.
3. Implement config insertion + types regeneration integration.
4. Wire CLI args/help and command dispatch.
5. Add tests and stabilize deterministic output.
6. Update `plan.md` progress checkboxes.

## Risks and mitigations

- Risk: duplicate local entries in `Pending`.
  - Mitigation: dedupe by account name/email before write.
- Risk: polling loops too chatty or too silent.
  - Mitigation: log periodic progress on status changes only.
- Risk: interactive input mistakes create friction on retry.
  - Mitigation: re-prompt on invalid input and echo full resolved command with flags for easy rerun.
- Risk: partial updates (types regenerated but config not, or vice versa).
  - Mitigation: update config first, then regenerate types; fail fast with clear message.

## Acceptance criteria

- `create-account` command works end-to-end locally with AWS SDK v3.
- Enforces 15-minute timeout for account creation polling.
- Updates `aws.config.ts` under `Pending` and refreshes `aws.config.types.ts`.
- Uses deterministic config mutation path (model load + render), not text patching.
- Retry-safe behavior for already-created account cases.
- Typecheck and tests pass.

## Implementation checklist (progress tracker)

### Core command

- [x] Add `src/commands/createAccount.ts` with explicit input/output contracts.
- [x] Require `timeoutInMs` and `pollIntervalInMs` in create-account command input.
- [x] Validate user-provided email in CLI via valibot schema and enforce non-empty name/email in command flow.
- [x] Resolve and validate `Pending` OU from `aws.context.json`.
- [x] Load and validate current `aws.config.ts` model before create flow.

### AWS flow

- [x] Implement AWS preflight account lookup (name/email best-effort idempotency check).
- [x] Implement `CreateAccountCommand` call for non-existing accounts.
- [x] Implement polling with `DescribeCreateAccountStatusCommand`.
- [x] Implement local (non-exported) `delay(ms)` helper in `createAccount` command module.
- [x] Handle terminal outcomes (`SUCCEEDED`, `FAILED`) with actionable messaging.
- [x] Enforce 15-minute timeout with explicit timeout error guidance.

### Local file update policy

- [x] Existing account found and missing locally: do not modify files; print rescan/init guidance.
- [x] Created account path: insert account into `Pending` in config model.
- [x] Re-render `aws.config.ts` deterministically (no text patching).
- [x] Regenerate `aws.config.types.ts` after successful config update.
- [x] Ensure deterministic ordering for `Pending.accounts`.

### CLI UX and wiring

- [x] Wire `create-account` in `src/cli.ts` dispatch and help output.
- [x] Add `--name` and `--email` CLI flags for `create-account`.
- [x] Interactive mode: prompt missing fields in order (email, then name).
- [x] Interactive mode: re-prompt on empty/invalid values until valid.
- [x] Non-interactive mode: fail if required values are missing.
- [x] After interactive input resolution, print replayable full command with explicit flags.

### Tests

- [x] Add `src/commands/createAccount.test.ts`.
- [x] Validation tests (invalid/missing name/email).
- [x] Missing `Pending` context/config handling tests.
- [x] Happy path tests (create + poll success + config/types updates).
- [x] Poll failure tests (`FAILED` status).
- [x] Timeout tests (15-minute cutoff behavior).
- [x] Existing-account preflight tests (no create call, no file mutation, guidance output).
- [ ] CLI interaction tests (prompt order, re-prompt behavior, replay command output).

### Finalization

- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Update Phase 4 checkboxes in `plan.md`.
- [x] Prepare and create commit.
