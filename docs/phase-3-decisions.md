# Phase 3 Decisions

This file records decisions agreed before implementing phase 3: introduce `init` (first-time setup) and `regenerate` (refresh `aws.config.types.ts` from `aws.config.ts`), produce `aws.config.ts` (human-editable) and `aws.config.types.ts` (generated valibot schema + inferred TypeScript type), and ship the `aws.config.ts` loader that phase 5 will reuse.

## Lifecycle

The tool's lifecycle has three phases:

1. **Init (one-time).** `init` runs `bootstrap` + `scan` and writes `aws.config.ts` + `aws.config.types.ts` from `state.json`. Re-runnable for reset / drift recovery, gated by overwrite confirmation.
2. **Edit (steady state).** User edits `aws.config.ts`. `regenerate` rebuilds `aws.config.types.ts` from the current `aws.config.ts` so picklists / IDE autocomplete stay in sync. A future `watch` command will run `regenerate` automatically on file change.
3. **Apply (phase 5).** `plan` and `apply` reconcile AWS to match `aws.config.ts`. Out of scope here.

`bootstrap` and `scan` remain individually callable for advanced / recovery use, but they are init-time commands — not part of the routine edit/apply loop.

## Scope

- `init` orchestrates `bootstrap` + `scan` + state→config write. No new AWS-mutation paths.
- `regenerate` is local-only. No AWS API calls, no IAM permissions required.
- Reads `state.json` (source: scan) and `aws.context.json` (source: bootstrap). Writes `aws.config.ts` and `aws.config.types.ts`.
- `aws.context.json` is **read-only** in this phase: the state→config transform validates that its identifiers still match `state.json` and fails on disagreement. Repair is bootstrap's responsibility.
- The reverse direction (`aws.config.ts` → planned mutations) is **out of scope** — phase 5 (`plan` / `apply`). Phase 3 ships the `aws.config.ts` *loader* that phase 5 will reuse.

## CLI contract

### `init`

- Orchestrates: `bootstrap` → `scan` → state→config write.
- Options (forwarded to underlying commands as needed):
  - `--profile`, `--region`, `--instance-arn` — same semantics as `bootstrap` and `scan`.
  - `--yes` — skip confirmations from any of the three steps (OU creation in bootstrap, file overwrite in config write).
- Calls existing `runBootstrapCommand` and `runScanCommand` directly — no logic duplication. The state→config write is implemented as a function in `src/awsConfig.ts` (`writeAwsConfigFromState` or similar) callable from `init`.

### `regenerate`

- Single purpose: refresh `aws.config.types.ts` from the current `aws.config.ts`.
- Does not modify `aws.config.ts` or any other file.
- Options:
  - `--yes` — skip confirmation when the regenerated types differ from the existing file.
- Confirmation behaviour mirrors `bootstrap`: command receives `overwriteConfirmation` callback; CLI owns TTY / `--yes` handling.

## File outputs

### `aws.config.ts`

- Default-exports an `AwsConfig` object.
- Imports the schema and type from `./aws.config.types.js`.
- Header comment lists the file's purpose, the `init` / `regenerate` workflow, and a note that the synthetic `{ name: "root", parentName: null }` entry represents the organization root and that `Graveyard` OU is managed by `bootstrap` and tracked in `aws.context.json` (do not rename).
- Edited by humans. Manual edits survive `regenerate` (which only touches the types file). Manual edits would be overwritten by re-running `init`, gated by confirmation.

### `aws.config.types.ts`

- Fully generated. Header comment marks it `do not edit by hand`.
- Exports both the runtime valibot schema (`awsConfigSchema`) and the inferred TypeScript type (`type AwsConfig = v.InferOutput<typeof awsConfigSchema>`).
- Picklists encode the actual names present in the data, so editing `aws.config.ts` benefits from IDE autocomplete on every cross-reference.

## Domain model

### Organization

- One unified list `organizationalUnits` (no separate `rootAccounts`).
- Each entry: `{ name: string, parentName: <picklist of OU names> | null, accounts: AccountRef[] }`.
- Exactly one entry has `parentName: null`. Its `name` is the reserved string `"root"`. That entry holds accounts that live directly under the organization root in AWS.
- Top-level OUs (e.g. `Sandbox`, `Security`) have `parentName: "root"`.
- `Graveyard` is intentionally omitted from generated `aws.config.ts`; it remains bootstrap-managed/internal and available in state/context.
- Account refs: `{ name: string, email: string }`. Email is carried inline because it is the AWS-meaningful identity for new account creation in phase 4 and useful documentation for readers.

### Identity Center

- `users[]`: `{ userName, displayName, emails }`.
- `groups[]`: `{ displayName }`.
- `permissionSets[]`: `{ name, description }`.
- `assignments[]`: grouped by `(principal, permissionSet)` with an `accounts: string[]` list. Each entry: `{ permissionSet, group?, user?, accounts }` — exactly one of `group` or `user` is set.
- `accessRoles` from `state.json` is **excluded** from `aws.config.ts` — fully derivable from `permissionSet` ARN + `accountId` at apply time.

### Sort order (deterministic emission)

- OUs: depth-first by tree level (root first, then top-level OUs, then children), then alphabetical by name within each level. Parents always emitted before children — readable on diff.
- Accounts inside an OU: alphabetical by `name`.
- Users / groups / permission sets: alphabetical by primary identifier (`userName`, `displayName`, `name`).
- Assignments: by principal (group / user name), then permission set name; account list within each: alphabetical.

## Picklists

Generated into `aws.config.types.ts` as `v.picklist([...])` of literals. Used at the five points where the user references an entity defined elsewhere in the config:

| Field                                | Picklist                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| `organizationalUnits[].parentName`   | union of `organizationalUnitNameSchema` and `v.null_()`               |
| `assignments[].permissionSet`        | `permissionSetNameSchema`                                             |
| `assignments[].group`                | `groupNameSchema` (optional)                                          |
| `assignments[].user`                 | `userNameSchema` (optional)                                           |
| `assignments[].accounts[]`           | `accountNameSchema`                                                   |

Entity *definition* fields (e.g. `organizationalUnits[].name`, `users[].userName`) stay `v.string()` — those are where names are *introduced*, not referenced.

## Validation rules

### Transform-time (state → config, used by `init`)

- Exactly one OU with `parentName: null`, named `"root"`. Reserved name — no other OU may use it.
- All other entries' `parentName` must reference an existing entry's `name`. No cycles. No orphans.
- Globally unique names within each entity type:
  - account names (since accounts are referenced by `name` only)
  - OU names (since picklist literals must be unique)
  - group display names
  - user user names
  - permission set names
- Failures produce actionable errors that name the conflicting entities and direct the user to rename in AWS.

### Cross-file consistency (`init` only)

- `state.json.organization.rootId` must equal `aws.context.json.organization.rootId`.
- The OU named `"Graveyard"` in `state.json` must have id equal to `aws.context.json.organization.graveyardOuId`.
- `state.json.identityCenter.instanceArn` and `identityStoreId` must match `aws.context.json.identityCenter`.
- Mismatch → fail with descriptive error pointing at the conflicting field; user fixes by re-running `bootstrap` or correcting AWS.

### Load-time (`aws.config.ts` → `AwsConfig`, used by `regenerate` and phase 5)

- `v.parse(awsConfigSchema, loadedDefaultExport)` runs valibot validation, including picklist checks.
- Picklist mismatch (a referenced name is not in the picklist) is the most likely error after manual edits; the error message names the field and tells the user to re-run `regenerate` if the missing name was just added in `aws.config.ts`.

## Non-destructive write behaviour

- Compute fully-rendered target content for each file in memory.
- Compare to existing files (if any).
- Outcomes:
  - all unchanged → log `no changes` and exit 0 without invoking the confirmation callback.
  - one or more changed → print per-file summary like `aws.config.ts: 12345 → 12567 bytes`, suggest `git diff aws.config.ts aws.config.types.ts` to review, then invoke confirmation callback.
- Confirmation callback returning false → exit cleanly without writing.
- Writes are atomic per file (write to temp, rename) so a partial failure cannot leave half-written files.

## Refreshing types after manual edits — option discussion

Background: the picklists in `aws.config.types.ts` encode the names actually present in the data. The moment a user adds a new OU / account / group to `aws.config.ts` by hand, the types file goes stale and IDE autocomplete starts showing TypeScript errors on references to the new entity. Resolving this without losing manual edits requires a way to rebuild types **from `aws.config.ts`**, not from `state.json`.

### Option A — defer to phase 5

In phase 3, types only update via `init` from `state.json` (which would overwrite manual edits). Phase 5 introduces the `aws.config.ts` loader (needed anyway for plan / apply) and provides type refresh as a side effect.

- Pros: smallest scope for phase 3.
- Cons: ships phase 3 with a known foot-gun. Users hitting the autocomplete-after-edit case have no clean path until phase 5 lands.

### Option B — add a dedicated `regenerate` command in phase 3 (chosen)

`regenerate` reads `aws.config.ts` via a TS loader, validates against the current `awsConfigSchema`, and re-emits `aws.config.types.ts` only. Picklists are rebuilt from the names present in the current config.

- Pros: removes the foot-gun immediately; the TS loader work is required for phase 5 anyway, so this just shifts the work earlier rather than adding net work.
- Cons: small scope creep into phase 3 (one extra command + the loader implementation + tests).

### Option C — split the picklist generator with a seam, defer the loader to phase 5

Ship the rendering function as a pure transform from a parsed `AwsConfig` to the types file. In phase 3 only call it from the state→config path (where the input comes from the in-memory model). Phase 5 plugs in the loader and the transform is reused unchanged.

- Pros: cleanest seam; phase 3 stays small.
- Cons: still leaves the autocomplete-after-edit foot-gun unresolved until phase 5.

### Decision

**Option B.** The loader is the only material extra work, and it is required for phase 5 regardless. Adding it in phase 3 unblocks the autocomplete loop the user actually wants and avoids shipping a known foot-gun. The loader lives in `src/awsConfig.ts` so phase 5 imports it without further refactoring.

## `aws.config.ts` loader

- Compile `aws.config.ts` with esbuild (bundle, ESM, target node24) to a temporary `.mjs` file written under `os.tmpdir()`.
- Dynamic `import()` that file, read `default` export.
- Validate the loaded value with `awsConfigSchema` (loaded from the current `aws.config.types.ts`).
- Clean up the temp file regardless of success / failure.
- If schema validation fails because `aws.config.types.ts` is stale (e.g. a picklist no longer contains a name that `aws.config.ts` references), the error message names the conflicting field and tells the user to re-run `regenerate`.

## `init` command flow

`init` is glue code (~30 lines), not new logic:

1. Build AWS SDK clients (Organizations, SSO Admin, Identity Store) from `--profile` / `--region`.
2. Call `runBootstrapCommand` (existing). Returns context including resolved OU ids.
3. Call `runScanCommand` (existing). Writes `state.json`.
4. Call the new `writeAwsConfigFromState` helper from `src/awsConfig.ts`:
   - read `state.json` and `aws.context.json` from disk
   - run `mapStateToAwsConfig`
   - render `aws.config.ts` and `aws.config.types.ts`
   - apply non-destructive write logic
5. Print a summary listing what each step did.

The same `overwriteConfirmation` callback is shared across the three steps so `--yes` works uniformly.

## Tests

- `src/awsConfig.test.ts`:
  - `mapStateToAwsConfig` produces expected output from a fixture state.
  - shuffled-input idempotence — sorting is stable across permutations of input arrays.
  - rejection of duplicate names (account / OU / group / user / permission set).
  - assignment grouping correctness (same `(principal, permissionSet)` accumulates accounts; distinct pairs stay separate).
  - rendered output is byte-stable across reruns.
- `src/commands/init.test.ts`:
  - sequences `runBootstrapCommand` → `runScanCommand` → `writeAwsConfigFromState` with mocked clients.
  - propagates `--yes` to all three steps.
  - failure in any step aborts the rest cleanly.
- `src/commands/regenerate.test.ts`:
  - happy path: edits a fixture `aws.config.ts`, runs the loader, re-emits types with the new picklist values.
  - validates that `aws.config.ts` itself is unchanged.
  - no-op when types file already matches: does not invoke confirmation, does not write.
  - confirmation rejected: returns false from callback → no write.

## Out of scope for phase 3

- Diff between `aws.config.ts` and `state.json` (phase 5 `plan`).
- Apply mutations (phase 5 `apply`).
- `accessRoles` representation in `aws.config.ts` (derivable; not added).
- Watcher mode for `regenerate` (future feature; tracked in `plan.md` out-of-scope section).
- Comment preservation across regenerations of `aws.config.ts` (no parser round-trip on the user-edited file beyond schema validation; comments outside the object literal survive only via the file-level header that the codegen always re-emits).
- Drift detection from AWS-side manual changes back into `aws.config.ts` (future feature).

## Implementation status (May 2026)

Phase 3 implementation is complete for the planned scope (`init`, `regenerate`, state->config transform/codegen, loader, and tests).

Completed execution checkpoints:

1. CLI contracts added for `init` and `regenerate` in `src/cli.ts`.
2. `init` orchestration implemented in `src/commands/init.ts`.
3. State/context validation, transform, deterministic sorting, and codegen implemented in `src/awsConfig.ts`.
4. `regenerate` command wiring implemented in `src/commands/regenerate.ts`.
5. TS loader implementation landed in `src/awsConfig.ts` (esbuild temp-module compile/import/cleanup path).
6. Tests added and stabilized:
   - `src/awsConfig.test.ts`
   - `src/commands/init.test.ts`
   - `src/commands/regenerate.test.ts`
7. Final verification completed:
   - `npm run test`
   - `npm run typecheck`
   - `npm run cli -- --help`

Notable implementation adjustments:

- `aws.config.ts` generation validates with `v.parse(awsConfigSchema, ...)`.
- Command path overrides were added (`runBootstrapCommand`, `runScanCommand`, `runInitCommand`, `runRegenerateCommand`) to support concurrency-safe tests using isolated temp workspaces and absolute paths.
- Build remains unbundled ESM; runtime build uses `find src -name '*.ts' ! -name '*.test.ts'` and tests are compiled separately by `build:tests`.

Pending follow-up decision:

- Re-evaluate the placeholder `__EMPTY_PICKLIST__` behavior after real-world usage of generated types.
